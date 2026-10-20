import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexCliOverrideFlags,
  buildCodexMcpOverrides,
  bundleDirectoryFor,
  cleanupMcpBundle,
  prepareMcpBundle,
  prepareMcpWorkspaceConfig,
  readResolvedMcpServers,
} from "./mcp-bundle.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  cleanupDirs.clear();
});

async function makeTempWorkspace(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

const SAMPLE_SERVER = {
  id: "srv-1",
  key: "filesystem",
  name: "Filesystem",
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  env: { LOG_LEVEL: "info" },
  url: null,
  headers: {},
};

const SAMPLE_HTTP_SERVER = {
  id: "srv-http",
  key: "figma",
  name: "Figma",
  transport: "streamable_http" as const,
  command: "",
  args: [],
  env: {},
  url: "https://mcp.figma.com",
  headers: { authorization: "Bearer tok-xyz" },
};

describe("readResolvedMcpServers", () => {
  it("returns an empty list when nothing is configured", () => {
    expect(readResolvedMcpServers({})).toEqual([]);
    expect(readResolvedMcpServers({ paperclipResolvedMcpServers: null })).toEqual([]);
    expect(readResolvedMcpServers({ paperclipResolvedMcpServers: "junk" })).toEqual([]);
  });

  it("filters malformed entries while keeping valid ones", () => {
    const parsed = readResolvedMcpServers({
      paperclipResolvedMcpServers: [
        SAMPLE_SERVER,
        { id: "no-command", key: "bad" },
        { ...SAMPLE_SERVER, id: "srv-2", key: "second" },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed.map((server) => server.key)).toEqual(["filesystem", "second"]);
  });

  it("coerces unknown env values to strings (dropping non-strings)", () => {
    const parsed = readResolvedMcpServers({
      paperclipResolvedMcpServers: [
        {
          ...SAMPLE_SERVER,
          env: { GOOD: "yes", BAD: 42 },
        },
      ],
    });
    expect(parsed[0]!.env).toEqual({ GOOD: "yes" });
  });
});

describe("prepareMcpBundle", () => {
  it("returns null when there are no resolved servers", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-empty-");
    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [],
    });
    expect(result).toBeNull();
  });

  it("writes the claude mcp.json with the expected shape", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-claude-");
    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
    });
    expect(result).not.toBeNull();
    expect(result!.format).toBe("claude");
    expect(result!.cliFlags).toEqual(["--mcp-config", result!.configFilePath]);
    expect(result!.bundleDir).toBe(bundleDirectoryFor("claude", workspace));

    const written = await fs.readFile(result!.configFilePath, "utf8");
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { LOG_LEVEL: "${PAPERCLIP_MCP_SECRET_FILESYSTEM_LOG_LEVEL}" },
        },
      },
    });
    expect(result!.env).toEqual({ PAPERCLIP_MCP_SECRET_FILESYSTEM_LOG_LEVEL: "info" });
  });

  it("writes Claude config with http transport when transport is streamable_http", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-claude-http-");
    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_HTTP_SERVER],
    });
    const written = await fs.readFile(result!.configFilePath, "utf8");
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({
      mcpServers: {
        figma: {
          type: "http",
          url: "https://mcp.figma.com",
          headers: { authorization: "${PAPERCLIP_MCP_SECRET_FIGMA_HDR_AUTHORIZATION}" },
        },
      },
    });
    expect(written).not.toContain("tok-xyz");
    expect(result!.env).toEqual({ PAPERCLIP_MCP_SECRET_FIGMA_HDR_AUTHORIZATION: "Bearer tok-xyz" });
  });

  it("never writes resolved secret values to the claude bundle", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-claude-secret-");
    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [
        { ...SAMPLE_SERVER, key: "github", env: { GITHUB_TOKEN: "ghp_live_value", EMPTY: "" } },
      ],
    });
    const written = await fs.readFile(result!.configFilePath, "utf8");
    expect(written).not.toContain("ghp_live_value");
    expect(JSON.parse(written).mcpServers.github.env).toEqual({
      GITHUB_TOKEN: "${PAPERCLIP_MCP_SECRET_GITHUB_GITHUB_TOKEN}",
      EMPTY: "",
    });
    expect(result!.env).toEqual({ PAPERCLIP_MCP_SECRET_GITHUB_GITHUB_TOKEN: "ghp_live_value" });
  });

  it("disambiguates env var names that collide after normalization", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-claude-collide-");
    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [
        { ...SAMPLE_SERVER, key: "my-server", env: { TOKEN: "a" } },
        { ...SAMPLE_SERVER, id: "srv-2", key: "my_server", env: { TOKEN: "b" } },
      ],
    });
    expect(result!.env).toEqual({
      PAPERCLIP_MCP_SECRET_MY_SERVER_TOKEN: "a",
      PAPERCLIP_MCP_SECRET_MY_SERVER_TOKEN_2: "b",
    });
  });

  it("writes a per-run, owner-only file and removes the legacy shared mcp.json", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-claude-run-");
    const bundleDir = bundleDirectoryFor("claude", workspace);
    await fs.mkdir(bundleDir, { recursive: true });
    const legacyPath = path.join(bundleDir, "mcp.json");
    await fs.writeFile(legacyPath, '{"mcpServers":{"github":{"env":{"GITHUB_TOKEN":"ghp_old"}}}}');

    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
      runId: "run-123",
    });
    expect(result!.bundleFilename).toBe("mcp-run-123.json");
    expect(result!.configFilePath).toBe(path.join(bundleDir, "mcp-run-123.json"));
    await expect(fs.stat(legacyPath)).rejects.toThrow();
    if (process.platform !== "win32") {
      const stat = await fs.stat(result!.configFilePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }

    await cleanupMcpBundle(result);
    await expect(fs.stat(result!.configFilePath)).rejects.toThrow();
  });

  it("removes the legacy shared mcp.json even when no servers are attached", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-claude-legacy-");
    const bundleDir = bundleDirectoryFor("claude", workspace);
    await fs.mkdir(bundleDir, { recursive: true });
    const legacyPath = path.join(bundleDir, "mcp.json");
    await fs.writeFile(legacyPath, "{}");

    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [],
      runId: "run-123",
    });
    expect(result).toBeNull();
    await expect(fs.stat(legacyPath)).rejects.toThrow();
  });

  it("writes Codex TOML with transport=http + url + headers table for HTTP MCP", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-codex-http-");
    const result = await prepareMcpBundle({
      adapter: "codex",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_HTTP_SERVER],
    });
    const written = await fs.readFile(result!.configFilePath, "utf8");
    expect(written).toContain("[mcp_servers.figma]");
    expect(written).toContain('transport = "http"');
    expect(written).toContain('url = "https://mcp.figma.com"');
    expect(written).toContain("[mcp_servers.figma.headers]");
    expect(written).toContain('authorization = "Bearer tok-xyz"');
    expect(written).not.toContain("command =");
  });

  it("writes a TOML config for codex with --config flag", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-codex-");
    const result = await prepareMcpBundle({
      adapter: "codex",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
    });
    expect(result).not.toBeNull();
    expect(result!.cliFlags[0]).toBe("--config");
    expect(result!.cliFlags[1]).toMatch(/^mcp_servers_config=.*\.toml$/);

    const written = await fs.readFile(result!.configFilePath, "utf8");
    expect(written).toContain("[mcp_servers.filesystem]");
    expect(written).toContain('command = "npx"');
    expect(written).toContain("args = [");
    expect(written).toContain("[mcp_servers.filesystem.env]");
    expect(written).toContain('LOG_LEVEL = "info"');
  });

  it("writes the cursor config under .paperclip-runtime/cursor/mcp/", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-cursor-");
    const result = await prepareMcpBundle({
      adapter: "cursor",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
    });
    expect(result).not.toBeNull();
    expect(result!.bundleDir).toContain(path.join(".paperclip-runtime", "cursor", "mcp"));
    expect(result!.configFilePath).toMatch(/mcp\.json$/);
    expect(result!.cliFlags).toEqual([]);
  });

  it("reports the server count back to the caller", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-count-");
    const result = await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [
        SAMPLE_SERVER,
        { ...SAMPLE_SERVER, id: "srv-2", key: "second" },
      ],
    });
    expect(result?.serverCount).toBe(2);
  });

  it("calls onLog with a summary line when a bundle is materialized", async () => {
    const workspace = await makeTempWorkspace("mcp-bundle-log-");
    const lines: string[] = [];
    await prepareMcpBundle({
      adapter: "claude",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
      onLog: async (_channel, line) => {
        lines.push(line);
      },
    });
    expect(lines.some((line) => line.includes("1 MCP server"))).toBe(true);
  });
});

