export const AGENT_GITHUB_IDENTITY_STATUSES = [
  "connected",
  "missing_token",
  "incomplete",
  "not_configured",
] as const;

export type AgentGithubIdentityStatus = (typeof AGENT_GITHUB_IDENTITY_STATUSES)[number];

/**
 * Persisted shape on `agents.metadata.github`. All fields are optional so an
 * operator can configure partial identities (e.g. token only, used by Layer C
 * inheritance via the company default).
 */
export interface AgentGithubIdentity {
  username?: string;
  userEmail?: string;
  userName?: string;
  tokenSecretId?: string;
  /** Optional reserved field for future commit signing — not yet honored. */
  signingKeySecretId?: string;
}

/** UI / API view: includes status + secret display label (never raw value). */
export interface AgentGithubIdentityView {
  status: AgentGithubIdentityStatus;
  username: string | null;
  userEmail: string | null;
  userName: string | null;
  tokenSecretId: string | null;
  tokenSecretName: string | null;
  /** Bound at adapter_config.env.GH_TOKEN — confirms the secret reached runtime. */
  boundAtAdapterConfig: boolean;
}

/** Input payload for set/update. Empty strings collapse to undefined. */
export interface AgentGithubIdentityInput {
  username?: string | null;
  userEmail?: string | null;
  userName?: string | null;
  tokenSecretId?: string | null;
}

export function normalizeAgentGithubIdentityInput(
  raw: AgentGithubIdentityInput | null | undefined,
): AgentGithubIdentity | null {
  if (!raw) return null;
  const normalized: AgentGithubIdentity = {};
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const userEmail = typeof raw.userEmail === "string" ? raw.userEmail.trim() : "";
  const userName = typeof raw.userName === "string" ? raw.userName.trim() : "";
  const tokenSecretId = typeof raw.tokenSecretId === "string" ? raw.tokenSecretId.trim() : "";
  if (username) normalized.username = username;
  if (userEmail) normalized.userEmail = userEmail;
  if (userName) normalized.userName = userName;
  if (tokenSecretId) normalized.tokenSecretId = tokenSecretId;
  if (Object.keys(normalized).length === 0) return null;
  return normalized;
}

export function deriveAgentGithubIdentityStatus(
  identity: AgentGithubIdentity | null,
  boundAtAdapterConfig: boolean,
): AgentGithubIdentityStatus {
  if (!identity) return "not_configured";
  if (!identity.tokenSecretId) return "missing_token";
  if (!identity.userEmail || !identity.userName) return "incomplete";
  if (!boundAtAdapterConfig) return "missing_token";
  return "connected";
}

export function readAgentGithubIdentity(
  metadata: Record<string, unknown> | null | undefined,
): AgentGithubIdentity | null {
  if (!metadata || typeof metadata !== "object") return null;
  const github = (metadata as Record<string, unknown>).github;
  if (!github || typeof github !== "object") return null;
  const block = github as Record<string, unknown>;
  const result: AgentGithubIdentity = {};
  if (typeof block.username === "string" && block.username.length > 0) {
    result.username = block.username;
  }
  if (typeof block.userEmail === "string" && block.userEmail.length > 0) {
    result.userEmail = block.userEmail;
  }
  if (typeof block.userName === "string" && block.userName.length > 0) {
    result.userName = block.userName;
  }
  if (typeof block.tokenSecretId === "string" && block.tokenSecretId.length > 0) {
    result.tokenSecretId = block.tokenSecretId;
  }
  if (typeof block.signingKeySecretId === "string" && block.signingKeySecretId.length > 0) {
    result.signingKeySecretId = block.signingKeySecretId;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function mergeAgentGithubIdentityIntoMetadata(
  metadata: Record<string, unknown> | null | undefined,
  identity: AgentGithubIdentity | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
  if (!identity) {
    delete base.github;
    return base;
  }
  base.github = identity;
  return base;
}
