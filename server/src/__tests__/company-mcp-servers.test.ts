import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyMcpServers, companySecrets, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  assertCommandAllowed,
  companyMcpServerService,
} from "../services/company-mcp-servers.ts";

describe("assertCommandAllowed", () => {
  it("rejects shell binaries", () => {
    for (const cmd of ["sh", "bash", "/bin/sh", "zsh", "ksh"]) {
      expect(() => assertCommandAllowed(cmd, ["-c", "ls"])).toThrow(/not allowed|shell evaluation/i);
    }
  });

  it("rejects destructive utilities", () => {
    expect(() => assertCommandAllowed("rm", ["-rf", "/"])).toThrow(/not allowed/i);
  });

  it("rejects shell-eval-via-args even for non-shell base commands", () => {
    expect(() => assertCommandAllowed("bash", ["-c", "echo hi"])).toThrow(/shell evaluation|not allowed/i);
  });

  it("accepts standard MCP entrypoints", () => {
    expect(() =>
      assertCommandAllowed("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]),
    ).not.toThrow();
    expect(() => assertCommandAllowed("node", ["server.js"]) ).not.toThrow();
    expect(() => assertCommandAllowed("/usr/local/bin/mcp-foo", []) ).not.toThrow();
  });

  it("rejects empty command", () => {
    expect(() => assertCommandAllowed("", []) ).toThrow(/required/i);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres MCP server tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyMcpServerService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyMcpServerService>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("company-mcp-servers");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = companyMcpServerService(db);
  });

  afterEach(async () => {
    await db.delete(companyMcpServers);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("creates a streamable_http server without requiring a command", async () => {
    const companyId = await seedCompany();

    const server = await svc.create(companyId, {
      name: "Figma",
      transport: "streamable_http",
      url: "https://mcp.figma.com",
    });

    expect(server.transport).toBe("streamable_http");
    expect(server.url).toBe("https://mcp.figma.com");
    expect(server.command).toBe("");
    expect(server.oauthConfig).toBeNull();
  });

  it("creates an SSE server without requiring a command", async () => {
    const companyId = await seedCompany();

    const server = await svc.create(companyId, {
      name: "Linear",
      transport: "sse",
      url: "https://mcp.linear.app/sse",
    });

    expect(server.transport).toBe("sse");
    expect(server.url).toBe("https://mcp.linear.app/sse");
    expect(server.command).toBe("");
  });

  it("rejects a streamable_http server without a url", async () => {
    const companyId = await seedCompany();

    await expect(
      svc.create(companyId, {
        name: "No-url-server",
        transport: "streamable_http",
      }),
    ).rejects.toThrow(/url is required/i);
  });

  it("rejects a stdio server without a command", async () => {
    const companyId = await seedCompany();

    await expect(
      svc.create(companyId, {
        name: "No-command-server",
        transport: "stdio",
      } as any),
    ).rejects.toThrow(/command is required/i);
  });

  it("creates a server with literal env values", async () => {
    const companyId = await seedCompany();

    const server = await svc.create(companyId, {
      name: "Filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { LOG_LEVEL: { kind: "literal", value: "info" } },
    });

    expect(server.key).toBe("filesystem");
    expect(server.envTemplate).toEqual({ LOG_LEVEL: "info" });
    expect(server.enabled).toBe(true);
  });

  it("materializes inline secrets into companySecrets and stores a reference", async () => {
    const companyId = await seedCompany();

    const server = await svc.create(companyId, {
      name: "Atlassian",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-atlassian"],
      env: {
        ATLASSIAN_TOKEN: { kind: "secret_inline", value: "super-secret-token" },
        ATLASSIAN_BASE_URL: { kind: "literal", value: "https://example.atlassian.net" },
      },
    });

    expect(server.envTemplate.ATLASSIAN_TOKEN).toMatch(/^\$\{secret:mcp-atlassian-atlassian-token/);
    expect(server.envTemplate.ATLASSIAN_BASE_URL).toBe("https://example.atlassian.net");

    const secretRows = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(secretRows).toHaveLength(1);
    expect(secretRows[0]!.managedMode).toBe("paperclip_managed");
  });

  it("rejects duplicate keys for the same company", async () => {
    const companyId = await seedCompany();
    await svc.create(companyId, { name: "Atlassian", command: "npx", args: ["-y", "x"] });

    await expect(
      svc.create(companyId, { name: "Atlassian", command: "npx", args: ["-y", "x"] }),
    ).rejects.toThrow(/already exists/i);
  });

  it("rejects env keys that do not match the convention", async () => {
    const companyId = await seedCompany();

    await expect(
      svc.create(companyId, {
        name: "Bad",
        command: "node",
        args: [],
        env: { "bad-key": { kind: "literal", value: "x" } },
      }),
    ).rejects.toThrow(/env key/i);
  });

  it("resolves runtime config with literals and secret references", async () => {
    const companyId = await seedCompany();
    const server = await svc.create(companyId, {
      name: "Atlassian",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-atlassian"],
      env: {
        ATLASSIAN_TOKEN: { kind: "secret_inline", value: "my-token-123" },
        REGION: { kind: "literal", value: "us-east-1" },
      },
    });

    const [resolved] = await svc.resolveRuntimeConfig(companyId, [server.id]);
    expect(resolved).toBeDefined();
    expect(resolved!.command).toBe("npx");
    expect(resolved!.env.REGION).toBe("us-east-1");
    expect(resolved!.env.ATLASSIAN_TOKEN).toBe("my-token-123");
  });

  it("skips disabled servers when resolving runtime config", async () => {
    const companyId = await seedCompany();
    const server = await svc.create(companyId, {
      name: "Filesystem",
      command: "npx",
      args: ["-y", "x"],
      enabled: false,
    });

    const resolved = await svc.resolveRuntimeConfig(companyId, [server.id]);
    expect(resolved).toEqual([]);
  });

  it("rejects creating a server referencing an unknown secret key", async () => {
    const companyId = await seedCompany();

    await expect(
      svc.create(companyId, {
        name: "Tooling",
        command: "node",
        args: [],
        env: { TOKEN: { kind: "secret", secretKey: "missing" } },
      }),
    ).rejects.toThrow(/does not exist/i);
  });

  it("updates env, command and enabled state in place", async () => {
    const companyId = await seedCompany();
    const server = await svc.create(companyId, {
      name: "Tooling",
      command: "node",
      args: ["server.js"],
      env: { LOG_LEVEL: { kind: "literal", value: "debug" } },
    });

    const patched = await svc.update(companyId, server.id, {
      command: "node",
      args: ["server-v2.js"],
      env: { LOG_LEVEL: { kind: "literal", value: "warn" } },
      enabled: false,
    });

    expect(patched.args).toEqual(["server-v2.js"]);
    expect(patched.envTemplate.LOG_LEVEL).toBe("warn");
    expect(patched.enabled).toBe(false);
  });

  it("delete returns the deleted row and removes it from the table", async () => {
    const companyId = await seedCompany();
    const server = await svc.create(companyId, {
      name: "Tooling",
      command: "node",
      args: [],
    });
    const removed = await svc.delete(companyId, server.id);
    expect(removed?.id).toBe(server.id);

    const after = await svc.list(companyId);
    expect(after).toEqual([]);
  });
});
