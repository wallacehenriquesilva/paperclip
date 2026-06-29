export type BoardApiKeyStatus = "active" | "revoked" | "expired";

export interface BoardApiKeyOwner {
  id: string;
  name: string | null;
  email: string | null;
}

/**
 * A board API key as shown in the instance-admin key manager. The plaintext
 * token is never returned here — only a non-secret masked preview built from
 * the stored suffix. The full token is shown once, at creation time.
 */
export interface BoardApiKeyListItem {
  id: string;
  name: string;
  /** Masked token preview, e.g. `pcp_board_••••1a2b`. */
  maskedKey: string;
  status: BoardApiKeyStatus;
  owner: BoardApiKeyOwner | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned once, immediately after a key is created. */
export interface BoardApiKeyCreated {
  id: string;
  name: string;
  /** Full plaintext token. Shown once and never retrievable again. */
  token: string;
  maskedKey: string;
  expiresAt: string | null;
  createdAt: string;
}
