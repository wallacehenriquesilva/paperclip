import { logger } from "../middleware/logger.js";
import { unprocessable } from "../errors.js";

/**
 * Discovers OAuth metadata for an MCP server that supports OAuth 2.1 +
 * RFC 9728 (OAuth 2.0 Protected Resource Metadata).
 *
 * Flow:
 *   1. GET {mcpUrlOrigin}/.well-known/oauth-protected-resource
 *      → returns the authorization server(s) that protect the resource.
 *   2. GET {authServer}/.well-known/oauth-authorization-server
 *      → returns the OAuth endpoint catalog including `registration_endpoint`
 *        for RFC 7591 Dynamic Client Registration.
 *
 * Per RFC 9728 the resource metadata may also live at
 * `{mcpUrl}/.well-known/oauth-protected-resource` (suffixed to the full path),
 * so we try both shapes.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  metadata_url: string;
}

export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  metadata_url: string;
}

export interface DiscoveredOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  scopesSupported: string[] | null;
  resourceMetadataUrl: string;
  authorizationServerUrl: string;
}

export interface DiscoverOptions {
  fetchImpl?: typeof fetch;
  /** Tolerate non-JSON / non-200 responses on .well-known? Default false. */
  strict?: boolean;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    return { status: res.status, body: null };
  }
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return {
      status: res.status,
      body: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null,
    };
  } catch {
    return { status: res.status, body: null };
  }
}

/**
 * Build candidate `.well-known/oauth-protected-resource` URLs to try.
 *
 * Per RFC 9728 §3, the canonical location is at the resource's origin root.
 * Many MCP servers in the wild also expose it at `{full-url}/.well-known/...`
 * so we try both.
 */
function buildResourceMetadataCandidates(mcpUrl: string): string[] {
  const parsed = new URL(mcpUrl);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const candidates = new Set<string>();
  candidates.add(`${origin}/.well-known/oauth-protected-resource`);

  // If the MCP url has a path (e.g. /mcp, /v1/mcp), try at that path too.
  const trimmedPath = parsed.pathname.replace(/\/$/, "");
  if (trimmedPath && trimmedPath !== "/") {
    candidates.add(`${origin}${trimmedPath}/.well-known/oauth-protected-resource`);
  }
  return Array.from(candidates);
}

function buildAuthServerMetadataCandidates(authServer: string): string[] {
  const parsed = new URL(authServer);
  const origin = `${parsed.protocol}//${parsed.host}`;
  const candidates = new Set<string>();
  candidates.add(`${origin}/.well-known/oauth-authorization-server`);
  // Also try OpenID Connect discovery as a fallback (some providers expose both).
  candidates.add(`${origin}/.well-known/openid-configuration`);
  const trimmedPath = parsed.pathname.replace(/\/$/, "");
  if (trimmedPath && trimmedPath !== "/") {
    candidates.add(`${origin}${trimmedPath}/.well-known/oauth-authorization-server`);
    candidates.add(`${origin}${trimmedPath}/.well-known/openid-configuration`);
  }
  return Array.from(candidates);
}

export async function discoverProtectedResourceMetadata(
  mcpUrl: string,
  opts: DiscoverOptions = {},
): Promise<ProtectedResourceMetadata> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const candidates = buildResourceMetadataCandidates(mcpUrl);
  for (const candidate of candidates) {
    try {
      const { status, body } = await fetchJson(candidate, fetchImpl);
      if (status !== 200 || !body) continue;
      const resource = typeof body.resource === "string" ? body.resource : mcpUrl;
      const authServers = Array.isArray(body.authorization_servers)
        ? body.authorization_servers.filter((v): v is string => typeof v === "string")
        : [];
      if (authServers.length === 0) continue;
      return {
        resource,
        authorization_servers: authServers,
        scopes_supported: Array.isArray(body.scopes_supported)
          ? body.scopes_supported.filter((v): v is string => typeof v === "string")
          : undefined,
        bearer_methods_supported: Array.isArray(body.bearer_methods_supported)
          ? body.bearer_methods_supported.filter((v): v is string => typeof v === "string")
          : undefined,
        resource_documentation: typeof body.resource_documentation === "string"
          ? body.resource_documentation
          : undefined,
        metadata_url: candidate,
      };
    } catch (err) {
      logger.debug(
        { err, candidate },
        "MCP OAuth discovery: protected-resource candidate failed",
      );
    }
  }
  throw unprocessable(
    `Could not discover oauth-protected-resource metadata for ${mcpUrl} (tried ${candidates.length} candidates)`,
  );
}

