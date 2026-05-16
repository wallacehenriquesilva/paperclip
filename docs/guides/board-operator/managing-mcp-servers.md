---
title: Managing MCP servers
summary: Configure Model Context Protocol servers per company and attach them to agents
---

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) lets language
models call out to external tools — filesystems, APIs, internal services — via
a small JSON-RPC handshake. Paperclip ships first-class support for cataloging
MCP servers per company, attaching them to specific agents, and materializing
the right per-adapter config when a run starts.

This guide walks through the operator workflow.

## What ships in V1

- A **company library** of MCP server definitions at `/<company>/mcp-servers`.
- Per-agent **enable/disable** under the agent's `MCP` tab.
- A built-in **handshake test** that spawns the server and validates it before
  you attach it to an agent.
- Secrets stored encrypted in Paperclip and resolved on-the-fly during runs.
- Auto-injection of the MCP config for **`claude-local`** agents (other local
  adapters land in subsequent releases — see the bottom of this page).

## Permissions

Managing MCP servers requires the `mcp:manage` permission. By default, this is
granted to company owners and admins. Board operators with no role still need
this permission added in **Company → Settings → Access**.

Instance admins (and local-trusted boards) bypass the check.

## Creating a server

Open `/<company>/mcp-servers` and click the **+** in the sidebar.

| Field | Notes |
|---|---|
| Name | Display name (free text). |
| Key | Auto-derived from the name; lowercase, kebab-case. Unique per company. |
| Description | Optional. |
| Transport | `stdio` (V1 only — HTTP/SSE on the roadmap). |
| Command | The binary to spawn (e.g. `npx`, `uvx`, `/usr/local/bin/mcp-foo`). |
| Args | Repeatable list — type each one and press Enter to add it. |
| Env | Key/value rows with a mode toggle per row (see below). |
| Enabled | When off, the server is excluded from runs even if attached to agents. |

### Env modes

Each env variable has three modes, selectable via the three-icon toggle:

1. **Literal** — value stored as plain text. Use for non-sensitive config like
   `LOG_LEVEL=info`.
2. **New encrypted secret** — value is materialized into Paperclip's secret
   store on save. The env template stores a `${secret:<auto-key>}` reference.
   Reload the form after saving to see the auto-generated key. Use for tokens
   you're pasting in for the first time.
3. **Reference an existing secret** — type the key of a secret already managed
   under **Company → Settings → Secrets**. Use this to share one credential
   across multiple MCP servers.

### Disallowed commands

To reduce blast radius, Paperclip refuses these as the entry binary:

- Shell interpreters: `sh`, `bash`, `zsh`, `dash`, `ksh`, `fish`
- `eval`, `su`, `sudo`, `rm`
- Any command followed by `-c` or `--command` when the base is a shell

Wrap your MCP entrypoint in a dedicated binary if you need shell-like behavior.

## Testing the handshake

Once saved, the **Test handshake** button spawns the server (with secrets
resolved), sends an MCP `initialize` over stdio, then `tools/list` and
`resources/list`, and kills the process. The result panel shows:

- Server name and version (from the MCP response)
- Protocol version
- Tools exposed by the server
- Resources exposed by the server
- Duration in milliseconds

A failed handshake surfaces stderr from the spawned process — useful for
debugging missing dependencies, wrong env variables, or auth errors.

## Attaching to agents

Open an agent's detail page and switch to the **MCP** tab. You'll see every
MCP server in the company library, each with a toggle.

- Toggling **on** writes the server's id to
  `agent.runtime_config.desiredMcpServers`.
- Disabled servers in the library show a `disabled` badge and their toggle is
  read-only — re-enable them in the library first.
- Changes save immediately and survive page reloads.

The next time the agent runs, Paperclip:

1. Reads `desiredMcpServers` from the agent's runtime config.
2. Calls into the company MCP service to resolve each server (substituting
   any `${secret:...}` references with the live secret values).
3. Hands the resolved list to the adapter, which materializes the config
   in whichever shape its CLI expects (a runtime-asset bundle for Claude,
   a workspace-scoped auto-discovery file for Cursor/Opencode/Gemini, or
   inline `-c` overrides for Codex).

If a secret is referenced but missing from the target instance, the run
continues with a warning logged to stderr — the offending server is simply
skipped, not the whole run.

## Adapter coverage

All five local CLI adapters ship with MCP wiring in V1. Each one uses
the format and discovery mechanism the underlying CLI expects:

| Adapter | Status | Strategy | Where the config lands |
|---|---|---|---|
| `claude-local` | ✅ | Runtime-asset bundle + `--mcp-config` flag | `<workspace>/.paperclip-runtime/claude/mcp/mcp.json` (synced to remote targets) |
| `codex-local` | ✅ | Inline `-c mcp_servers.<key>.<field>=<value>` TOML overrides | No file — every server is described on the CLI |
| `cursor-local` | ✅ | Workspace auto-discovery | `<workspace>/.cursor/mcp.json` |
| `opencode-local` | ✅ | Workspace auto-discovery | `<workspace>/.opencode/opencode.json` |
| `gemini-local` | ✅ | Workspace auto-discovery (requires Gemini CLI versions that support MCP) | `<workspace>/.gemini/settings.json` |
| `cursor-cloud`, `openclaw-gateway` | ❌ Out of scope | Remote adapters need a different design | — |
| `acpx-local`, `pi-local` | ❌ Out of scope | Decision deferred per-adapter | — |
| `cursor-cloud`, `openclaw-gateway` | ❌ Out of scope | — | Remote adapters need a different design |
| `acpx-local`, `pi-local` | ❌ Out of scope | — | Decided per-adapter once base adapters land |

When you attach an MCP server to an agent whose adapter doesn't ship MCP
support yet, the toggle persists but the config is silently ignored at run
time. Use the company library's **Test handshake** to validate the server in
isolation in the meantime.

## Troubleshooting

### "MCP handshake failed: spawn uvx ENOENT"

The container or host doesn't have `uvx` (or whichever binary you configured)
in its `PATH`. In Paperclip's official Docker image, `uv`/`uvx` are
pre-installed under `/usr/local/bin`. If you customized the image, ensure the
binary is reachable by the `node` user.

### "Permission denied" creating `/paperclip/.cache/uv`

The `uv` cache directory was created with the wrong ownership inside the
volume. Recreate it manually:

```sh
docker compose exec --user root server bash -c \
  'mkdir -p /paperclip/.cache/uv /paperclip/.local/share/uv /paperclip/.local/bin \
    && chown -R node:node /paperclip/.cache /paperclip/.local'
```

The entrypoint creates these on each boot, so a `docker compose restart server`
also fixes it.

### "Secret is not bound to mcp_server:..."

A run referenced an MCP server whose env secret binding row is missing. This
usually means the secret was deleted out-of-band. Re-save the MCP server form
(no field changes needed) — Paperclip will re-sync the secret bindings.

### Server shows up in the company library but agent runs don't materialize a config

Check that the agent's adapter type is one of the supported ones (see the
table above). Also confirm `agent.runtime_config.desiredMcpServers` actually
contains the server id by inspecting the agent record under
**Configuration → Advanced**.

## Activity log entries

Every mutating action logs to **Company → Activity**:

- `company.mcp_server_created`
- `company.mcp_server_updated`
- `company.mcp_server_deleted`
- `company.mcp_server_tested` — including whether the handshake succeeded
- `company.skills_imported` is **not** triggered (MCPs are tracked separately)
