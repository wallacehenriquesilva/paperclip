import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyMcpOauthClients,
  companyMcpOauthSessions,
  companyMcpOauthTokens,
  companyMcpServers,
  companySecrets,
} from "@paperclipai/db";
import type {
  CompanyMcpOAuthAuthorizeResponse,
  CompanyMcpOAuthStatus,
  McpOAuthStatusValue,
} from "@paperclipai/shared";
import { parseSecretReference } from "@paperclipai/shared";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { encryptToken, decryptToken } from "./mcp-oauth-crypto.js";
import {
  discoverMcpOAuthEndpoints,
  registerDynamicClient,
} from "./mcp-oauth-discovery.js";
import type { secretService } from "./secrets.js";

type SecretService = ReturnType<typeof secretService>;

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REFRESH_LEEWAY_MS = 60 * 1000; // refresh when within 60s of expiry
const NEEDS_REAUTH_AFTER_FAILURES = 3; // surface the badge after N strikes
const DEFAULT_REDIRECT_PATH = "/api/companies/:companyId/mcp-servers/oauth/callback";

/**
 * Backoff curve in milliseconds based on consecutive refresh failures.
 * After NEEDS_REAUTH_AFTER_FAILURES strikes the status flips to needs_reauth
 * (so the UI surfaces a badge), but the heartbeat KEEPS trying with the
 * backoff schedule below — a provider blip self-heals on the next attempt
 * without operator intervention. After ~strike 5 the cadence settles at 1h
 * which is gentle on provider rate limits even for truly-revoked tokens.
 */
function refreshBackoffMs(strikes: number): number {
  if (strikes <= 0) return 0;
  if (strikes === 1) return 60_000;          // 1 min
  if (strikes === 2) return 5 * 60_000;      // 5 min
  if (strikes === 3) return 15 * 60_000;     // 15 min
  if (strikes === 4) return 30 * 60_000;     // 30 min
  return 60 * 60_000;                         // 1 h, then constant
}

export interface McpOAuthDependencies {
  secrets: Pick<SecretService, "resolveSecretValue">;
  publicBaseUrl: string | null;
  /** Override for tests; default uses node-fetch's global. */
  fetchImpl?: typeof fetch;
  /** Override now() for tests. */
  now?: () => Date;
}

export interface McpOAuthService {
  startAuthorization(
    companyId: string,
    mcpServerId: string,
    initiatedByUserId: string | null,
  ): Promise<CompanyMcpOAuthAuthorizeResponse>;
  completeAuthorization(state: string, code: string): Promise<{
    mcpServerId: string;
    companyId: string;
  }>;
  getStatus(companyId: string, mcpServerId: string): Promise<CompanyMcpOAuthStatus>;
  ensureValidAccessToken(companyId: string, mcpServerId: string): Promise<string | null>;
  revoke(companyId: string, mcpServerId: string): Promise<void>;
  buildCallbackUrl(companyId: string): string;
}

interface TokenExchangeResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function generateState(): string {
  return base64url(randomBytes(32));
}

function generateCodeVerifier(): string {
  // RFC 7636: 43-128 chars. 64 bytes → 86 chars base64url.
  return base64url(randomBytes(64));
}

function challengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function mcpOAuthService(db: Db, deps: McpOAuthDependencies): McpOAuthService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  function buildCallbackUrl(companyId: string): string {
    if (!deps.publicBaseUrl) {
      throw badRequest(
        "OAuth callback URL cannot be derived: set PAPERCLIP_AUTH_PUBLIC_BASE_URL or PAPERCLIP_PUBLIC_URL",
      );
    }
    const base = deps.publicBaseUrl.replace(/\/+$/, "");
    return `${base}/api/companies/${companyId}/mcp-servers/oauth/callback`;
  }

  async function loadServer(companyId: string, mcpServerId: string) {
    const row = await db
      .select()
      .from(companyMcpServers)
      .where(
        and(eq(companyMcpServers.id, mcpServerId), eq(companyMcpServers.companyId, companyId)),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("MCP server not found");
    return row;
  }

  async function resolveClientSecret(companyId: string, secretRef: string): Promise<string> {
    const secretKey = parseSecretReference(secretRef);
    if (!secretKey) {
      throw unprocessable(
        "oauthConfig.clientSecretRef must be a ${secret:...} reference into companySecrets",
      );
    }
    const secretRow = await db
      .select({ id: companySecrets.id, status: companySecrets.status })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, secretKey)))
      .then((rows) => rows[0] ?? null);
    if (!secretRow || secretRow.status === "deleted") {
      throw unprocessable(`OAuth clientSecretRef points to missing secret "${secretKey}"`);
    }
    return deps.secrets.resolveSecretValue(companyId, secretRow.id, "latest", {
      consumerType: "mcp_server",
      consumerId: secretRow.id,
      configPath: "oauthConfig.clientSecretRef",
    });
  }

  interface OAuthMaterial {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint: string | null;
    clientId: string;
    clientSecret: string | null;
    scopes: string[];
    usePkce: boolean;
    audience: string | null;
  }

  /**
   * Resolves OAuth endpoints + credentials for an MCP server. Handles both
   * BYO (operator pre-registered) and DCR (dynamic) configurations. For DCR,
   * runs the discovery + registration flow on first use and caches the result
   * in company_mcp_oauth_clients.
   */
  async function resolveOAuthMaterial(
    companyId: string,
    server: typeof companyMcpServers.$inferSelect,
  ): Promise<OAuthMaterial> {
    const cfg = server.oauthConfig;
    if (!cfg) throw unprocessable("This MCP server is not configured with OAuth");

    if (cfg.dynamicRegistration === true) {
      return resolveDynamicOAuthMaterial(companyId, server);
    }

    // BYO mode
    if (!cfg.clientId || !cfg.clientSecretRef || !cfg.authorizationUrl || !cfg.tokenUrl) {
      throw unprocessable(
        "OAuth config is incomplete: clientId, clientSecretRef, authorizationUrl, and tokenUrl are required unless dynamicRegistration is true",
      );
    }
    const clientSecret = await resolveClientSecret(companyId, cfg.clientSecretRef);
    return {
      authorizationEndpoint: cfg.authorizationUrl,
      tokenEndpoint: cfg.tokenUrl,
      revocationEndpoint: cfg.revocationUrl ?? null,
      clientId: cfg.clientId,
      clientSecret,
      scopes: cfg.scopes ?? [],
      usePkce: cfg.usePkce !== false,
      audience: cfg.audience ?? null,
    };
  }

  async function resolveDynamicOAuthMaterial(
    companyId: string,
    server: typeof companyMcpServers.$inferSelect,
  ): Promise<OAuthMaterial> {
    const cfg = server.oauthConfig;
    if (!cfg) throw unprocessable("OAuth config missing");
    if (!server.url) {
      throw unprocessable("Dynamic registration requires the MCP server's url");
    }

    let clientRow = await db
      .select()
      .from(companyMcpOauthClients)
      .where(eq(companyMcpOauthClients.mcpServerId, server.id))
      .then((rows) => rows[0] ?? null);

    const expired =
      clientRow?.expiresAt && clientRow.expiresAt.getTime() < now().getTime();
    if (!clientRow || expired) {
      // Discover + register
      const discovered = await discoverMcpOAuthEndpoints(server.url, { fetchImpl });
      if (!discovered.registrationEndpoint) {
        throw unprocessable(
          `Authorization server at ${discovered.authorizationServerUrl} does not support Dynamic Client Registration (no registration_endpoint advertised)`,
        );
      }
      const registration = await registerDynamicClient(
        discovered.registrationEndpoint,
        {
          redirectUris: [buildCallbackUrl(companyId)],
          clientName: `Paperclip${cfg.provider ? ` (${cfg.provider})` : ""}`,
          scopes: cfg.scopes ?? discovered.scopesSupported ?? undefined,
          tokenEndpointAuthMethod: "client_secret_basic",
        },
        { fetchImpl },
      );
      const clientExpiresAt =
        typeof registration.clientSecretExpiresAt === "number" && registration.clientSecretExpiresAt > 0
          ? new Date(registration.clientSecretExpiresAt * 1000)
          : null;
      const clientSecretCipher = registration.clientSecret ? encryptToken(registration.clientSecret) : null;

      [clientRow] = await db
        .insert(companyMcpOauthClients)
        .values({
          companyId,
          mcpServerId: server.id,
          clientId: registration.clientId,
          clientSecretCiphertext: clientSecretCipher,
          authorizationEndpoint: discovered.authorizationEndpoint,
          tokenEndpoint: discovered.tokenEndpoint,
          revocationEndpoint: discovered.revocationEndpoint,
          registrationEndpoint: discovered.registrationEndpoint,
          resourceMetadataUrl: discovered.resourceMetadataUrl,
          authorizationServerUrl: discovered.authorizationServerUrl,
          scopesSupported: discovered.scopesSupported,
          registeredAt: now(),
          expiresAt: clientExpiresAt,
          metadata: registration.metadata,
        })
        .onConflictDoUpdate({
          target: companyMcpOauthClients.mcpServerId,
          set: {
            clientId: registration.clientId,
            clientSecretCiphertext: clientSecretCipher,
            authorizationEndpoint: discovered.authorizationEndpoint,
            tokenEndpoint: discovered.tokenEndpoint,
            revocationEndpoint: discovered.revocationEndpoint,
            registrationEndpoint: discovered.registrationEndpoint,
            resourceMetadataUrl: discovered.resourceMetadataUrl,
            authorizationServerUrl: discovered.authorizationServerUrl,
            scopesSupported: discovered.scopesSupported,
            registeredAt: now(),
            expiresAt: clientExpiresAt,
            metadata: registration.metadata,
            updatedAt: now(),
          },
        })
        .returning();
      logger.info(
        { mcpServerId: server.id, provider: cfg.provider, clientId: registration.clientId },
        "MCP OAuth: dynamic client registered",
      );
    }

    if (!clientRow) throw new Error("Failed to resolve dynamic MCP OAuth client row");
    const clientSecret = clientRow.clientSecretCiphertext
      ? decryptToken(clientRow.clientSecretCiphertext)
      : null;

    return {
      authorizationEndpoint: clientRow.authorizationEndpoint,
      tokenEndpoint: clientRow.tokenEndpoint,
      revocationEndpoint: clientRow.revocationEndpoint ?? null,
      clientId: clientRow.clientId,
      clientSecret,
      scopes: cfg.scopes ?? clientRow.scopesSupported ?? [],
      usePkce: cfg.usePkce !== false,
      audience: cfg.audience ?? null,
    };
  }

  async function startAuthorization(
    companyId: string,
    mcpServerId: string,
    initiatedByUserId: string | null,
  ): Promise<CompanyMcpOAuthAuthorizeResponse> {
    const server = await loadServer(companyId, mcpServerId);
    const material = await resolveOAuthMaterial(companyId, server);

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const expiresAt = new Date(now().getTime() + SESSION_TTL_MS);

    await db.insert(companyMcpOauthSessions).values({
      companyId,
      mcpServerId,
      state,
      codeVerifier,
      initiatedByUserId,
      status: "pending",
      expiresAt,
    });

    const url = new URL(material.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", material.clientId);
    url.searchParams.set("redirect_uri", buildCallbackUrl(companyId));
    if (material.scopes.length > 0) {
      url.searchParams.set("scope", material.scopes.join(" "));
    }
    url.searchParams.set("state", state);
    if (material.audience) url.searchParams.set("audience", material.audience);
    if (material.usePkce) {
      url.searchParams.set("code_challenge", challengeFromVerifier(codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
    }

    return { authorizationUrl: url.toString(), state, expiresAt };
  }

  async function exchangeCode(args: {
    material: OAuthMaterial;
    code: string;
    codeVerifier: string;
    companyId: string;
  }): Promise<TokenExchangeResponse> {
    const { material, code, codeVerifier, companyId } = args;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: buildCallbackUrl(companyId),
      client_id: material.clientId,
    });
    if (material.clientSecret) body.set("client_secret", material.clientSecret);
    if (material.usePkce) body.set("code_verifier", codeVerifier);

    const res = await fetchImpl(material.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw unprocessable(`Token exchange failed (${res.status}): ${text.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as TokenExchangeResponse;
    } catch {
      throw unprocessable(`Token exchange returned non-JSON body: ${text.slice(0, 500)}`);
    }
  }

  async function completeAuthorization(state: string, code: string) {
    const session = await db
      .select()
      .from(companyMcpOauthSessions)
      .where(eq(companyMcpOauthSessions.state, state))
      .then((rows) => rows[0] ?? null);
    if (!session) throw notFound("OAuth session not found");
    if (session.status !== "pending") {
      throw unprocessable(`OAuth session is ${session.status}; cannot complete`);
    }
    if (session.expiresAt.getTime() < now().getTime()) {
      await db
        .update(companyMcpOauthSessions)
        .set({ status: "expired", failureReason: "ttl_exceeded" })
        .where(eq(companyMcpOauthSessions.id, session.id));
      throw unprocessable("OAuth session expired");
    }

    const server = await loadServer(session.companyId, session.mcpServerId);
    if (!server.oauthConfig) {
      throw unprocessable("MCP server is no longer configured with OAuth");
    }
    const material = await resolveOAuthMaterial(session.companyId, server);

    const token = await exchangeCode({
      material,
      code,
      codeVerifier: session.codeVerifier,
      companyId: session.companyId,
    });

    if (!token.access_token) {
      throw unprocessable("Token exchange response missing access_token");
    }

    const expiresAt =
      typeof token.expires_in === "number"
        ? new Date(now().getTime() + token.expires_in * 1000)
        : null;
    const accessCipher = encryptToken(token.access_token);
    const refreshCipher = token.refresh_token ? encryptToken(token.refresh_token) : null;

    await db
      .insert(companyMcpOauthTokens)
      .values({
        companyId: session.companyId,
        mcpServerId: session.mcpServerId,
        accessTokenCiphertext: accessCipher,
        refreshTokenCiphertext: refreshCipher,
        tokenType: token.token_type ?? "Bearer",
        scope: token.scope ?? null,
        expiresAt,
        lastRefreshedAt: now(),
        refreshFailureCount: 0,
        status: "active",
      })
      .onConflictDoUpdate({
        target: companyMcpOauthTokens.mcpServerId,
        set: {
          accessTokenCiphertext: accessCipher,
          refreshTokenCiphertext: refreshCipher,
          tokenType: token.token_type ?? "Bearer",
          scope: token.scope ?? null,
          expiresAt,
          lastRefreshedAt: now(),
          refreshFailureCount: 0,
          status: "active",
          updatedAt: now(),
        },
      });

    await db
      .update(companyMcpOauthSessions)
      .set({ status: "completed" })
      .where(eq(companyMcpOauthSessions.id, session.id));

    return { mcpServerId: session.mcpServerId, companyId: session.companyId };
  }

  async function refreshToken(args: {
    companyId: string;
    mcpServerId: string;
  }): Promise<string | null> {
    const { companyId, mcpServerId } = args;
    const server = await loadServer(companyId, mcpServerId);
    if (!server.oauthConfig) return null;

    const row = await db
      .select()
      .from(companyMcpOauthTokens)
      .where(eq(companyMcpOauthTokens.mcpServerId, mcpServerId))
      .then((r) => r[0] ?? null);
    if (!row || !row.refreshTokenCiphertext) return null;
    if (row.status === "revoked") return null;

    const material = await resolveOAuthMaterial(companyId, server);
    const refreshToken = decryptToken(row.refreshTokenCiphertext);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: material.clientId,
    });
    if (material.clientSecret) body.set("client_secret", material.clientSecret);
    try {
      const res = await fetchImpl(material.tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
      const text = await res.text();
      if (!res.ok) {
        const newFailureCount = row.refreshFailureCount + 1;
        // After N consecutive failures we surface a needs_reauth badge so the
        // operator can re-authorize manually if they want — but the heartbeat
        // keeps trying with refreshBackoffMs(), so a provider blip self-heals
        // without intervention. lastRefreshedAt is updated as the "last attempt"
        // anchor for the next backoff calculation.
        const newStatus: McpOAuthStatusValue =
          newFailureCount >= NEEDS_REAUTH_AFTER_FAILURES ? "needs_reauth" : "active";
        await db
          .update(companyMcpOauthTokens)
          .set({
            refreshFailureCount: newFailureCount,
            status: newStatus,
            lastRefreshedAt: now(),
            updatedAt: now(),
          })
          .where(eq(companyMcpOauthTokens.mcpServerId, mcpServerId));
        logger.warn(
          { mcpServerId, status: res.status, body: text.slice(0, 300), newFailureCount, nextRetryInMs: refreshBackoffMs(newFailureCount) },
          "MCP OAuth token refresh failed",
        );
        return null;
      }
      const parsed = JSON.parse(text) as TokenExchangeResponse;
      if (!parsed.access_token) return null;
      const expiresAt =
        typeof parsed.expires_in === "number"
          ? new Date(now().getTime() + parsed.expires_in * 1000)
          : null;
      const accessCipher = encryptToken(parsed.access_token);
      const refreshCipher = parsed.refresh_token ? encryptToken(parsed.refresh_token) : row.refreshTokenCiphertext;
      await db
        .update(companyMcpOauthTokens)
        .set({
          accessTokenCiphertext: accessCipher,
          refreshTokenCiphertext: refreshCipher,
          tokenType: parsed.token_type ?? row.tokenType,
          scope: parsed.scope ?? row.scope,
          expiresAt,
          lastRefreshedAt: now(),
          refreshFailureCount: 0,
          status: "active",
          updatedAt: now(),
        })
        .where(eq(companyMcpOauthTokens.mcpServerId, mcpServerId));
      return parsed.access_token;
    } catch (err) {
      logger.error({ err, mcpServerId }, "MCP OAuth token refresh threw");
      return null;
    }
  }

  async function ensureValidAccessToken(
    companyId: string,
    mcpServerId: string,
  ): Promise<string | null> {
    const row = await db
      .select()
      .from(companyMcpOauthTokens)
      .where(
        and(
          eq(companyMcpOauthTokens.mcpServerId, mcpServerId),
          eq(companyMcpOauthTokens.companyId, companyId),
        ),
      )
      .then((r) => r[0] ?? null);
    if (!row) return null;
    if (row.status === "revoked") return null;

    const tokenExpired =
      row.expiresAt !== null && row.expiresAt.getTime() <= now().getTime();
    const needsRefresh =
      row.expiresAt !== null && row.expiresAt.getTime() - now().getTime() < REFRESH_LEEWAY_MS;

    if (needsRefresh && row.refreshTokenCiphertext) {
      // Respect backoff after consecutive failures so a truly-revoked token
      // doesn't hammer the provider's OAuth endpoint at every heartbeat.
      const lastAttempt = row.lastRefreshedAt ?? row.createdAt;
      const backoff = refreshBackoffMs(row.refreshFailureCount);
      const nextAllowedAt = lastAttempt.getTime() + backoff;
      const allowedNow = backoff === 0 || nextAllowedAt <= now().getTime();
      if (allowedNow) {
        const refreshed = await refreshToken({ companyId, mcpServerId });
        if (refreshed) return refreshed;
      }
      // Refresh wasn't tried (backoff) or failed: fall through to the
      // existing token. If that token is also expired, the caller skips
      // this MCP from materialization without crashing the run.
      if (tokenExpired) return null;
    }

    return decryptToken(row.accessTokenCiphertext);
  }

  async function getStatus(
    companyId: string,
    mcpServerId: string,
  ): Promise<CompanyMcpOAuthStatus> {
    const server = await loadServer(companyId, mcpServerId);
    const provider = server.oauthConfig?.provider ?? null;
    if (!server.oauthConfig) {
      return {
        mcpServerId,
        status: "not_configured",
        provider,
        scope: null,
        expiresAt: null,
        lastRefreshedAt: null,
        refreshFailureCount: 0,
      };
    }
    const row = await db
      .select()
      .from(companyMcpOauthTokens)
      .where(eq(companyMcpOauthTokens.mcpServerId, mcpServerId))
      .then((r) => r[0] ?? null);
    if (!row) {
      return {
        mcpServerId,
        status: "needs_authorization",
        provider,
        scope: null,
        expiresAt: null,
        lastRefreshedAt: null,
        refreshFailureCount: 0,
      };
    }
    let status: McpOAuthStatusValue = row.status as McpOAuthStatusValue;
    if (status === "active" && row.expiresAt && row.expiresAt.getTime() < now().getTime()) {
      status = row.refreshTokenCiphertext ? "expired" : "needs_reauth";
    }
    return {
      mcpServerId,
      status,
      provider,
      scope: row.scope,
      expiresAt: row.expiresAt,
      lastRefreshedAt: row.lastRefreshedAt,
      refreshFailureCount: row.refreshFailureCount,
    };
  }

  async function revoke(companyId: string, mcpServerId: string): Promise<void> {
    const server = await loadServer(companyId, mcpServerId);
    const row = await db
      .select()
      .from(companyMcpOauthTokens)
      .where(eq(companyMcpOauthTokens.mcpServerId, mcpServerId))
      .then((r) => r[0] ?? null);

    if (row && server.oauthConfig) {
      try {
        const material = await resolveOAuthMaterial(companyId, server);
        if (material.revocationEndpoint) {
          const accessToken = decryptToken(row.accessTokenCiphertext);
          const body = new URLSearchParams({
            token: accessToken,
            client_id: material.clientId,
          });
          if (material.clientSecret) body.set("client_secret", material.clientSecret);
          await fetchImpl(material.revocationEndpoint, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
            },
            body,
          }).catch((err) => {
            logger.warn({ err, mcpServerId }, "MCP OAuth revocation call failed (token deleted locally)");
          });
        }
      } catch (err) {
        logger.warn({ err, mcpServerId }, "Could not resolve OAuth material for revocation; deleting local token only");
      }
    }

    if (row) {
      await db
        .delete(companyMcpOauthTokens)
        .where(eq(companyMcpOauthTokens.mcpServerId, mcpServerId));
    }
  }

  // Maintenance: lazily clean expired sessions. Called by the refresher tick in P5,
  // exposed here so tests/integration can also call it explicitly.
  async function pruneExpiredSessions(): Promise<number> {
    const cutoff = new Date(now().getTime() - SESSION_TTL_MS);
    const deleted = await db
      .delete(companyMcpOauthSessions)
      .where(lt(companyMcpOauthSessions.expiresAt, cutoff))
      .returning({ id: companyMcpOauthSessions.id });
    return deleted.length;
  }

  return {
    startAuthorization,
    completeAuthorization,
    ensureValidAccessToken,
    getStatus,
    revoke,
    buildCallbackUrl,
    // exposed for tests / refresher
    ...({ pruneExpiredSessions } as object),
  } as McpOAuthService;
}

export const __defaultRedirectPathForTests = DEFAULT_REDIRECT_PATH;
