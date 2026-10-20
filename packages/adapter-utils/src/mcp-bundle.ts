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
  /**
   * When set, the bundle is written to a per-run file (`mcp-<runId>.json`) so
   * concurrent runs sharing a workspace never read or delete each other's file.
   */
  runId?: string;
  onLog?: (channel: "stdout" | "stderr", line: string) => void | Promise<void>;
}

export interface PrepareMcpBundleResult {
  configFilePath: string;
  bundleDir: string;
  bundleFilename: string;
  cliFlags: string[];
  serverCount: number;
  format: McpAdapterFormat;
  /**
   * Env vars the caller must merge into the adapter process env. For Claude
   * the config file only holds `${VAR}` references; the values live here so
   * resolved secrets never touch disk.
   */
  env: Record<string, string>;
}

/** Prefix for env vars carrying MCP secret values; matches log redaction (`secret`). */
const MCP_SECRET_ENV_PREFIX = "PAPERCLIP_MCP_SECRET_";

function envVarSegment(value: string): string {
  const segment = value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return segment.length > 0 ? segment : "X";
}

function allocateSecretEnvVar(used: Set<string>, ...parts: string[]): string {
  const base = `${MCP_SECRET_ENV_PREFIX}${parts.map(envVarSegment).join("_")}`;
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
  used.add(name);
  return name;
}

/**
 * Moves every env and header value out of the server entries into env vars,
 * leaving `${VAR}` references that Claude Code expands at load time. Values are
 * all moved (not just "secret-looking" ones) because the server has already
 * resolved secret references to plain strings by the time they reach us.
 */
function externalizeClaudeServerValues(servers: ResolvedMcpServerEntry[]): {
  servers: ResolvedMcpServerEntry[];
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const used = new Set<string>();
  const externalized = servers.map((server) => {
    const serverEnv: Record<string, string> = {};
    for (const [envKey, value] of Object.entries(server.env)) {
      if (value.length === 0) {
        serverEnv[envKey] = value;
        continue;
      }
      const envVar = allocateSecretEnvVar(used, server.key, envKey);
      env[envVar] = value;
      serverEnv[envKey] = `\${${envVar}}`;
    }
    const headers: Record<string, string> = {};
    for (const [headerKey, value] of Object.entries(server.headers)) {
      if (value.length === 0) {
        headers[headerKey] = value;
        continue;
      }
      const envVar = allocateSecretEnvVar(used, server.key, "HDR", headerKey);
      env[envVar] = value;
      headers[headerKey] = `\${${envVar}}`;
    }
    return { ...server, env: serverEnv, headers };
  });
  return { servers: externalized, env };
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

function bundleFilename(adapter: McpAdapterFormat, runId?: string): string {
  const extension = adapter === "codex" ? "toml" : "json";
  const runSuffix = runId ? runId.replace(/[^A-Za-z0-9_-]/g, "") : "";
  return runSuffix ? `mcp-${runSuffix}.${extension}` : `mcp.${extension}`;
}

export function bundleDirectoryFor(adapter: McpAdapterFormat, workspaceCwd: string): string {
  return path.resolve(workspaceCwd, ".paperclip-runtime", adapter, "mcp");
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
  const bundleDir = bundleDirectoryFor(input.adapter, input.workspaceCwd);
  // Older releases wrote resolved secrets in plain text to a shared mcp.json;
  // drop it so existing workspaces are cleaned on their next run.
  await fs.rm(path.join(bundleDir, bundleFilename(input.adapter)), { force: true });

  if (input.resolvedServers.length === 0) return null;

  const { servers, env } =
    input.adapter === "claude"
      ? externalizeClaudeServerValues(input.resolvedServers)
      : { servers: input.resolvedServers, env: {} };
  const filename = bundleFilename(input.adapter, input.runId);
  const configFilePath = path.join(bundleDir, filename);
  await fs.mkdir(bundleDir, { recursive: true });
  const content = buildContent(input.adapter, servers);
  await fs.writeFile(configFilePath, content, { encoding: "utf8", mode: 0o600 });

  if (input.onLog) {
    await input.onLog(
      "stdout",
      `[paperclip] Wrote ${input.resolvedServers.length} MCP server${input.resolvedServers.length === 1 ? "" : "s"} to ${configFilePath}\n`,
    );
  }

  return {
    configFilePath,
    bundleDir,
    bundleFilename: filename,
    cliFlags: cliFlagsFor(input.adapter, configFilePath),
    serverCount: input.resolvedServers.length,
    format: input.adapter,
    env,
  };
}

/** Removes a bundle written by `prepareMcpBundle`. Safe to call with `null`. */
export async function cleanupMcpBundle(bundle: PrepareMcpBundleResult | null): Promise<void> {
  if (!bundle) return;
  await fs.rm(bundle.configFilePath, { force: true });
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
 *
 * @deprecated Inlines env/header values (often resolved secrets) into argv,
 * where they show up in `ps` and run metadata. Use `buildCodexMcpOverrides`.
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

/**
 * Env var names Codex itself depends on. A stdio MCP env entry with one of
 * these names is never forwarded through the Codex process env, since that
 * would change how Codex runs; it stays inline instead.
 */
const CODEX_RESERVED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "LANG",
  "NODE_OPTIONS",
  "CODEX_HOME",
]);

