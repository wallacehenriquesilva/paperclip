---
title: AI authentication
summary: Manage Claude / Codex / Cursor / Gemini / OpenCode logins from the admin UI
---

Paperclip ships an embedded terminal and a status dashboard so instance
admins can log their CLI agents (Claude Code, Codex, Cursor, Gemini,
OpenCode) directly from the browser — no `docker exec` required.

## Who can use it

The pages live under **Instance settings → AI authentication** and **Instance
settings → Terminal**. Both endpoints reject any actor that is not an
**instance admin**. Agent API keys cannot open the terminal at all.

## AI authentication page

`/instance/settings/ai-auth`

A status card per supported CLI shows:

- Whether credentials exist on disk and parse cleanly
- The expiry date (when the provider exposes one — Claude does, others vary)
- The credentials path inside the container
- A **Re-authenticate** button that opens a terminal modal pre-loaded with the
  right login command. When the CLI process exits with `0`, the modal
  closes and the status card refreshes automatically.
- A **Sign out** button that removes the credentials file from disk.

## Instance terminal

`/instance/settings/terminal`

A general-purpose admin terminal embedded in the browser. Connects to a
WebSocket at `/api/instance/terminal/ws` and spawns a pty inside the
Paperclip container as the `node` user.

### Allowlist

The terminal only accepts spawn requests for binaries in a strict
allowlist (see `server/src/realtime/instance-terminal-ws.ts`):

- `claude`
- `codex`
- `cursor-agent`
- `gemini`
- `opencode`
- `gh`
- `uv`
- `uvx`

Any other binary is rejected before any process starts. This is the
**single most important defense** — the terminal cannot run `cat`,
`curl`, `psql`, or arbitrary shells, so a compromised admin session can't
just dump secrets via the terminal.

### Quick-login buttons

The terminal page exposes one-click buttons that pre-fill the right
command for each supported CLI. The admin still has to follow the
interactive flow (paste URL into browser, paste code back), but doesn't
need to remember the exact incantation.

### Session lifecycle

- Sessions time out after **15 minutes of inactivity**.
- When the WebSocket closes (browser tab closed, page refreshed), the
  spawned pty receives `SIGTERM` for its entire process group.
- Only one pty per WebSocket session.

### Audit log

Each terminal session emits two log lines via Pino:

- `event=instance.terminal_opened userId=<id>` — when the session opens.
- `event=instance.terminal_command userId=<id> command=<cmd> exitCode=<n>` —
  when a spawned process exits.

These do not (currently) go through the company-scoped activity log
because the terminal is an instance-wide concern. Surface them via your
container log aggregation.

## Troubleshooting

### "Forbidden" on the WebSocket upgrade

The connecting actor is not an instance admin. Promote the user under
**Instance settings → Access** before retrying.

### Credentials file owned by `root`

Happens when an earlier `docker exec --user root server claude /login`
left the file with the wrong owner. Fix it once with:

```sh
docker compose exec --user root server \
  chown node:node /paperclip/.claude/.credentials.json
```

After that the AI authentication page picks it up correctly. The
Paperclip entrypoint script also normalizes ownership on every container
start as a safety net.

### "node-pty backend unavailable"

The base image must have `python3` available at build time so the
`node-pty` postinstall can compile or fetch a prebuild. The published
Paperclip Docker image includes this; custom forks should keep it.
