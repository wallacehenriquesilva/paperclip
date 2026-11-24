import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import type { AuthOidcConfig } from "../auth/oidc-config.js";
import type { Config } from "../config.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SSO flow tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BASE = "http://localhost:3100";
const CLIENT_ID = "paperclip-test-client";

type FakeIdp = {
  url: string;
  server: Server;
  nextClaims: Record<string, unknown>;
  privateKey: CryptoKey;
};

async function startFakeIdp(): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const idp = { nextClaims: {} } as FakeIdp;
  idp.privateKey = privateKey;
  idp.server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: idp.url,
        authorization_endpoint: `${idp.url}/authorize`,
        token_endpoint: `${idp.url}/token`,
        userinfo_endpoint: `${idp.url}/userinfo`,
        jwks_uri: `${idp.url}/jwks`,
      });
    }
    if (req.url === "/jwks") return json(200, { keys: [jwk] });
    if (req.url === "/token" && req.method === "POST") {
      const idToken = await new SignJWT(idp.nextClaims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(idp.url)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(idp.privateKey);
      return json(200, { access_token: "at", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => idp.server.listen(0, "127.0.0.1", resolve));
  idp.url = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;
  return idp;
}

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

describeEmbeddedPostgres("SSO (OIDC) sign-in flow", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let idp!: FakeIdp;
  const originalSecret = process.env.BETTER_AUTH_SECRET;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "paperclip-sso-test-secret-0123456789";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-auth-oidc-flow-");
    db = createDb(tempDb.connectionString);
    idp = await startFakeIdp();
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authSessions);
    await db.delete(authAccounts);
    await db.delete(authVerifications);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
    await new Promise<void>((resolve) => idp?.server.close(() => resolve()));
    await tempDb?.cleanup();
  });

  function makeAuth(overrides: Partial<AuthOidcConfig> = {}, extra: Partial<Config> = {}) {
    const oidc: AuthOidcConfig = {
      providerId: "oidc",
      label: "Google",
      discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
      clientId: CLIENT_ID,
      clientSecret: "client-secret",
      scopes: ["openid", "email", "profile"],
      expectedIssuer: undefined,
      requiredHostedDomain: "example.com",
      autoProvision: true,
      defaultCompanyId: undefined,
      defaultRole: "viewer",
      ...overrides,
    };
    const config = {
      deploymentMode: "authenticated",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: BASE,
      authDisableSignUp: false,
      authAllowedEmailDomains: ["example.com"],
      authOidc: oidc,
      authPasswordLogin: "enabled",
      authBreakGlassEmails: [],
      ...extra,
    } as unknown as Config;
    return createBetterAuthInstance(db as any, config, [BASE]);
  }

  async function ssoSignIn(auth: ReturnType<typeof makeAuth>, claims: Record<string, unknown>) {
    const start = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/oauth2`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ providerId: "oidc", callbackURL: "/dashboard", errorCallbackURL: "/auth" }),
      }),
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorizeUrl = new URL(url);
    const state = authorizeUrl.searchParams.get("state")!;

    idp.nextClaims = claims;
    const callback = await auth.handler(
      new Request(`${BASE}/api/auth/oauth2/callback/oidc?code=test-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: cookieHeader(start) },
      }),
    );
    return { authorizeUrl, callback };
  }

  const claims = (email: string, extra: Record<string, unknown> = {}) => ({
    sub: `sub-${email}`,
    email,
    email_verified: true,
    hd: "example.com",
    name: "Test User",
    ...extra,
  });

  it("requests the organization domain with PKCE and select_account", async () => {
    const auth = makeAuth();
    const { authorizeUrl } = await ssoSignIn(auth, claims("x@example.com"));
    expect(authorizeUrl.origin).toBe(idp.url);
    expect(authorizeUrl.searchParams.get("hd")).toBe("example.com");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/oauth2/callback/oidc`);
  });

  it("links SSO to an existing password user instead of creating a new one", async () => {
    const auth = makeAuth();
    await auth.api.signUpEmail({
      body: { name: "Existing", email: "existing@example.com", password: "a-strong-password" },
    });
    const [existing] = await db.select().from(authUsers).where(eq(authUsers.email, "existing@example.com"));

    const { callback } = await ssoSignIn(auth, claims("Existing@Example.com"));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
    expect(cookieHeader(callback)).toMatch(/session_token=/);

    const users = await db.select().from(authUsers);
    expect(users).toHaveLength(1);
    const accounts = await db.select().from(authAccounts).where(eq(authAccounts.userId, existing!.id));
    expect(accounts.map((a) => a.providerId).sort()).toEqual(["credential", "oidc"]);
    // Name edited in Paperclip is not overwritten by the IdP profile.
    expect(users[0]!.name).toBe("Existing");
  });

  it("creates a new organization user on first sign-in and joins the default company", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme Corp",
      issuePrefix: "CAZ",
      requireBoardApprovalForNewAgents: false,
    });
    const auth = makeAuth({ defaultCompanyId: companyId, defaultRole: "operator" });

    const { callback } = await ssoSignIn(auth, claims("new.person@example.com"));
    expect(callback.headers.get("location")).toBe("/dashboard");

    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, "new.person@example.com"));
    expect(user).toBeTruthy();
    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, user!.id)));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ membershipRole: "operator", status: "active", principalType: "user" });
  });

  it("rejects accounts outside the organization domain without creating anything", async () => {
    const auth = makeAuth();
    const { callback } = await ssoSignIn(auth, claims("someone@gmail.com", { hd: undefined }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toMatch(/^\/auth\?error=/);
    expect(cookieHeader(callback)).not.toMatch(/session_token=[^;]+/);
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("rejects a non-matching hosted domain even if the email looks right", async () => {
    const auth = makeAuth();
    const { callback } = await ssoSignIn(auth, claims("x@example.com", { hd: "other.com" }));
    expect(callback.headers.get("location")).toMatch(/^\/auth\?error=/);
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("does not create unknown users when auto-provision is off", async () => {
    const auth = makeAuth({ autoProvision: false });
    const { callback } = await ssoSignIn(auth, claims("unknown@example.com"));
    expect(callback.headers.get("location")).toBe("/auth?error=signup_disabled");
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("blocks password sign-in when disabled but keeps break-glass working", async () => {
    const auth = makeAuth({}, {
      authPasswordLogin: "disabled",
      authBreakGlassEmails: ["admin@example.com"],
    } as Partial<Config>);
    await auth.api.signUpEmail({ body: { name: "Admin", email: "admin@example.com", password: "a-strong-password" } });
    await auth.api.signUpEmail({ body: { name: "User", email: "user@example.com", password: "a-strong-password" } });

    const signIn = (email: string) =>
      auth.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ email, password: "a-strong-password" }),
        }),
      );

    const blocked = await signIn("user@example.com");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "PASSWORD_LOGIN_DISABLED" });

    const breakGlass = await signIn("admin@example.com");
    expect(breakGlass.status).toBe(200);
  });
});
