# MCP OAuth Support — HTTP/SSE transports + OAuth 2.0 login flow

**Status:** Draft — pending approval
**Author:** Wallace Silva
**Created:** 2026-05-28
**Scope:** Enable MCPs that require OAuth login (Figma, Notion, Slack, GitHub, Linear, etc.) by adding HTTP/SSE transports and a full OAuth 2.0 + PKCE flow on top of the existing V1 stdio MCP support.

---

## 1. Goals

- Support MCPs over **Streamable HTTP** and **SSE** (in addition to existing stdio).
- Support **OAuth 2.0 + PKCE** for MCP servers that require user login (Figma, Notion, Slack, etc.).
- **BYO OAuth credentials**: operator registers each app with the provider (Figma/Slack/Notion) and pastes `client_id` + `client_secret` into Paperclip. No Paperclip-hosted shared clients.
- **Per-company tokens**: operator authorizes once; all agents in the company share the workspace identity. Consistent with the existing per-company secret model.
- **Adapter coverage**: Claude, Codex, Cursor, Gemini, Opencode — all adapters that currently stub MCP support.
- **Token lifecycle**: automatic refresh before expiry; explicit revoke; needs-reauth state when refresh fails.
- **Backwards compatible**: existing stdio MCPs keep working unchanged.

## 2. Non-goals

- Per-user or per-agent tokens (V1 of OAuth support is per-company only).
- Paperclip-hosted OAuth clients (operator brings their own app registrations).
- New transports beyond `stdio`, `streamable_http`, `sse`.
- OAuth 1.0 / API-key-only providers (those already work via stdio + static secrets).
- Multi-tenant per-installation isolation of OAuth clients (the company is the boundary).

## 3. User stories

1. **Operator** wants to install the Figma MCP in their company:
   - Registers a Figma OAuth app at https://www.figma.com/developers
   - Sets redirect URI to `https://<paperclip-host>/api/companies/<company-id>/mcp-servers/oauth/callback`
   - Pastes `client_id` and `client_secret` into Paperclip's MCP server form
   - Clicks "Authorize with Figma" → opens popup → logs in → popup closes
   - Status flips to "Connected"; the MCP is now usable
2. **CEO agent** with the Figma MCP enabled in `desiredMcpServers` runs a task:
   - Heartbeat materializes the MCP config with the current valid access token injected
   - Agent uses Figma MCP tools transparently
3. **Operator** revokes access:
   - Clicks "Disconnect" → token deleted locally + revoked at provider
   - MCP marked as `needs_reauth`; agents skip it until re-authorized

## 4. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Operator UI                                                          │
│    CompanyMcpServers page                                             │
│      ├─ List + create MCP (transport: stdio | streamable_http | sse) │
│      └─ "Authorize with <provider>" button                            │
└────────────┬──────────────────────────────────────────────────┬──────┘
             │ POST /authorize                                  │
             ▼                                                  │ popup callback
┌──────────────────────────────────────────────────────────┐    │
│  Server                                                   │    │
│    routes/company-mcp-servers-oauth.ts                   │    │
│      POST /:id/oauth/authorize  → returns auth URL+state │    │
│      GET  /oauth/callback       → exchanges code         │◄───┘
│      POST /:id/oauth/revoke     → revoke + delete token  │
│      GET  /:id/oauth/status     → connected | expired... │
│                                                           │
│    services/mcp-oauth.ts                                  │
│      generateAuthUrl()        PKCE S256, state, scopes   │
│      exchangeCodeForToken()                              │
│      refreshAccessToken()                                │
│      revokeToken()                                       │
│                                                           │
│    services/company-mcp-servers.ts (extended)             │
│      materializeForAdapter()  ← injects current token    │
└────────────┬─────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────┐
│  PostgreSQL                                               │
│    company_mcp_servers (extended)                         │
│      + url, oauth_config (client_id, scopes, urls, ...)  │
│    company_mcp_oauth_sessions (new)                       │
│      state, code_verifier, status, ttl                   │
│    company_mcp_oauth_tokens (new)                         │
│      access_token_enc, refresh_token_enc, expires_at,    │
│      scope, last_refreshed_at                            │
└──────────────────────────────────────────────────────────┘
             ▲
             │ scheduled refresh
             │
