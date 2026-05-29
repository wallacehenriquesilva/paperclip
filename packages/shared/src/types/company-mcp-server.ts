export type McpServerTransport = "stdio" | "streamable_http" | "sse";

export interface McpOAuthConfigInput {
  provider: string;
  dynamicRegistration?: boolean;
  clientId?: string;
  clientSecretRef?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string | null;
  scopes?: string[];
  audience?: string | null;
  usePkce?: boolean;
  redirectPath?: string | null;
}

export interface CompanyMcpServer {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  transport: McpServerTransport;
  command: string;
  args: string[];
  url: string | null;
  oauthConfig: McpOAuthConfigInput | null;
  envTemplate: Record<string, string>;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyMcpServerListItem {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  transport: McpServerTransport;
  enabled: boolean;
  envKeys: string[];
  hasSecretReferences: boolean;
  hasOAuth: boolean;
  oauthStatus: McpOAuthStatusValue | null;
  createdAt: Date;
  updatedAt: Date;
}

export type McpOAuthStatusValue =
  | "not_configured"
  | "needs_authorization"
  | "active"
  | "connected"
  | "expired"
  | "needs_reauth"
  | "revoked";

export interface CompanyMcpServerCreateRequest {
  key?: string | null;
  name: string;
  description?: string | null;
  transport?: McpServerTransport;
  command?: string;
  args?: string[];
  url?: string | null;
  oauthConfig?: McpOAuthConfigInput | null;
  env?: Record<string, McpServerEnvValueInput>;
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyMcpServerUpdateRequest {
  name?: string;
  description?: string | null;
  transport?: McpServerTransport;
  command?: string;
  args?: string[];
  url?: string | null;
  oauthConfig?: McpOAuthConfigInput | null;
  env?: Record<string, McpServerEnvValueInput>;
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export type McpServerEnvValueInput =
  | { kind: "literal"; value: string }
  | { kind: "secret"; secretKey: string }
  | { kind: "secret_inline"; value: string };

export interface CompanyMcpServerTestRequest {
  timeoutMs?: number;
}

export interface CompanyMcpServerTestResult {
  ok: boolean;
  durationMs: number;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  capabilities: Record<string, unknown>;
  tools: Array<{ name: string; description: string | null }>;
  resources: Array<{ uri: string; name: string | null }>;
  warnings: string[];
}

export interface ResolvedMcpServer {
  id: string;
  key: string;
  name: string;
  transport: McpServerTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
}

export interface CompanyMcpOAuthStatus {
  mcpServerId: string;
  status: McpOAuthStatusValue;
  provider: string | null;
  scope: string | null;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
  refreshFailureCount: number;
}

export interface CompanyMcpOAuthAuthorizeResponse {
  authorizationUrl: string;
  state: string;
  expiresAt: Date;
}
