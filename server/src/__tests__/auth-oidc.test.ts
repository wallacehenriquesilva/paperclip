import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { parseAuthSsoSettings, type AuthOidcConfig } from "../auth/oidc-config.js";
import {
  assertPasswordSignInAllowed,
  buildOidcProviderConfig,
  createOidcUserInfoResolver,
  isOidcCallbackContext,
} from "../auth/oidc.js";

const ISSUER = "https://accounts.google.com";
const CLIENT_ID = "client-123.apps.googleusercontent.com";

const baseOidc: AuthOidcConfig = {
  providerId: "oidc",
  label: "Google",
  discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
  clientId: CLIENT_ID,
  clientSecret: "secret",
  scopes: ["openid", "email", "profile"],
  expectedIssuer: undefined,
  requiredHostedDomain: "example.com",
  autoProvision: true,
  defaultCompanyId: undefined,
  defaultRole: "viewer",
};

async function createSigner() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { issuer?: string; audience?: string; exp?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .sign(privateKey);
  return { keySet, sign };
}

async function createResolver(oidc: Partial<AuthOidcConfig> = {}, allowed: string[] = ["example.com"]) {
  const signer = await createSigner();
  const resolver = createOidcUserInfoResolver({ ...baseOidc, ...oidc }, allowed, {
    fetchDiscovery: async () => ({ issuer: ISSUER, jwks_uri: "https://example.invalid/jwks" }),
    createKeySet: () => signer.keySet,
  });
  return { resolver, sign: signer.sign };
}

const validClaims = {
  sub: "google-sub-1",
  email: "Jane.Doe@Example.com",
  email_verified: true,
  hd: "example.com",
  name: "Jane",
  picture: "https://lh3.googleusercontent.com/a/x",
};

describe("OIDC id_token verification", () => {
  it("accepts a valid organization token and normalizes the email", async () => {
    const { resolver, sign } = await createResolver();
    await expect(resolver({ idToken: await sign(validClaims) })).resolves.toEqual({
      id: "google-sub-1",
      email: "jane.doe@example.com",
      name: "Jane",
      image: "https://lh3.googleusercontent.com/a/x",
      emailVerified: true,
    });
  });

  it.each([
    ["wrong issuer", validClaims, { issuer: "https://evil.example" }],
    ["wrong audience", validClaims, { audience: "other-client" }],
    ["expired", validClaims, { exp: "-1m" }],
    ["hosted domain mismatch", { ...validClaims, hd: "gmail.com" }, {}],
    ["missing hosted domain", { ...validClaims, hd: undefined }, {}],
    ["personal account", { ...validClaims, email: "someone@gmail.com", hd: "example.com" }, {}],
    ["unverified email", { ...validClaims, email_verified: false }, {}],
    ["missing email", { ...validClaims, email: undefined }, {}],
  ] as const)("rejects %s", async (_label, claims, opts) => {
    const { resolver, sign } = await createResolver();
    await expect(resolver({ idToken: await sign(claims as Record<string, unknown>, opts) })).resolves.toBeNull();
  });

  it("rejects a token signed by a different key", async () => {
    const { resolver } = await createResolver();
    const other = await createSigner();
    await expect(resolver({ idToken: await other.sign(validClaims) })).resolves.toBeNull();
  });

  it("rejects a missing id_token", async () => {
    const { resolver } = await createResolver();
    await expect(resolver({})).resolves.toBeNull();
  });

  it("does not require hd when no hosted domain is configured", async () => {
    const { resolver, sign } = await createResolver({ requiredHostedDomain: undefined });
    const result = await resolver({ idToken: await sign({ ...validClaims, hd: undefined }) });
    expect(result?.email).toBe("jane.doe@example.com");
  });

  it("falls back to the email local part when the name claim is missing", async () => {
    const { resolver, sign } = await createResolver();
    const result = await resolver({ idToken: await sign({ ...validClaims, name: undefined }) });
    expect(result?.name).toBe("jane.doe");
  });
});

describe("buildOidcProviderConfig", () => {
  it("sends hd, uses PKCE and blocks sign-up when auto-provision is off", () => {
    const cfg = buildOidcProviderConfig({ ...baseOidc, autoProvision: false }, ["example.com"]);
    expect(cfg).toMatchObject({
      providerId: "oidc",
      pkce: true,
      prompt: "select_account",
      authorizationUrlParams: { hd: "example.com" },
      disableSignUp: true,
      overrideUserInfo: false,
    });
    expect(typeof cfg.getUserInfo).toBe("function");
  });

  it("omits hd when not configured", () => {
    const cfg = buildOidcProviderConfig({ ...baseOidc, requiredHostedDomain: undefined }, []);
    expect(cfg.authorizationUrlParams).toBeUndefined();
    expect(cfg.disableSignUp).toBe(false);
  });
});