describe("prepareMcpWorkspaceConfig", () => {
  it("returns null when there are no servers", async () => {
    const workspace = await makeTempWorkspace("mcp-ws-empty-");
    const result = await prepareMcpWorkspaceConfig({
      adapter: "cursor",
      workspaceCwd: workspace,
      resolvedServers: [],
    });
    expect(result).toBeNull();
  });

  it("writes cursor config to <workspace>/.cursor/mcp.json", async () => {
    const workspace = await makeTempWorkspace("mcp-ws-cursor-");
    const result = await prepareMcpWorkspaceConfig({
      adapter: "cursor",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
    });
    expect(result?.configFilePath).toBe(path.join(workspace, ".cursor", "mcp.json"));
    expect(result?.serverCount).toBe(1);
    const written = await fs.readFile(result!.configFilePath, "utf8");
    expect(JSON.parse(written)).toEqual({
      mcpServers: {
        filesystem: {
          type: "stdio",
          command: "npx",
          args: SAMPLE_SERVER.args,
          env: SAMPLE_SERVER.env,
        },
      },
    });
  });

  it("writes opencode config to <workspace>/.opencode/opencode.json", async () => {
    const workspace = await makeTempWorkspace("mcp-ws-opencode-");
    const result = await prepareMcpWorkspaceConfig({
      adapter: "opencode",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
    });
    expect(result?.configFilePath).toBe(
      path.join(workspace, ".opencode", "opencode.json"),
    );
  });

  it("writes gemini config to <workspace>/.gemini/settings.json", async () => {
    const workspace = await makeTempWorkspace("mcp-ws-gemini-");
    const result = await prepareMcpWorkspaceConfig({
      adapter: "gemini",
      workspaceCwd: workspace,
      resolvedServers: [SAMPLE_SERVER],
    });
    expect(result?.configFilePath).toBe(
      path.join(workspace, ".gemini", "settings.json"),
    );
  });
});

