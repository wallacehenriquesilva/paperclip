import { promises as fs } from "node:fs";
import path from "node:path";

export interface ResolvedMcpServerEntry {
  id: string;
  key: string;
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
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
    const command = typeof record.command === "string" ? record.command : null;
    if (!id || !key || !command) continue;
    const transport = record.transport === "stdio" ? "stdio" : "stdio";
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
    out.push({ id, key, name: name ?? key, transport, command, args, env });
  }
  return out;
}

function buildClaudeConfig(servers: ResolvedMcpServerEntry[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.key] = {
      type: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
    };
  }
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
