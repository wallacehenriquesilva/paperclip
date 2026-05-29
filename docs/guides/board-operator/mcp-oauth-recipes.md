---
title: MCP OAuth recipes (Figma, Notion, Slack, GitHub, Linear)
---

# MCP OAuth recipes

This guide gives copy-paste recipes for the top 5 OAuth-protected MCP servers. Each recipe assumes:

1. You've already created an OAuth app on the provider's developer portal.
2. You've stored the app's `client_secret` as a Paperclip secret (Company → Secrets) under the key shown in the recipe.
3. Your Paperclip instance is reachable from the provider over HTTPS — you'll register a redirect URI of the form:

   ```
   https://<your-paperclip-host>/api/companies/<company-id>/mcp-servers/oauth/callback
   ```

   The exact URL is displayed at the bottom of every OAuth-enabled MCP's detail page (with a copy button).

> **Heads-up — production HTTPS required.** Providers reject `http://` redirect URIs except for `localhost`. If you're testing locally, configure the provider with `http://localhost:3100/...`; if you're on a deployed Paperclip, the host must be HTTPS.

---

## Figma

**Provider portal:** https://www.figma.com/developers/apps

| Field | Value |
|---|---|
| Transport | `streamable_http` |
| Server URL | `https://mcp.figma.com/v1` |
| Provider | `figma` |
| Authorization URL | `https://www.figma.com/oauth` |
| Token URL | `https://api.figma.com/v1/oauth/token` |
| Revocation URL | _leave empty_ |
| Scopes | `file_read` |
| Client secret reference | `${secret:figma-oauth-secret}` |

Then click **Authorize with figma** — a popup opens for you to log into Figma and grant access. After the popup closes, the status badge flips to **Connected**.

## Notion

Notion's official hosted MCP server uses **OAuth 2.1 + Dynamic Client Registration** — no manual app registration needed. Use Paperclip's "Use dynamic client registration" toggle.

| Field | Value |
|---|---|
| Transport | `streamable_http` |
| Server URL | `https://mcp.notion.com/mcp` |
| Provider | `notion` |
| **Use dynamic client registration** | **ON** |
| Scopes | _(leave empty — Notion uses connection capabilities, not OAuth scopes)_ |

After saving, click **Authorize with notion** in the server's detail page. Paperclip will:
1. Hit `https://mcp.notion.com/mcp` → get 401 + protected-resource metadata URL
2. Discover Notion's OAuth endpoints from `.well-known/oauth-authorization-server`
3. Register itself as a dynamic client (RFC 7591) — gets back a `client_id`
4. Open the Notion consent popup
5. After you grant access, exchanges the code for tokens (PKCE S256)

> Why no manual app registration? The Notion hosted MCP exposes a `registration_endpoint` per the MCP spec, so Paperclip self-registers. The previous manual recipe (with `client_id` + `client_secret` from a public integration) **does not work** against `mcp.notion.com` — that endpoint requires the DCR-issued client. If you must use a pre-registered public integration, run a local stdio MCP (`@notionhq/notion-mcp-server`) with the integration token instead.

## Slack

**Provider portal:** https://api.slack.com/apps

| Field | Value |
|---|---|
| Transport | `streamable_http` |
| Server URL | `https://mcp.slack.com` (or your enterprise URL) |
| Provider | `slack` |
| Authorization URL | `https://slack.com/oauth/v2/authorize` |
| Token URL | `https://slack.com/api/oauth.v2.access` |
| Revocation URL | `https://slack.com/api/auth.revoke` |
| Scopes | `chat:read`, `chat:write`, `channels:read` (least privilege — adjust to what the agent needs) |
| Client secret reference | `${secret:slack-oauth-secret}` |

## GitHub

**Provider portal:** https://github.com/settings/developers (OAuth Apps)

| Field | Value |
|---|---|
| Transport | `streamable_http` |
| Server URL | `https://api.githubcopilot.com/mcp/` |
| Provider | `github` |
| Authorization URL | `https://github.com/login/oauth/authorize` |
| Token URL | `https://github.com/login/oauth/access_token` |
| Scopes | `repo`, `read:org` (or fine-grained PAT scopes) |
| Client secret reference | `${secret:github-oauth-secret}` |

> GitHub returns `application/x-www-form-urlencoded` by default; Paperclip sends `Accept: application/json` so the token endpoint returns JSON.

## Linear

**Provider portal:** https://linear.app/settings/api/applications

| Field | Value |
|---|---|
| Transport | `streamable_http` |
| Server URL | `https://mcp.linear.app/sse` (Linear uses SSE today — set transport to `sse` if you find HTTP isn't supported in your tenant) |
| Provider | `linear` |
| Authorization URL | `https://linear.app/oauth/authorize` |
| Token URL | `https://api.linear.app/oauth/token` |
| Revocation URL | `https://api.linear.app/oauth/revoke` |
| Scopes | `read`, `write`, `issues:create` |
| Client secret reference | `${secret:linear-oauth-secret}` |

---

## How tokens get used

1. The operator authorizes once — Paperclip stores `access_token` + `refresh_token` (both encrypted at rest with the Paperclip master key).
2. When an agent that has this MCP enabled (`agent.runtimeConfig.desiredMcpServers`) starts a run, the heartbeat:
   - Resolves the MCP config
   - Calls `ensureValidAccessToken` — if the access token is within 60s of expiry, refreshes it transparently
   - Materializes the per-adapter config file (`.mcp.json`, `mcp.toml`, etc.) with `Authorization: Bearer <token>` in the headers
3. The agent's CLI loads that config and connects to the MCP over HTTP/SSE.

## Status states

| State | Meaning |
|---|---|
| **Not authorized** | OAuth configured but no token yet. Click *Authorize* to start the flow. |
| **Connected** | Token is valid, refresh works. Agents can use this MCP. |
| **Expired** | Token expired and refresh hasn't happened yet — will refresh on the next agent run. |
| **Needs re-auth** | 3+ consecutive refresh failures. Click *Re-authorize* to start fresh. |

## Troubleshooting

**The popup doesn't close after I log in.**
Provider may have blocked the redirect because the URI doesn't exactly match what's registered. Compare the URL you registered with the value shown in the MCP detail page (case-sensitive, trailing slash matters).

**The agent says "MCP server X skipped — no valid token."**
Check the status badge: probably *Needs re-auth*. Click *Re-authorize*. If the badge stays *Connected* but the agent still fails, the provider may have revoked the token server-side (admin policy change, app uninstalled, etc.) — re-authorize to get a fresh one.

**The token doesn't refresh during a long agent session.**
Today, refresh happens at the start of each heartbeat run. Long-running sessions (e.g. one CLI invocation that runs >1h) may hit an expired token mid-stream. Workaround: shorten heartbeat sessions or accept that the agent will recover on the next run. A background refresh job to keep tokens fresh during active sessions is planned (see `doc/plans/2026-05-28-mcp-oauth-support.md` Phase 5).

**stdio MCPs still work, right?**
Yes — stdio MCPs are untouched. Only `streamable_http` and `sse` transports use OAuth.
