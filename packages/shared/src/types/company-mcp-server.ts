export type McpServerTransport = "stdio";

export interface CompanyMcpServer {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  transport: McpServerTransport;
  command: string;
  args: string[];
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
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyMcpServerCreateRequest {
  key?: string | null;
  name: string;
  description?: string | null;
  transport?: McpServerTransport;
  command: string;
  args?: string[];
  env?: Record<string, McpServerEnvValueInput>;
  enabled?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface CompanyMcpServerUpdateRequest {
  name?: string;
  description?: string | null;
  command?: string;
  args?: string[];
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
}