┌──────────────────────────────────────────────────────────┐
│  Background job (existing heartbeat scheduler infra)      │
│    services/mcp-oauth-refresher.ts                        │
│      refresh tokens expiring within next 5 minutes        │
│      mark as needs_reauth if refresh fails                │
└──────────────────────────────────────────────────────────┘

             Agent run:
             1. heartbeatService reads agent.runtimeConfig.desiredMcpServers
             2. companyMcpServerService.resolveRuntimeConfig() includes:
                  - stdio servers: env vars + command (existing)
                  - http/sse servers: url + headers (new), with Authorization: Bearer <token>
             3. Adapter materializer writes per-adapter config file:
                  - Claude: .mcp.json with { type: "http", url, headers }
                  - Cursor: .cursor/mcp.json equivalent
                  - Codex: .codex.toml HTTP-style entry
                  - Gemini, Opencode: per-adapter formats
```

## 5. Schema changes

### 5.1 Extend `MCP_SERVER_TRANSPORTS`

`packages/shared/src/validators/company-mcp-server.ts`:
```ts
export const MCP_SERVER_TRANSPORTS = ["stdio", "streamable_http", "sse"] as const;
```

### 5.2 Extend `company_mcp_servers` table

`packages/db/src/schema/company_mcp_servers.ts` — add columns:

```ts
url: text("url"),                              // HTTP/SSE server URL (null for stdio)
oauthConfig: jsonb("oauth_config")             // null for non-OAuth servers
  .$type<McpOAuthConfig>(),
