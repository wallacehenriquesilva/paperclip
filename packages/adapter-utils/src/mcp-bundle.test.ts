import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleDirectoryFor,
  prepareMcpBundle,
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
          env: { LOG_LEVEL: "info" },
        },
      },
    });
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
