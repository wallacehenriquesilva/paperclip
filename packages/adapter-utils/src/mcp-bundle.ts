import { promises as fs } from "node:fs";
import path from "node:path";

export type ResolvedMcpTransport = "stdio" | "streamable_http" | "sse";

export interface ResolvedMcpServerEntry {
  id: string;
  key: string;
  name: string;
  transport: ResolvedMcpTransport;
  /** Empty string for non-stdio transports. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Required for streamable_http/sse, null otherwise. */
  url: string | null;
  /** HTTP request headers — e.g. `{ authorization: "Bearer ..." }` for OAuth. */
  headers: Record<string, string>;
}

export type McpAdapterFormat = "claude" | "cursor" | "codex" | "gemini" | "opencode";

export interface PrepareMcpBundleInput {
  adapter: McpAdapterFormat;
  workspaceCwd: string;
  resolvedServers: ResolvedMcpServerEntry[];
  onLog?: (channel: "stdout" | "stderr", line: string) => void | Promise<void>;
}

export interface PrepareMcpBundleResult {
  configFilePath: string;
  bundleDir: string;
  bundleFilename: string;
  cliFlags: string[];
  serverCount: number;
  format: McpAdapterFormat;
}

/**
 * Reads the pre-resolved MCP server list that the server injects into the
 * adapter runtime config under `paperclipResolvedMcpServers`.
 */
export function readResolvedMcpServers(config: Record<string, unknown>): ResolvedMcpServerEntry[] {
  const raw = config.paperclipResolvedMcpServers;
  if (!Array.isArray(raw)) return [];
  const out: ResolvedMcpServerEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const key = typeof record.key === "string" ? record.key : null;
    const name = typeof record.name === "string" ? record.name : key;
    if (!id || !key) continue;

    const transport: ResolvedMcpTransport =
      record.transport === "streamable_http"
        ? "streamable_http"
        : record.transport === "sse"
          ? "sse"
          : "stdio";

    const command = typeof record.command === "string" ? record.command : "";
    const url = typeof record.url === "string" && record.url.length > 0 ? record.url : null;

    // Require either a command (stdio) or a url (http/sse) — skip otherwise.
    if (transport === "stdio" && !command) continue;
    if (transport !== "stdio" && !url) continue;

    const args = Array.isArray(record.args)
      ? record.args.filter((value): value is string => typeof value === "string")
      : [];
    const envEntries =
      record.env && typeof record.env === "object" && !Array.isArray(record.env)
        ? (record.env as Record<string, unknown>)
        : {};
    const env: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(envEntries)) {
      if (typeof envValue === "string") env[envKey] = envValue;
    }
    const headerEntries =
      record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
        ? (record.headers as Record<string, unknown>)
        : {};
    const headers: Record<string, string> = {};
    for (const [hKey, hValue] of Object.entries(headerEntries)) {
      if (typeof hValue === "string") headers[hKey] = hValue;
    }

    out.push({ id, key, name: name ?? key, transport, command, args, env, url, headers });
  }
  return out;
}

/**
 * Build the per-server entry for the JSON-based adapters (Claude/Cursor/
 * Opencode/Gemini). The MCP spec defines `"type": "stdio" | "http" | "sse"`
 * and per-transport fields. Claude Code's `.mcp.json` uses this same shape.
 */
function buildJsonServerEntry(server: ResolvedMcpServerEntry): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
    };
  }
  if (server.transport === "streamable_http") {
    return {
      type: "http",
      url: server.url,
      headers: server.headers,
    };
  }
  // sse
  return {
    type: "sse",
    url: server.url,
    headers: server.headers,
  };
}