describe("buildCodexCliOverrideFlags", () => {
  it("returns an empty array when no servers are resolved", () => {
    expect(buildCodexCliOverrideFlags([])).toEqual([]);
  });

  it("emits command + args + env flag pairs per server", () => {
    const flags = buildCodexCliOverrideFlags([SAMPLE_SERVER]);
    expect(flags).toEqual([
      "-c", 'mcp_servers.filesystem.command="npx"',
      "-c", 'mcp_servers.filesystem.args=["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
      "-c", 'mcp_servers.filesystem.env.LOG_LEVEL="info"',
    ]);
  });

  it("escapes quotes and backslashes in TOML values", () => {
    const flags = buildCodexCliOverrideFlags([
      {
        ...SAMPLE_SERVER,
        command: `weird"path\\with\\stuff`,
        args: [`arg"with"quote`],
        env: { FOO: 'bar"baz' },
      },
    ]);
    expect(flags[1]).toBe('mcp_servers.filesystem.command="weird\\"path\\\\with\\\\stuff"');
    expect(flags[3]).toBe('mcp_servers.filesystem.args=["arg\\"with\\"quote"]');
    expect(flags[5]).toBe('mcp_servers.filesystem.env.FOO="bar\\"baz"');
  });

  it("skips args block when the server has no args", () => {
    const flags = buildCodexCliOverrideFlags([
      { ...SAMPLE_SERVER, args: [], env: {} },
    ]);
    expect(flags).toEqual([
      "-c", 'mcp_servers.filesystem.command="npx"',
    ]);
  });

  it("emits transport/url/headers overrides for HTTP MCPs", () => {
    const flags = buildCodexCliOverrideFlags([SAMPLE_HTTP_SERVER]);
    expect(flags).toEqual([
      "-c", 'mcp_servers.figma.transport="http"',
      "-c", 'mcp_servers.figma.url="https://mcp.figma.com"',
      "-c", 'mcp_servers.figma.headers.authorization="Bearer tok-xyz"',
    ]);
  });
});