function isCodexReservedEnvKey(key: string): boolean {
  return CODEX_RESERVED_ENV_KEYS.has(key) || key.startsWith("LD_") || key.startsWith("DYLD_");
}

export interface CodexMcpOverrides {
  /** `-c key=value` pairs to splice into the Codex argv. Carry no env/header values. */
  flags: string[];
  /** Env vars to merge into the Codex process env. */
  env: Record<string, string>;
  /**
   * `<server>.<ENV_KEY>` entries that could not be forwarded (reserved name, or
   * the same name already set to a different value) and were inlined instead.
   */
  inlinedEnvKeys: string[];
}

/**
 * Builds Codex `-c` overrides that keep env and header values out of argv:
 * stdio env goes through `env_vars` (Codex forwards those names from its own
 * environment to the MCP server) and HTTP headers through `env_http_headers`.
 * The values are returned in `env` for the caller to set on the Codex process.
 *
 * `baseEnv` is the env Codex will run with; an `env_vars` name already present
 * there with a different value is inlined rather than overwritten.
 */
export function buildCodexMcpOverrides(
  servers: ResolvedMcpServerEntry[],
  baseEnv: Record<string, string | undefined> = {},
): CodexMcpOverrides {
  const flags: string[] = [];
  const env: Record<string, string> = {};
  const inlinedEnvKeys: string[] = [];
  const usedSecretVars = new Set<string>();

  for (const server of servers) {
    const base = `mcp_servers.${server.key}`;
    if (server.transport === "stdio") {
      flags.push("-c", `${base}.command=${escapeTomlInlineValue(server.command)}`);
      if (server.args.length > 0) {
        const argList = server.args.map(escapeTomlInlineValue).join(", ");
        flags.push("-c", `${base}.args=[${argList}]`);
      }
      const forwarded: string[] = [];
      for (const [envKey, envValue] of Object.entries(server.env)) {
        const existing = envKey in env ? env[envKey] : baseEnv[envKey];
        const canForward =
          !isCodexReservedEnvKey(envKey) && (existing === undefined || existing === envValue);
        if (canForward) {
          env[envKey] = envValue;
          forwarded.push(envKey);
        } else {
          flags.push("-c", `${base}.env.${envKey}=${escapeTomlInlineValue(envValue)}`);
          inlinedEnvKeys.push(`${server.key}.${envKey}`);
        }
      }
      if (forwarded.length > 0) {
        flags.push("-c", `${base}.env_vars=[${forwarded.map(escapeTomlInlineValue).join(", ")}]`);
      }
    } else {
      const transportTag = server.transport === "streamable_http" ? "http" : "sse";
      flags.push("-c", `${base}.transport=${escapeTomlInlineValue(transportTag)}`);
      flags.push("-c", `${base}.url=${escapeTomlInlineValue(server.url ?? "")}`);
      const headerEntries: string[] = [];
      for (const [headerKey, headerValue] of Object.entries(server.headers)) {
        const envVar = allocateSecretEnvVar(usedSecretVars, server.key, "HDR", headerKey);
        env[envVar] = headerValue;
        headerEntries.push(`${escapeTomlInlineValue(headerKey)} = ${escapeTomlInlineValue(envVar)}`);
      }
      if (headerEntries.length > 0) {
        flags.push("-c", `${base}.env_http_headers={ ${headerEntries.join(", ")} }`);
      }
    }
  }
  return { flags, env, inlinedEnvKeys };
}