function buildClaudeConfig(servers: ResolvedMcpServerEntry[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) mcpServers[server.key] = buildJsonServerEntry(server);
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function buildCursorConfig(servers: ResolvedMcpServerEntry[]): string {
  return buildClaudeConfig(servers);
}

function buildOpencodeConfig(servers: ResolvedMcpServerEntry[]): string {
  return buildClaudeConfig(servers);
}

function buildGeminiConfig(servers: ResolvedMcpServerEntry[]): string {
  return buildClaudeConfig(servers);
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildCodexConfig(servers: ResolvedMcpServerEntry[]): string {
  const lines: string[] = [];
  for (const server of servers) {
    lines.push(`[mcp_servers.${server.key}]`);
    if (server.transport === "stdio") {
      lines.push(`command = "${escapeTomlString(server.command)}"`);
      if (server.args.length > 0) {
        const argList = server.args
          .map((arg) => `"${escapeTomlString(arg)}"`)
          .join(", ");
        lines.push(`args = [${argList}]`);
      }
      const envKeys = Object.keys(server.env);
      if (envKeys.length > 0) {
        lines.push(`[mcp_servers.${server.key}.env]`);
        for (const key of envKeys) {
          lines.push(`${key} = "${escapeTomlString(server.env[key]!)}"`);
        }
      }
    } else {
      // Codex CLI's HTTP MCP support: transport + url + headers table.
      // If a Codex version lacks HTTP support, this section is silently ignored.
      const transportTag = server.transport === "streamable_http" ? "http" : "sse";
      lines.push(`transport = "${transportTag}"`);
      lines.push(`url = "${escapeTomlString(server.url ?? "")}"`);
      const headerKeys = Object.keys(server.headers);
      if (headerKeys.length > 0) {
        lines.push(`[mcp_servers.${server.key}.headers]`);
        for (const key of headerKeys) {
          lines.push(`${key} = "${escapeTomlString(server.headers[key]!)}"`);
        }
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

function buildContent(adapter: McpAdapterFormat, servers: ResolvedMcpServerEntry[]): string {
  switch (adapter) {
    case "claude":
      return buildClaudeConfig(servers);
    case "cursor":
      return buildCursorConfig(servers);
    case "opencode":
      return buildOpencodeConfig(servers);
    case "gemini":
      return buildGeminiConfig(servers);
    case "codex":
      return buildCodexConfig(servers);
    default:
      return buildClaudeConfig(servers);
  }
}

function bundleFilename(adapter: McpAdapterFormat): string {
  return adapter === "codex" ? "mcp.toml" : "mcp.json";
}

export function bundleDirectoryFor(adapter: McpAdapterFormat, workspaceCwd: string): string {
  return path.resolve(workspaceCwd, ".paperclip-runtime", adapter, "mcp");
}

function bundleFilePath(adapter: McpAdapterFormat, workspaceCwd: string): string {
  return path.join(bundleDirectoryFor(adapter, workspaceCwd), bundleFilename(adapter));
}

function cliFlagsFor(adapter: McpAdapterFormat, configPath: string): string[] {
  switch (adapter) {
    case "claude":
      return ["--mcp-config", configPath];
    case "codex":
      return ["--config", `mcp_servers_config=${configPath}`];
    default:
      return [];
  }
}

/**
 * Materializes a per-adapter MCP config file under the workspace and returns
 * the path plus any CLI flags that should be appended to the adapter command.
 *
 * Returns `null` when there are no resolved servers, so callers can skip the
 * extra flag entirely.
 */
export async function prepareMcpBundle(
  input: PrepareMcpBundleInput,
): Promise<PrepareMcpBundleResult | null> {
  if (input.resolvedServers.length === 0) return null;

  const configFilePath = bundleFilePath(input.adapter, input.workspaceCwd);
  await fs.mkdir(path.dirname(configFilePath), { recursive: true });
  const content = buildContent(input.adapter, input.resolvedServers);
  await fs.writeFile(configFilePath, content, "utf8");

  if (input.onLog) {
    await input.onLog(
      "stdout",
      `[paperclip] Wrote ${input.resolvedServers.length} MCP server${input.resolvedServers.length === 1 ? "" : "s"} to ${configFilePath}\n`,
    );
  }

  return {
    configFilePath,
    bundleDir: bundleDirectoryFor(input.adapter, input.workspaceCwd),
    bundleFilename: bundleFilename(input.adapter),
    cliFlags: cliFlagsFor(input.adapter, configFilePath),
    serverCount: input.resolvedServers.length,
    format: input.adapter,
  };
}

export type McpWorkspaceConfigAdapter = "cursor" | "opencode" | "gemini";

export interface PrepareMcpWorkspaceConfigResult {
  configFilePath: string;
  serverCount: number;
  format: McpWorkspaceConfigAdapter;
}

function workspaceConfigPath(adapter: McpWorkspaceConfigAdapter, workspaceCwd: string): string {
  switch (adapter) {
    case "cursor":
      return path.resolve(workspaceCwd, ".cursor", "mcp.json");
    case "opencode":
      return path.resolve(workspaceCwd, ".opencode", "opencode.json");
    case "gemini":
      return path.resolve(workspaceCwd, ".gemini", "settings.json");
  }
}

/**
 * Writes a workspace-scoped MCP config file that the adapter CLI auto-discovers
 * (Cursor reads `<workspace>/.cursor/mcp.json`, Opencode reads
 * `<workspace>/.opencode/opencode.json`, Gemini reads
 * `<workspace>/.gemini/settings.json`). No CLI flag is needed.
 *
 * Returns `null` when there are no servers to write.
 */
export async function prepareMcpWorkspaceConfig(input: {
  adapter: McpWorkspaceConfigAdapter;
  workspaceCwd: string;
  resolvedServers: ResolvedMcpServerEntry[];
  onLog?: (channel: "stdout" | "stderr", line: string) => void | Promise<void>;
}): Promise<PrepareMcpWorkspaceConfigResult | null> {
  if (input.resolvedServers.length === 0) return null;

  const configFilePath = workspaceConfigPath(input.adapter, input.workspaceCwd);
  await fs.mkdir(path.dirname(configFilePath), { recursive: true });
  const content = buildContent(input.adapter, input.resolvedServers);
  await fs.writeFile(configFilePath, content, "utf8");

  if (input.onLog) {
    await input.onLog(
      "stdout",
      `[paperclip] Wrote ${input.resolvedServers.length} MCP server${input.resolvedServers.length === 1 ? "" : "s"} to ${configFilePath}\n`,
    );
  }

  return {
    configFilePath,
    serverCount: input.resolvedServers.length,
    format: input.adapter,
  };
}

function escapeTomlInlineValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Builds an array of `-c key=value` CLI flag pairs that Codex CLI accepts as
 * inline TOML overrides. Each MCP server contributes between 1 and N flag
 * pairs depending on whether it has args/env. Use as:
 *
 *   const flags = buildCodexCliOverrideFlags(servers);
 *   args.push(...flags);  // e.g. ["-c", "mcp_servers.foo.command=\"npx\"", ...]
 *
 * Returns an empty array when no servers are configured.
 */
export function buildCodexCliOverrideFlags(servers: ResolvedMcpServerEntry[]): string[] {
  const out: string[] = [];
  for (const server of servers) {
    const base = `mcp_servers.${server.key}`;
    if (server.transport === "stdio") {
      out.push("-c", `${base}.command=${escapeTomlInlineValue(server.command)}`);
      if (server.args.length > 0) {
        const argList = server.args.map(escapeTomlInlineValue).join(", ");
        out.push("-c", `${base}.args=[${argList}]`);
      }
      for (const [envKey, envValue] of Object.entries(server.env)) {
        out.push("-c", `${base}.env.${envKey}=${escapeTomlInlineValue(envValue)}`);
      }
    } else {
      const transportTag = server.transport === "streamable_http" ? "http" : "sse";
      out.push("-c", `${base}.transport=${escapeTomlInlineValue(transportTag)}`);
      out.push("-c", `${base}.url=${escapeTomlInlineValue(server.url ?? "")}`);
      for (const [hKey, hValue] of Object.entries(server.headers)) {
        out.push("-c", `${base}.headers.${hKey}=${escapeTomlInlineValue(hValue)}`);
      }
    }
  }
  return out;
}