describe("password sign-in gate", () => {
  const breakGlassEmails = ["admin@example.com"];

  it("allows everything when password login is enabled", () => {
    expect(() =>
      assertPasswordSignInAllowed({ path: "/sign-in/email", body: { email: "a@b.com" }, passwordLogin: "enabled", breakGlassEmails }),
    ).not.toThrow();
  });

  it("blocks password sign-in when disabled", () => {
    expect(() =>
      assertPasswordSignInAllowed({ path: "/sign-in/email", body: { email: "a@example.com" }, passwordLogin: "disabled", breakGlassEmails }),
    ).toThrow(/Password sign-in is disabled/);
  });

  it("lets break-glass accounts through case-insensitively", () => {
    expect(() =>
      assertPasswordSignInAllowed({ path: "/sign-in/email", body: { email: " Admin@Example.com " }, passwordLogin: "disabled", breakGlassEmails }),
    ).not.toThrow();
  });

  it("does not touch other routes", () => {
    expect(() =>
      assertPasswordSignInAllowed({ path: "/sign-in/oauth2", body: {}, passwordLogin: "disabled", breakGlassEmails }),
    ).not.toThrow();
  });
});

describe("isOidcCallbackContext", () => {
  it("detects the provider callback", () => {
    expect(isOidcCallbackContext({ path: "/oauth2/callback/:providerId", params: { providerId: "oidc" } }, "oidc")).toBe(true);
    expect(isOidcCallbackContext({ path: "/sign-up/email" }, "oidc")).toBe(false);
    expect(isOidcCallbackContext(null, "oidc")).toBe(false);
  });
});

describe("parseAuthSsoSettings", () => {
  it("keeps today's behavior when nothing is set", () => {
    expect(parseAuthSsoSettings({})).toEqual({
      authOidc: null,
      authPasswordLogin: "enabled",
      authBreakGlassEmails: [],
      authSessionTtlHours: undefined,
    });
  });

  it("parses a Google Workspace setup with defaults", () => {
    const settings = parseAuthSsoSettings({
      PAPERCLIP_AUTH_OIDC_ENABLED: "true",
      PAPERCLIP_AUTH_OIDC_CLIENT_ID: "id",
      PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "secret",
      PAPERCLIP_AUTH_OIDC_REQUIRED_HD: "@Example.com",
      PAPERCLIP_AUTH_PASSWORD_LOGIN: "disabled",
      PAPERCLIP_AUTH_BREAK_GLASS_EMAILS: "Admin@example.com, ops@example.com",
      PAPERCLIP_AUTH_SESSION_TTL_HOURS: "72",
    });
    expect(settings.authOidc).toMatchObject({
      providerId: "oidc",
      label: "Google",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      scopes: ["openid", "email", "profile"],
      requiredHostedDomain: "example.com",
      autoProvision: true,
      defaultRole: "viewer",
    });
    expect(settings.authPasswordLogin).toBe("disabled");
    expect(settings.authBreakGlassEmails).toEqual(["admin@example.com", "ops@example.com"]);
    expect(settings.authSessionTtlHours).toBe(72);
  });

  it.each([
    [{ PAPERCLIP_AUTH_OIDC_ENABLED: "true" }, /CLIENT_ID and PAPERCLIP_AUTH_OIDC_CLIENT_SECRET/],
    [{ PAPERCLIP_AUTH_PASSWORD_LOGIN: "disabled" }, /requires PAPERCLIP_AUTH_OIDC_ENABLED/],
    [{ PAPERCLIP_AUTH_PASSWORD_LOGIN: "maybe" }, /must be "enabled" or "disabled"/],
    [
      { PAPERCLIP_AUTH_OIDC_ENABLED: "true", PAPERCLIP_AUTH_OIDC_CLIENT_ID: "a", PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "b", PAPERCLIP_AUTH_OIDC_PROVIDER_ID: "Bad Id!" },
      /PROVIDER_ID/,
    ],
    [
      { PAPERCLIP_AUTH_OIDC_ENABLED: "true", PAPERCLIP_AUTH_OIDC_CLIENT_ID: "a", PAPERCLIP_AUTH_OIDC_CLIENT_SECRET: "b", PAPERCLIP_AUTH_OIDC_DEFAULT_ROLE: "god" },
      /DEFAULT_ROLE/,
    ],
    [{ PAPERCLIP_AUTH_SESSION_TTL_HOURS: "0" }, /SESSION_TTL_HOURS/],
  ])("fails fast on invalid config %#", (env, message) => {
    expect(() => parseAuthSsoSettings(env)).toThrow(message);
  });
});