export async function discoverAuthorizationServerMetadata(
  authServerUrl: string,
  opts: DiscoverOptions = {},
): Promise<AuthorizationServerMetadata> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const candidates = buildAuthServerMetadataCandidates(authServerUrl);
  for (const candidate of candidates) {
    try {
      const { status, body } = await fetchJson(candidate, fetchImpl);
      if (status !== 200 || !body) continue;
      const authEndpoint = typeof body.authorization_endpoint === "string"
        ? body.authorization_endpoint
        : null;
      const tokenEndpoint = typeof body.token_endpoint === "string"
        ? body.token_endpoint
        : null;
      if (!authEndpoint || !tokenEndpoint) continue;
      return {
        issuer: typeof body.issuer === "string" ? body.issuer : undefined,
        authorization_endpoint: authEndpoint,
        token_endpoint: tokenEndpoint,
        registration_endpoint: typeof body.registration_endpoint === "string"
          ? body.registration_endpoint
          : undefined,
        revocation_endpoint: typeof body.revocation_endpoint === "string"
          ? body.revocation_endpoint
          : undefined,
        scopes_supported: Array.isArray(body.scopes_supported)
          ? body.scopes_supported.filter((v): v is string => typeof v === "string")
          : undefined,
        grant_types_supported: Array.isArray(body.grant_types_supported)
          ? body.grant_types_supported.filter((v): v is string => typeof v === "string")
          : undefined,
        code_challenge_methods_supported: Array.isArray(body.code_challenge_methods_supported)
          ? body.code_challenge_methods_supported.filter((v): v is string => typeof v === "string")
          : undefined,
        metadata_url: candidate,
      };
    } catch (err) {
      logger.debug(
        { err, candidate },
        "MCP OAuth discovery: auth-server candidate failed",
      );
    }
  }
  throw unprocessable(
    `Could not discover oauth-authorization-server metadata for ${authServerUrl} (tried ${candidates.length} candidates)`,
  );
}

export async function discoverMcpOAuthEndpoints(
  mcpUrl: string,
  opts: DiscoverOptions = {},
): Promise<DiscoveredOAuthEndpoints> {
  const resource = await discoverProtectedResourceMetadata(mcpUrl, opts);
  const firstAuthServer = resource.authorization_servers?.[0];
  if (!firstAuthServer) {
    throw unprocessable(
      `Protected resource metadata at ${resource.metadata_url} did not list any authorization_servers`,
    );
  }
  const authServer = await discoverAuthorizationServerMetadata(firstAuthServer, opts);
  return {
    authorizationEndpoint: authServer.authorization_endpoint,
    tokenEndpoint: authServer.token_endpoint,
    registrationEndpoint: authServer.registration_endpoint ?? null,
    revocationEndpoint: authServer.revocation_endpoint ?? null,
    scopesSupported: authServer.scopes_supported ?? resource.scopes_supported ?? null,
    resourceMetadataUrl: resource.metadata_url,
    authorizationServerUrl: authServer.metadata_url,
  };
}

export interface DynamicClientRegistrationRequest {
  redirectUris: string[];
  clientName: string;
  scopes?: string[];
  tokenEndpointAuthMethod?:
    | "client_secret_basic"
    | "client_secret_post"
    | "none";
}

export interface DynamicClientRegistrationResponse {
  clientId: string;
  clientSecret: string | null;
  clientSecretExpiresAt: number | null;
  scopesGranted: string[] | null;
  tokenEndpointAuthMethod: string | null;
  metadata: Record<string, unknown>;
}

export async function registerDynamicClient(
  registrationEndpoint: string,
  request: DynamicClientRegistrationRequest,
  opts: DiscoverOptions = {},
): Promise<DynamicClientRegistrationResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = {
    redirect_uris: request.redirectUris,
    client_name: request.clientName,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: request.tokenEndpointAuthMethod ?? "client_secret_basic",
    scope: request.scopes && request.scopes.length > 0 ? request.scopes.join(" ") : undefined,
    application_type: "web",
  };
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw unprocessable(
      `Dynamic client registration failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw unprocessable(`Dynamic client registration returned non-JSON: ${text.slice(0, 500)}`);
  }
  const clientId = typeof parsed.client_id === "string" ? parsed.client_id : null;
  if (!clientId) {
    throw unprocessable(
      "Dynamic client registration response missing required client_id",
    );
  }
  return {
    clientId,
    clientSecret: typeof parsed.client_secret === "string" ? parsed.client_secret : null,
    clientSecretExpiresAt: typeof parsed.client_secret_expires_at === "number"
      ? parsed.client_secret_expires_at
      : null,
    scopesGranted: typeof parsed.scope === "string"
      ? parsed.scope.split(/\s+/).filter(Boolean)
      : null,
    tokenEndpointAuthMethod: typeof parsed.token_endpoint_auth_method === "string"
      ? parsed.token_endpoint_auth_method
      : null,
    metadata: parsed,
  };
}