describe("buildCodexMcpOverrides", () => {
  it("returns no flags or env when no servers are resolved", () => {
    expect(buildCodexMcpOverrides([])).toEqual({ flags: [], env: {}, inlinedEnvKeys: [] });
  });

  it("forwards stdio env through env_vars instead of inlining values", () => {
    const overrides = buildCodexMcpOverrides([
      { ...SAMPLE_SERVER, key: "github", env: { GITHUB_TOKEN: "ghp_live_value" } },
    ]);
    expect(overrides.flags.join(" ")).not.toContain("ghp_live_value");
    expect(overrides.flags).toContain('mcp_servers.github.env_vars=["GITHUB_TOKEN"]');
    expect(overrides.flags).toContain('mcp_servers.github.command="npx"');
    expect(overrides.env).toEqual({ GITHUB_TOKEN: "ghp_live_value" });
    expect(overrides.inlinedEnvKeys).toEqual([]);
  });

  it("forwards HTTP headers through env_http_headers", () => {
    const overrides = buildCodexMcpOverrides([SAMPLE_HTTP_SERVER]);
    expect(overrides.flags.join(" ")).not.toContain("tok-xyz");
    expect(overrides.flags).toContain(
      'mcp_servers.figma.env_http_headers={ "authorization" = "PAPERCLIP_MCP_SECRET_FIGMA_HDR_AUTHORIZATION" }',
    );
    expect(overrides.env).toEqual({ PAPERCLIP_MCP_SECRET_FIGMA_HDR_AUTHORIZATION: "Bearer tok-xyz" });
  });

  it("inlines reserved names and values that conflict with the Codex env", () => {
    const overrides = buildCodexMcpOverrides(
      [
        {
          ...SAMPLE_SERVER,
          key: "tools",
          env: { PATH: "/custom/bin", API_TOKEN: "server-value", SHARED: "same" },
        },
      ],
      { API_TOKEN: "codex-value", SHARED: "same" },
    );
    expect(overrides.flags).toContain('mcp_servers.tools.env.PATH="/custom/bin"');
    expect(overrides.flags).toContain('mcp_servers.tools.env.API_TOKEN="server-value"');
    expect(overrides.flags).toContain('mcp_servers.tools.env_vars=["SHARED"]');
    expect(overrides.env).toEqual({ SHARED: "same" });
    expect(overrides.inlinedEnvKeys).toEqual(["tools.PATH", "tools.API_TOKEN"]);
  });

  it("inlines a second server's env when it reuses a forwarded name with another value", () => {
    const overrides = buildCodexMcpOverrides([
      { ...SAMPLE_SERVER, key: "a", env: { TOKEN: "one" } },
      { ...SAMPLE_SERVER, id: "srv-b", key: "b", env: { TOKEN: "two" } },
    ]);
    expect(overrides.env).toEqual({ TOKEN: "one" });
    expect(overrides.flags).toContain('mcp_servers.b.env.TOKEN="two"');
    expect(overrides.inlinedEnvKeys).toEqual(["b.TOKEN"]);
  });
});
