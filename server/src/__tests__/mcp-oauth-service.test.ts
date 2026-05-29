import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companyMcpOauthClients,
  companyMcpOauthSessions,
  companyMcpOauthTokens,
  companyMcpServers,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpOAuthService } from "../services/mcp-oauth.ts";

// Configure the master key BEFORE any encrypt/decrypt happens.
process.env.PAPERCLIP_SECRETS_MASTER_KEY =
  process.env.PAPERCLIP_SECRETS_MASTER_KEY ||
  Buffer.alloc(32, 7).toString("base64");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping mcp-oauth-service tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("mcpOAuthService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let mockSecrets!: { resolveSecretValue: ReturnType<typeof vi.fn> };
  let mockFetch!: ReturnType<typeof vi.fn>;
  let mockNow!: ReturnType<typeof vi.fn>;
  let nowDate = new Date("2026-05-28T10:00:00.000Z");

  function svc() {
    return mcpOAuthService(db, {
      secrets: mockSecrets as any,
      publicBaseUrl: "https://paperclip.test",
      fetchImpl: mockFetch as any,
      now: mockNow as any,
    });
  }

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  async function seedClientSecret(companyId: string, key = "figma-oauth-secret") {
    // Only the lookup row is needed — resolveSecretValue is mocked.
    const id = randomUUID();
    await db.insert(companySecrets).values({
      id,
      companyId,
      key,
      name: key,
      provider: "local_encrypted",
      status: "active",
      managedMode: "paperclip_managed",
      latestVersion: 1,
    });
    return id;
  }

  async function seedOAuthServer(companyId: string, opts: { withRevocationUrl?: boolean } = {}) {
    const id = randomUUID();
    await db.insert(companyMcpServers).values({
      id,
      companyId,
      key: "figma",
      name: "Figma",
      transport: "streamable_http",
      command: "",
      args: [],
      url: "https://mcp.figma.com",
      oauthConfig: {
        provider: "figma",
        clientId: "client-abc",
        clientSecretRef: "${secret:figma-oauth-secret}",
        authorizationUrl: "https://www.figma.com/oauth",
        tokenUrl: "https://api.figma.com/v1/oauth/token",
        revocationUrl: opts.withRevocationUrl
          ? "https://api.figma.com/v1/oauth/revoke"
          : undefined,
        scopes: ["files:read"],
        usePkce: true,
      } as any,
      envTemplate: {},
      enabled: true,
    });
    return id;
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("mcp-oauth-service");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  beforeEach(() => {
    mockSecrets = { resolveSecretValue: vi.fn().mockResolvedValue("shh-client-secret") };
    mockFetch = vi.fn();
    nowDate = new Date("2026-05-28T10:00:00.000Z");
    mockNow = vi.fn(() => nowDate);
  });

  afterEach(async () => {
    await db.delete(companyMcpOauthTokens);
    await db.delete(companyMcpOauthClients);
    await db.delete(companyMcpOauthSessions);
    await db.delete(companyMcpServers);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  it("startAuthorization issues a PKCE-enabled URL and persists the session", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);

    const result = await svc().startAuthorization(companyId, mcpId, "user-1");

    expect(result.authorizationUrl).toContain("https://www.figma.com/oauth?");
    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `https://paperclip.test/api/companies/${companyId}/mcp-servers/oauth/callback`,
    );
    expect(url.searchParams.get("scope")).toBe("files:read");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await db
      .select()
      .from(companyMcpOauthSessions)
      .where(eq(companyMcpOauthSessions.state, result.state));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("completeAuthorization exchanges code, stores encrypted tokens, marks session completed", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);

    const start = await svc().startAuthorization(companyId, mcpId, "user-1");

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "ya29.access",
          refresh_token: "1//refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "files:read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await svc().completeAuthorization(start.state, "auth-code-xyz");
    expect(result).toEqual({ mcpServerId: mcpId, companyId });

    // Verify token exchange body shape
    const [tokenUrl, init] = mockFetch.mock.calls[0]!;
    expect(tokenUrl).toBe("https://api.figma.com/v1/oauth/token");
    const sentBody = new URLSearchParams(init.body as string);
    expect(sentBody.get("grant_type")).toBe("authorization_code");
    expect(sentBody.get("code")).toBe("auth-code-xyz");
    expect(sentBody.get("client_id")).toBe("client-abc");
    expect(sentBody.get("client_secret")).toBe("shh-client-secret");
    expect(sentBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/);

    // Token row persisted, encrypted
    const tokens = await db
      .select()
      .from(companyMcpOauthTokens)
      .where(eq(companyMcpOauthTokens.mcpServerId, mcpId));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.accessTokenCiphertext).not.toContain("ya29.access");
    expect(tokens[0]!.refreshTokenCiphertext).not.toContain("1//refresh");
    expect(tokens[0]!.scope).toBe("files:read");
    expect(tokens[0]!.status).toBe("active");
    expect(tokens[0]!.expiresAt!.getTime()).toBeGreaterThan(nowDate.getTime());

    // Session marked completed
    const sessions = await db
      .select()
      .from(companyMcpOauthSessions)
      .where(eq(companyMcpOauthSessions.state, start.state));
    expect(sessions[0]!.status).toBe("completed");
  });

  it("ensureValidAccessToken returns the stored token when not expired", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const start = await svc().startAuthorization(companyId, mcpId, null);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "tok-1", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      ),
    );
    await svc().completeAuthorization(start.state, "code");

    const token = await svc().ensureValidAccessToken(companyId, mcpId);
    expect(token).toBe("tok-1");
  });

  it("ensureValidAccessToken refreshes when within leeway", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const start = await svc().startAuthorization(companyId, mcpId, null);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "old",
          refresh_token: "refresh-1",
          expires_in: 30, // < 60s leeway
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    await svc().completeAuthorization(start.state, "code");

    // Refresh response
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "fresh",
          refresh_token: "refresh-2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    const token = await svc().ensureValidAccessToken(companyId, mcpId);
    expect(token).toBe("fresh");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, refreshInit] = mockFetch.mock.calls[1]!;
    const refreshBody = new URLSearchParams(refreshInit.body as string);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh-1");
  });

  it("marks token needs_reauth after 3 consecutive refresh failures", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const start = await svc().startAuthorization(companyId, mcpId, null);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "old",
          refresh_token: "r",
          expires_in: 10,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    await svc().completeAuthorization(start.state, "code");

    // 3 refresh failures spaced past the backoff window. Each call attempts
    // a refresh (because the token is within the 60s leeway from issuance).
    // Refresh fails → failure count increments. After 3 strikes the status
    // flips to needs_reauth but the heartbeat keeps trying with backoff.
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));
      await svc().ensureValidAccessToken(companyId, mcpId);
      // Advance past the backoff window so the next attempt is allowed.
      nowDate = new Date(nowDate.getTime() + 2 * 60 * 60 * 1000);
    }

    const status = await svc().getStatus(companyId, mcpId);
    expect(status.status).toBe("needs_reauth");
    expect(status.refreshFailureCount).toBe(3);
  });

  it("respects refresh backoff: a second call within the window does NOT re-hit the provider", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const start = await svc().startAuthorization(companyId, mcpId, null);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "old",
          refresh_token: "r",
          expires_in: 10,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    await svc().completeAuthorization(start.state, "code");

    // First refresh fails → failureCount=1, backoff window of 60s starts.
    mockFetch.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));
    await svc().ensureValidAccessToken(companyId, mcpId);

    // Second call 30s later (still inside backoff) → no provider call.
    nowDate = new Date(nowDate.getTime() + 30 * 1000);
    mockFetch.mockClear();
    await svc().ensureValidAccessToken(companyId, mcpId);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("self-heals from needs_reauth when the provider eventually responds OK", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const start = await svc().startAuthorization(companyId, mcpId, null);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "old",
          refresh_token: "r",
          expires_in: 10,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    await svc().completeAuthorization(start.state, "code");

    // Push status to needs_reauth via 3 spaced failures.
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(new Response("invalid_grant", { status: 400 }));
      await svc().ensureValidAccessToken(companyId, mcpId);
      nowDate = new Date(nowDate.getTime() + 2 * 60 * 60 * 1000);
    }
    expect((await svc().getStatus(companyId, mcpId)).status).toBe("needs_reauth");

    // Provider now responds OK (blip resolved). The next call past backoff
    // refreshes the token, resets the counter, and flips status back to active.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "fresh-after-blip",
          refresh_token: "r2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );
    const recovered = await svc().ensureValidAccessToken(companyId, mcpId);
    expect(recovered).toBe("fresh-after-blip");

    const status = await svc().getStatus(companyId, mcpId);
    expect(status.status).toBe("active");
    expect(status.refreshFailureCount).toBe(0);
  });

  it("getStatus reports not_configured when oauthConfig is null", async () => {
    const companyId = await seedCompany();
    const id = randomUUID();
    await db.insert(companyMcpServers).values({
      id,
      companyId,
      key: "stdio-only",
      name: "Stdio",
      transport: "stdio",
      command: "npx",
      args: ["-y", "x"],
      envTemplate: {},
      enabled: true,
    });
    const status = await svc().getStatus(companyId, id);
    expect(status.status).toBe("not_configured");
  });

  it("getStatus reports needs_authorization when no token row exists", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const status = await svc().getStatus(companyId, mcpId);
    expect(status.status).toBe("needs_authorization");
    expect(status.provider).toBe("figma");
  });

  it("revoke deletes the token row and calls revocationUrl when configured", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId, { withRevocationUrl: true });
    const start = await svc().startAuthorization(companyId, mcpId, null);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      ),
    );
    await svc().completeAuthorization(start.state, "code");

    mockFetch.mockResolvedValueOnce(new Response("", { status: 200 }));

    await svc().revoke(companyId, mcpId);

    const after = await db
      .select()
      .from(companyMcpOauthTokens)
      .where(eq(companyMcpOauthTokens.mcpServerId, mcpId));
    expect(after).toHaveLength(0);

    // Verify revocation endpoint was called
    const revokeCall = mockFetch.mock.calls.find(
      (call) => call[0] === "https://api.figma.com/v1/oauth/revoke",
    );
    expect(revokeCall).toBeDefined();
  });

  it("completeAuthorization rejects expired sessions", async () => {
    const companyId = await seedCompany();
    await seedClientSecret(companyId);
    const mcpId = await seedOAuthServer(companyId);
    const start = await svc().startAuthorization(companyId, mcpId, null);
    // Advance clock beyond 10 min TTL
    nowDate = new Date(nowDate.getTime() + 11 * 60 * 1000);
    await expect(svc().completeAuthorization(start.state, "code")).rejects.toThrow(/expired/i);
  });

  it("completeAuthorization rejects unknown state", async () => {
    await expect(svc().completeAuthorization("not-a-real-state", "code")).rejects.toThrow(/not found/i);
  });

  describe("dynamic client registration", () => {
    async function seedDcrServer(companyId: string) {
      const id = randomUUID();
      await db.insert(companyMcpServers).values({
        id,
        companyId,
        key: "notion-dcr",
        name: "Notion (DCR)",
        transport: "streamable_http",
        command: "",
        args: [],
        url: "https://mcp.notion.test/mcp",
        oauthConfig: {
          provider: "notion",
          dynamicRegistration: true,
          usePkce: true,
        } as any,
        envTemplate: {},
        enabled: true,
      });
      return id;
    }

    /**
     * Mocks the full discovery → DCR → token exchange chain that fires on the
     * first authorize attempt. Returns the spy so individual tests can assert
     * which endpoints were hit.
     */
    function mockDcrFetchChain(overrides?: {
      tokenEndpoint?: string;
      grantedClientId?: string;
      accessToken?: string;
    }) {
      const tokenEndpoint = overrides?.tokenEndpoint ?? "https://auth.notion.test/oauth/token";
      const grantedClientId = overrides?.grantedClientId ?? "dcr-client-xyz";
      const accessToken = overrides?.accessToken ?? "ya29.dcr-access";

      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return new Response(
            JSON.stringify({
              resource: "https://mcp.notion.test/mcp",
              authorization_servers: ["https://auth.notion.test"],
              scopes_supported: ["mcp.read", "mcp.write"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return new Response(
            JSON.stringify({
              issuer: "https://auth.notion.test",
              authorization_endpoint: "https://auth.notion.test/oauth/authorize",
              token_endpoint: tokenEndpoint,
              registration_endpoint: "https://auth.notion.test/oauth/register",
              revocation_endpoint: "https://auth.notion.test/oauth/revoke",
              scopes_supported: ["mcp.read", "mcp.write"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === "https://auth.notion.test/oauth/register") {
          return new Response(
            JSON.stringify({
              client_id: grantedClientId,
              client_secret: "dcr-secret-shh",
              token_endpoint_auth_method: "client_secret_basic",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        if (url === tokenEndpoint) {
          const body = new URLSearchParams(String((init as RequestInit).body));
          return new Response(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: "dcr-refresh-1",
              token_type: "Bearer",
              expires_in: 3600,
              scope: body.get("scope") ?? "mcp.read",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      });
    }

    it("discovers endpoints and registers a client on first authorize", async () => {
      const companyId = await seedCompany();
      const mcpId = await seedDcrServer(companyId);
      mockDcrFetchChain();

      const start = await svc().startAuthorization(companyId, mcpId, null);

      // Authorize URL was built from the discovered authorization_endpoint
      // and the dynamically-registered client_id.
      const url = new URL(start.authorizationUrl);
      expect(url.origin + url.pathname).toBe("https://auth.notion.test/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("dcr-client-xyz");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");

      // Client row was persisted with the discovered endpoints + encrypted secret.
      const clientRow = await db
        .select()
        .from(companyMcpOauthClients)
        .where(eq(companyMcpOauthClients.mcpServerId, mcpId))
        .then((rows) => rows[0]);
      expect(clientRow).toMatchObject({
        clientId: "dcr-client-xyz",
        authorizationEndpoint: "https://auth.notion.test/oauth/authorize",
        tokenEndpoint: "https://auth.notion.test/oauth/token",
        registrationEndpoint: "https://auth.notion.test/oauth/register",
      });
      expect(clientRow!.clientSecretCiphertext).not.toContain("dcr-secret-shh");
    });

    it("re-uses the registered client on subsequent authorizes (no second registration POST)", async () => {
      const companyId = await seedCompany();
      const mcpId = await seedDcrServer(companyId);
      mockDcrFetchChain();

      await svc().startAuthorization(companyId, mcpId, null);
      mockFetch.mockClear();
      mockDcrFetchChain(); // reset mocks; if registration is called again the test will catch it

      await svc().startAuthorization(companyId, mcpId, null);

      const registrationCalls = mockFetch.mock.calls.filter(
        (call) => call[0] === "https://auth.notion.test/oauth/register",
      );
      expect(registrationCalls).toHaveLength(0);

      const discoveryCalls = mockFetch.mock.calls.filter((call) =>
        String(call[0]).includes("/.well-known/"),
      );
      expect(discoveryCalls).toHaveLength(0);
    });

    it("completes the authorize flow end-to-end with DCR-issued credentials", async () => {
      const companyId = await seedCompany();
      const mcpId = await seedDcrServer(companyId);
      mockDcrFetchChain();

      const start = await svc().startAuthorization(companyId, mcpId, null);
      await svc().completeAuthorization(start.state, "auth-code-from-notion");

      const tokens = await db
        .select()
        .from(companyMcpOauthTokens)
        .where(eq(companyMcpOauthTokens.mcpServerId, mcpId));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.status).toBe("active");

      const access = await svc().ensureValidAccessToken(companyId, mcpId);
      expect(access).toBe("ya29.dcr-access");
    });

    it("fails clearly when the authorization server does not advertise a registration_endpoint", async () => {
      const companyId = await seedCompany();
      const mcpId = await seedDcrServer(companyId);
      mockFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return new Response(
            JSON.stringify({
              resource: "https://mcp.notion.test/mcp",
              authorization_servers: ["https://auth.notion.test"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return new Response(
            JSON.stringify({
              authorization_endpoint: "https://auth.notion.test/oauth/authorize",
              token_endpoint: "https://auth.notion.test/oauth/token",
              // no registration_endpoint
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("nope", { status: 404 });
      });

      await expect(svc().startAuthorization(companyId, mcpId, null)).rejects.toThrow(
        /does not support Dynamic Client Registration/,
      );
    });
  });
});