```

`McpOAuthConfig` shape (in `packages/shared/src/types/`):
```ts
interface McpOAuthConfig {
  provider: string;              // "figma" | "notion" | "slack" | "github" | "custom"
  clientId: string;              // operator-provided
  clientSecretRef: string;       // ${secret:...} reference into companySecrets
  authorizationUrl: string;      // e.g. https://www.figma.com/oauth
  tokenUrl: string;              // e.g. https://api.figma.com/v1/oauth/token
  revocationUrl?: string;        // optional
  scopes: string[];
  audience?: string;             // some providers (Auth0-style) need it
  usePkce: boolean;              // default true
  redirectPath?: string;         // override of default callback path (rarely needed)
}
```

### 5.3 New table `company_mcp_oauth_sessions`

Short-lived (10 min TTL) — tracks an in-flight authorize attempt to validate the callback.

```ts
export const companyMcpOauthSessions = pgTable("company_mcp_oauth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  mcpServerId: uuid("mcp_server_id").notNull()
    .references(() => companyMcpServers.id, { onDelete: "cascade" }),
  state: text("state").notNull().unique(),               // random opaque token
  codeVerifier: text("code_verifier").notNull(),         // PKCE verifier (encrypted)
  initiatedByUserId: text("initiated_by_user_id"),       // for audit only
  status: text("status").notNull().default("pending"),   // pending | completed | failed | expired
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => ({
  stateIdx: uniqueIndex("mcp_oauth_sessions_state_idx").on(table.state),
}));
```

### 5.4 New table `company_mcp_oauth_tokens`

One row per MCP server (1:1 with `company_mcp_servers` when OAuth-enabled).

```ts
export const companyMcpOauthTokens = pgTable("company_mcp_oauth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  mcpServerId: uuid("mcp_server_id").notNull().unique()
    .references(() => companyMcpServers.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  tokenType: text("token_type").notNull().default("Bearer"),
  scope: text("scope"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
  status: text("status").notNull().default("active"),  // active | needs_reauth | revoked
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Encryption:** reuse the existing `companySecrets` envelope encryption (KMS or local key based on `PAPERCLIP_ENCRYPTION_KEY`). Extract the encryption helpers from `secret.service.ts` into a shared `crypto/envelope.ts` if not already shared.

### 5.5 Migration

`packages/db/migrations/<next-num>-mcp-oauth.sql`:
- `ALTER TABLE company_mcp_servers ADD COLUMN url text, ADD COLUMN oauth_config jsonb`
- Create `company_mcp_oauth_sessions`
- Create `company_mcp_oauth_tokens`
- Backfill: nothing — all existing rows are stdio, no OAuth.

## 6. Backend implementation

### 6.1 New routes — `server/src/routes/company-mcp-servers-oauth.ts`

```
POST  /companies/:companyId/mcp-servers/:id/oauth/authorize
       → 200 { authorizationUrl, state, expiresAt }
       Creates a session row, returns the URL the UI opens in a popup.

GET   /companies/:companyId/mcp-servers/oauth/callback?code=...&state=...
       → redirects to a static HTML page that postMessages the result
         to opener and closes the popup.
       Server: validates state, exchanges code for tokens, stores tokens.

POST  /companies/:companyId/mcp-servers/:id/oauth/revoke
       → 204. Calls revocationUrl if configured, deletes local token row.

GET   /companies/:companyId/mcp-servers/:id/oauth/status
       → 200 { status: "connected" | "needs_authorization" | "expired" | "needs_reauth" | "revoked",
              expiresAt, scope, lastRefreshedAt }
```

### 6.2 New service — `server/src/services/mcp-oauth.ts`

```ts
interface McpOAuthService {
  startAuthorization(companyId, mcpServerId, initiatedByUserId): Promise<{
    authorizationUrl: string;
    state: string;
    expiresAt: Date;
  }>;

  completeAuthorization(state, code): Promise<{
    mcpServerId: string;
    companyId: string;
  }>;

  getStatus(companyId, mcpServerId): Promise<OAuthStatus>;

  // Returns a valid access token, refreshing if expired.
  // Called by companyMcpServerService.resolveRuntimeConfig at materialization time.
  ensureValidAccessToken(companyId, mcpServerId): Promise<string>;

  revoke(companyId, mcpServerId): Promise<void>;
}
```

Implementation notes:
- **PKCE S256 mandatory** unless `oauth_config.usePkce === false`.
- `state` is a 32-byte random hex; stored, validated, single-use.
- Token exchange uses `fetch` against `oauth_config.tokenUrl`.
- Refresh happens on demand inside `ensureValidAccessToken` when `expires_at - now() < 60s`.
- On refresh failure (HTTP 4xx from provider): increment `refresh_failure_count`, after 3 strikes set `status = "needs_reauth"`.

### 6.3 Extend `companyMcpServerService.resolveRuntimeConfig`

`server/src/services/company-mcp-servers.ts:579` (approx) currently resolves `${secret:...}` for env vars. Extend it to:
- For `transport in ("streamable_http", "sse")`:
  - Call `mcpOauthService.ensureValidAccessToken(companyId, mcpServerId)`
  - If status is `needs_reauth` or no token → **skip the server** with a warning logged (don't fail the run, just exclude this MCP from the agent's config)
  - Otherwise add `Authorization: Bearer <token>` header
- For `transport === "stdio"`: existing behavior unchanged.

### 6.4 Background refresh job

`server/src/services/mcp-oauth-refresher.ts`:
- Scheduled via existing scheduler infra (`HEARTBEAT_SCHEDULER_*` style env vars)
- Default interval: 60s
- Query: tokens where `status = 'active' AND expires_at - now() < 5 minutes`
- Refresh in parallel with concurrency limit (e.g. 5)
- Activity log entry per refresh: `mcp.token_refreshed` (success) or `mcp.token_refresh_failed`

### 6.5 Activity log entries

New action types:
- `mcp.oauth.authorize_initiated`
- `mcp.oauth.authorize_completed`
- `mcp.oauth.authorize_failed`
- `mcp.oauth.token_refreshed`
- `mcp.oauth.token_refresh_failed`
- `mcp.oauth.revoked`
- `mcp.oauth.needs_reauth`

## 7. Frontend implementation

### 7.1 MCP server form changes

`ui/src/pages/CompanyMcpServers.tsx` (or wherever the form lives) — add:
- Transport selector now includes `streamable_http`, `sse`
- When transport ≠ `stdio`: show `url` field
- New collapsible "OAuth" section:
  - Toggle "Requires OAuth"
  - When on, show: provider, clientId, clientSecretRef (secret picker), authorizationUrl, tokenUrl, revocationUrl, scopes (chip input)
  - Show **callback URL** the user must register with the provider:
    ```
    https://<paperclip-host>/api/companies/<companyId>/mcp-servers/oauth/callback
    ```
    With a copy button.

### 7.2 Authorize button + status badge

In the MCP server detail panel:
- Status badge: `Not authorized` (gray) / `Connected` (green, with scope and expiry) / `Expired` (yellow) / `Needs re-auth` (red)
- Button:
  - If `Not authorized`: **"Authorize with <provider>"** → calls `POST /authorize`, opens `authorizationUrl` in a popup
  - If `Connected`: **"Disconnect"** → calls `POST /revoke`
  - If `Needs re-auth`: **"Re-authorize"** → same as Authorize

### 7.3 OAuth callback page

`server/src/public/oauth-callback.html` — minimal static page that:
1. Receives the result from the callback route (via query string or already-rendered template variables)
2. `window.opener.postMessage({ paperclipOAuth: { status, mcpServerId } }, "*")`
3. `window.close()`

The opener (board UI) listens for the message, refetches the status, updates the badge.

### 7.4 No catalog of providers in V1

User decision: pure BYO, no shipped catalog. Operator types all OAuth URLs/scopes manually. We document a short "starter recipes" page in `docs/guides/board-operator/mcp-oauth-recipes.md` with copy-paste configs for the top 5 providers (Figma, Notion, Slack, GitHub, Linear). A future Phase can promote that into a runtime catalog.

## 8. Adapter materialization

`packages/adapter-utils/src/mcp-bundle.ts` — extend the materializer for each adapter:

| Adapter | File | HTTP/SSE format |
|---|---|---|
| claude-local | `.mcp.json` | `{ "type": "http", "url": "...", "headers": { "Authorization": "Bearer ..." } }` |
| cursor-local | `.cursor/mcp.json` | `{ "url": "...", "headers": { "Authorization": "Bearer ..." } }` |
| codex-local | `.codex/config.toml` | `[mcp_servers.figma]\ntransport = "http"\nurl = "..."\nheaders = { authorization = "Bearer ..." }` |
| gemini-local | TBD (research during impl) | research current MCP support in Gemini CLI |
| opencode-local | TBD (research during impl) | research current MCP support in Opencode |

For Gemini and Opencode: if they don't support HTTP MCPs yet, **document the gap** in the runtime materializer comment and skip those servers for those adapters with a clear log line. Don't block the whole feature.

**Token freshness:** materialization calls `mcpOauthService.ensureValidAccessToken` at the moment the config is written — so a token refresh runs synchronously if needed. Refreshed token is written into the config file. The adapter spawns its process with the fresh token.

**What if token refreshes mid-run?** The MCP client inside the agent's CLI holds the old token. Two acceptable options:
- (a) Accept stale-token errors during long runs; agent restarts naturally pick up the new token.
- (b) (Future) Implement a refresh proxy that re-issues tokens transparently. Out of scope for Phase 1.

## 9. Security

- **Token encryption at rest**: AES-256-GCM with envelope encryption (reuse `companySecrets` helpers).
- **PKCE S256** required by default for all OAuth flows; `usePkce: false` is allowed only for legacy providers.
- **State parameter**: 32-byte random, single-use, 10-minute TTL.
- **Redirect URI validation**: server-side check that the callback request matches a known session's `mcpServerId`.
- **HTTPS-only callback in production**: documented requirement. The UI shows a warning when `PAPERCLIP_DEPLOYMENT_MODE === "production"` and the host is HTTP.
- **Token rotation**: refresh tokens rotated when provider returns a new one.
- **Scope minimization**: documentation guides operators to request least-privilege scopes.
- **Audit trail**: every authorize/refresh/revoke action logged as activity entry with `actorId`.
- **CSRF protection on callback**: state parameter is the primary defense; additionally the callback is unauthenticated by design (provider redirects there) but only accepts requests with valid pending state.
- **Secret references**: `clientSecretRef` is a `${secret:...}` reference, never inlined.

## 10. Phases & estimates

| Phase | Scope | Estimate | Independently shippable? |
|---|---|---|---|
| **P1** | Schema migration + transport enum + URL/oauth_config columns; routes accept HTTP/SSE without auth; new oauth tables created but unused | 1 day | ✅ (existing stdio MCPs untouched) |
| **P2** | `mcp-oauth.ts` service + authorize/callback/revoke/status routes + token storage; tests | 2 days | ✅ (no UI yet; testable via curl) |
| **P3** | UI: transport picker, OAuth section in form, authorize button, status badge, callback popup page | 1.5 days | ✅ (operator can fully use OAuth MCPs) |
| **P4** | Adapter materialization for Claude + Codex + Cursor (HTTP/SSE format in their config files) | 1.5 days | ✅ (agents using those adapters get the MCP) |
| **P5** | Background refresh job + needs_reauth handling + activity log entries | 1 day | ✅ |
| **P6** | Adapter materialization research + impl for Gemini + Opencode | 1 day | ✅ (graceful skip if upstream doesn't support HTTP MCPs) |
| **P7** | Docs (`docs/guides/board-operator/mcp-oauth-recipes.md`) + AGENTS.md updates | 0.5 day | ✅ |

**Total: 8.5 dev days.** Phases are independent and each leaves the system in a working state — we can pause between any of them and ship what's done.

## 11. Testing strategy

- **Unit tests** (server vitest):
  - `mcp-oauth.test.ts`: state generation, PKCE verifier, code exchange (mocked fetch), refresh, revoke, status transitions
  - `company-mcp-servers-resolve.test.ts`: HTTP MCP with valid token → injected; expired → refresh path; `needs_reauth` → server skipped
- **Integration tests**:
  - End-to-end authorize flow with a mock OAuth provider (use `nock` or a local express stub)
  - Callback flow with bad state → 400
  - Concurrent refresh requests → only one provider call (in-process lock)
- **UI tests** (vitest + jsdom):
  - Authorize button opens popup with correct URL
  - postMessage handler updates status query
- **Manual smoke** before merging P3:
  - Real Figma OAuth flow against a sandbox app
  - Real Slack OAuth flow

## 12. Open questions

1. **Callback host detection.** The callback URL must match what the operator registered with the provider. In multi-host setups (e.g., dev on `localhost:3100`, prod on a domain), the same `mcp_server` row can't have two callback URLs. **Proposal:** the operator registers the production callback URL with the provider; in dev, operator points the provider app at `localhost:3100`. We document this. No code branching needed.
2. **Should we offer a "Test connection" button** that calls the MCP server's `initialize` method with the current token to validate end-to-end? Useful but not blocking. **Proposal:** P5 stretch goal.
3. **Token leak on `pg_dump`**: tokens are encrypted at rest, but if `PAPERCLIP_ENCRYPTION_KEY` is also dumped, they're recoverable. Documented as expected (same as existing secrets). No additional mitigation in P1-P7.
4. **Rate limiting the refresh job**: providers like Slack have aggressive rate limits. **Proposal:** the refresher already runs in 60s ticks with concurrency 5; if we see rate-limit errors, back off exponentially. Implement back-off in P5.

## 13. Files to create or change

**New:**
- `packages/db/src/schema/company_mcp_oauth_sessions.ts`
- `packages/db/src/schema/company_mcp_oauth_tokens.ts`
- `packages/db/migrations/<next>-mcp-oauth.sql`
- `packages/shared/src/types/mcp-oauth.ts`
- `packages/shared/src/validators/mcp-oauth.ts`
- `server/src/services/mcp-oauth.ts`
- `server/src/services/mcp-oauth-refresher.ts`
- `server/src/routes/company-mcp-servers-oauth.ts`
- `server/src/public/oauth-callback.html`
- `server/src/__tests__/mcp-oauth.test.ts`
- `server/src/__tests__/company-mcp-servers-oauth-routes.test.ts`
- `ui/src/api/mcp-oauth.ts`
- `ui/src/components/McpOAuthAuthorizeButton.tsx`
- `ui/src/components/McpOAuthStatusBadge.tsx`
- `docs/guides/board-operator/mcp-oauth-recipes.md`

**Modify:**
- `packages/db/src/schema/company_mcp_servers.ts` (add `url`, `oauthConfig`)
- `packages/db/src/schema/index.ts` (export new tables)
- `packages/shared/src/validators/company-mcp-server.ts` (extend transport enum, add OAuth fields)
- `packages/shared/src/types/company-mcp-server.ts`
- `server/src/app.ts` (mount new router)
- `server/src/services/company-mcp-servers.ts` (resolveRuntimeConfig for HTTP/SSE)
- `server/src/services/index.ts`
- `packages/adapter-utils/src/mcp-bundle.ts` (HTTP/SSE materialization for each adapter)
- `ui/src/pages/CompanyMcpServers.tsx` (form fields, status badge wiring)

## 14. Definition of done (Phase 1-7)

- [ ] Operator can create an HTTP MCP server in the UI with OAuth configuration
- [ ] "Authorize" flow works end-to-end with Figma, Notion, Slack against real providers (manual smoke)
- [ ] Tokens auto-refresh before expiry without operator intervention
- [ ] After revoke, the MCP is no longer materialized into agent configs
- [ ] All 5 adapters either materialize HTTP MCPs correctly or log a clear "not supported" message
- [ ] All new mutations have activity log entries
- [ ] Test coverage: unit + route + UI tests as listed in §11
- [ ] `pnpm test:run`, `pnpm -r typecheck`, `pnpm build` all green
- [ ] Greptile review 5/5; CI green
- [ ] `AGENTS.md` and `docs/` updated
