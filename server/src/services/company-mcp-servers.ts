import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companyMcpServers, companySecrets } from "@paperclipai/db";
import type {
  CompanyMcpServer,
  CompanyMcpServerCreateRequest,
  CompanyMcpServerListItem,
  CompanyMcpServerTestRequest,
  CompanyMcpServerTestResult,
  CompanyMcpServerUpdateRequest,
  McpServerEnvValueInput,
  McpServerTransport,
  ResolvedMcpServer,
} from "@paperclipai/shared";
import {
  buildSecretReference,
  parseSecretReference,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

type CompanyMcpServerRow = typeof companyMcpServers.$inferSelect;

const COMMAND_DENYLIST = new Set([
  "rm",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  "su",
  "sudo",
]);

const SLUG_RE = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$|^[a-z0-9]$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base || "mcp-server";
  if (!taken.has(candidate)) return candidate;
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

function assertSlug(value: string, field: string): void {
  if (!SLUG_RE.test(value)) {
    throw unprocessable(
      `${field} must match ^[a-z][a-z0-9-]+[a-z0-9]$ (got "${value}")`,
    );
  }
}

function assertEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw unprocessable(
      `Env key "${key}" must match ^[A-Z_][A-Z0-9_]*$`,
    );
  }
}

function assertCommandAllowed(command: string, args: readonly string[]): void {
  const trimmed = command.trim();
  if (!trimmed) throw unprocessable("Command is required.");
  const basename = trimmed.split(/[\\/]/).pop()!.toLowerCase();
  if (COMMAND_DENYLIST.has(basename)) {
    throw unprocessable(
      `Command "${command}" is not allowed for MCP servers. Wrap it in a dedicated binary or use a different transport.`,
    );
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw unprocessable("MCP server args must all be strings.");
    }
  }
  // Guard the most common shell-eval shortcuts even when the base command is harmless.
  if (args.some((arg) => arg === "-c" || arg === "--command")) {
    const base = basename;
    if (base.endsWith("sh") || base === "eval") {
      throw unprocessable(
        `Refusing MCP command "${command} ${args.join(" ")}" — shell evaluation is not allowed.`,
      );
    }
  }
}

function toCompanyMcpServer(row: CompanyMcpServerRow): CompanyMcpServer {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    transport: row.transport as McpServerTransport,
    command: row.command,
    args: row.args ?? [],
    envTemplate: row.envTemplate ?? {},
    enabled: row.enabled,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toListItem(server: CompanyMcpServer): CompanyMcpServerListItem {
  const envKeys = Object.keys(server.envTemplate).sort();
  const hasSecretReferences = envKeys.some(
    (key) => parseSecretReference(server.envTemplate[key] ?? "") !== null,
  );
  return {
    id: server.id,
    companyId: server.companyId,
    key: server.key,
    name: server.name,
    description: server.description,
    transport: server.transport,
    enabled: server.enabled,
    envKeys,
    hasSecretReferences,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}

export interface McpHandshakeResult {
  serverInfo?: { name?: string; version?: string };
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  tools: Array<{ name: string; description?: string }>;
  resources: Array<{ uri: string; name?: string }>;
}

async function runMcpHandshake(
  resolved: ResolvedMcpServer,
  timeoutMs: number,
): Promise<McpHandshakeResult> {
  return await new Promise<McpHandshakeResult>((resolve, reject) => {
    const child = spawn(resolved.command, resolved.args, {
      env: { ...process.env, ...resolved.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    const tools: McpHandshakeResult["tools"] = [];
    const resources: McpHandshakeResult["resources"] = [];
    let initInfo: McpHandshakeResult | null = null;
    let sentToolsList = false;
    let sentResourcesList = false;
    let receivedTools = false;
    let receivedResources = false;
    let settled = false;

    const timer = global.setTimeout(() => finish(new Error(`MCP handshake timed out after ${timeoutMs}ms`)), timeoutMs);

    function finish(err: Error | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* noop */
      }
      if (err) {
        reject(new Error(`${err.message}${stderrBuf ? ` (stderr: ${stderrBuf.trim().slice(0, 500)})` : ""}`));
      } else if (initInfo) {
        resolve({ ...initInfo, tools, resources });
      } else {
        reject(new Error("MCP handshake did not produce an initialize response."));
      }
    }

    function send(message: Record<string, unknown>) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (err) {
        finish(err as Error);
      }
    }

    child.on("error", (err) => finish(err));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`MCP server exited (code ${code}, signal ${signal ?? "none"}) before handshake completed.`));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      if (stderrBuf.length > 32_000) stderrBuf = stderrBuf.slice(-32_000);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let newlineIdx = stdoutBuf.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx).trim();
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        newlineIdx = stdoutBuf.indexOf("\n");
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = message.id;
        const result = message.result as Record<string, unknown> | undefined;
        if (id === 1 && result) {
          const serverInfo = result.serverInfo as { name?: string; version?: string } | undefined;
          initInfo = {
            serverInfo,
            protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : undefined,
            capabilities: (result.capabilities as Record<string, unknown> | undefined) ?? {},
            tools,
            resources,
          };
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          if (!sentToolsList) {
            sentToolsList = true;
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          }
          if (!sentResourcesList) {
            sentResourcesList = true;
            send({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
          }
        } else if (id === 2) {
          const listed = (result?.tools as Array<{ name?: string; description?: string }> | undefined) ?? [];
          for (const tool of listed) {
            if (typeof tool?.name === "string") {
              tools.push({ name: tool.name, description: tool.description });
            }
          }
          receivedTools = true;
        } else if (id === 3) {
          const listed = (result?.resources as Array<{ uri?: string; name?: string }> | undefined) ?? [];
          for (const resource of listed) {
            if (typeof resource?.uri === "string") {
              resources.push({ uri: resource.uri, name: resource.name });
            }
          }
          receivedResources = true;
        }
        if (initInfo && receivedTools && receivedResources) {
          finish(null);
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "paperclip-test-handshake", version: "0.1.0" },
      },
    });
  });
}

export function companyMcpServerService(db: Db) {
  const secrets = secretService(db);

  async function syncBindingsForServer(
    companyId: string,
    mcpServerId: string,
    envTemplate: Record<string, string>,
  ) {
    const refs: Array<{ secretId: string; configPath: string }> = [];
    for (const [envKey, value] of Object.entries(envTemplate)) {
      const secretKey = parseSecretReference(value);
      if (!secretKey) continue;
      const secretId = await findSecretIdByKey(companyId, secretKey);
      if (!secretId) {
        throw unprocessable(
          `Env ${envKey} references missing secret "${secretKey}".`,
        );
      }
      refs.push({ secretId, configPath: `env.${envKey}` });
    }
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "mcp_server", targetId: mcpServerId },
      refs,
    );
  }

  async function ensureCompanyExists(companyId: string) {
    const company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) {
      throw notFound(`Company ${companyId} not found`);
    }
  }

  async function findSecretIdByKey(companyId: string, key: string): Promise<string | null> {
    const row = await db
      .select({ id: companySecrets.id, status: companySecrets.status })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, key)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    if (row.status === "deleted") return null;
    return row.id;
  }

  async function listExistingSecretKeys(companyId: string): Promise<Set<string>> {
    const rows = await db
      .select({ key: companySecrets.key })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), ne(companySecrets.status, "deleted")));
    return new Set(rows.map((row) => row.key));
  }

  async function buildEnvTemplate(
    companyId: string,
    envInput: Record<string, McpServerEnvValueInput> | undefined,
    mcpKey: string,
    actor: { userId?: string | null; agentId?: string | null } | undefined,
  ): Promise<Record<string, string>> {
    if (!envInput) return {};
    const out: Record<string, string> = {};
    const existingKeys = await listExistingSecretKeys(companyId);

    for (const [envKey, raw] of Object.entries(envInput)) {
      assertEnvKey(envKey);

      let value: McpServerEnvValueInput;
      if (typeof raw === "string") {
        value = { kind: "literal", value: raw };
      } else {
        value = raw;
      }

      if (value.kind === "literal") {
        out[envKey] = value.value;
        continue;
      }

      if (value.kind === "secret") {
        const secretId = await findSecretIdByKey(companyId, value.secretKey);
        if (!secretId) {
          throw unprocessable(
            `Secret "${value.secretKey}" referenced by env ${envKey} does not exist.`,
          );
        }
        out[envKey] = buildSecretReference(value.secretKey);
        continue;
      }

      // secret_inline: materialize into companySecrets, then store reference.
      const baseSlug = normalizeKey(`mcp-${mcpKey}-${envKey}`);
      const secretKey = uniqueSlug(baseSlug, existingKeys);
      existingKeys.add(secretKey);
      await secrets.create(
        companyId,
        {
          name: secretKey,
          provider: "local_encrypted",
          value: value.value,
          key: secretKey,
          managedMode: "paperclip_managed",
          description: `Auto-created for MCP server "${mcpKey}" env ${envKey}.`,
        },
        actor,
      );
      out[envKey] = buildSecretReference(secretKey);
    }

    return out;
  }

  async function list(companyId: string): Promise<CompanyMcpServerListItem[]> {
    await ensureCompanyExists(companyId);
    const rows = await db
      .select()
      .from(companyMcpServers)
      .where(eq(companyMcpServers.companyId, companyId))
      .orderBy(asc(companyMcpServers.name));
    return rows.map((row) => toListItem(toCompanyMcpServer(row)));
  }

  async function getById(companyId: string, id: string): Promise<CompanyMcpServer | null> {
    const row = await db
      .select()
      .from(companyMcpServers)
      .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.id, id)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanyMcpServer(row) : null;
  }

  async function getByKey(companyId: string, key: string): Promise<CompanyMcpServer | null> {
    const row = await db
      .select()
      .from(companyMcpServers)
      .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.key, key)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanyMcpServer(row) : null;
  }

  async function create(
    companyId: string,
    input: CompanyMcpServerCreateRequest,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<CompanyMcpServer> {
    await ensureCompanyExists(companyId);

    const name = asString(input.name);
    if (!name) throw unprocessable("name is required");

    const command = asString(input.command);
    if (!command) throw unprocessable("command is required");

    const args = input.args ?? [];
    assertCommandAllowed(command, args);

    const desiredKey = asString(input.key ?? null) ?? normalizeKey(name);
    if (!desiredKey) throw unprocessable("Could not derive a key for the MCP server");
    assertSlug(desiredKey, "key");

    const existing = await getByKey(companyId, desiredKey);
    if (existing) {
      throw conflict(`MCP server "${desiredKey}" already exists in this company.`);
    }

    const transport = input.transport ?? "stdio";
    const envTemplate = await buildEnvTemplate(companyId, input.env, desiredKey, actor);

    const now = new Date();
    const row = await db
      .insert(companyMcpServers)
      .values({
        companyId,
        key: desiredKey,
        name,
        description: input.description ?? null,
        transport,
        command,
        args,
        envTemplate,
        enabled: input.enabled ?? true,
        metadata: input.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("Failed to insert MCP server");
    await syncBindingsForServer(companyId, row.id, envTemplate);
    return toCompanyMcpServer(row);
  }

  async function update(
    companyId: string,
    id: string,
    patch: CompanyMcpServerUpdateRequest,
    actor?: { userId?: string | null; agentId?: string | null },
  ): Promise<CompanyMcpServer> {
    const current = await getById(companyId, id);
    if (!current) throw notFound("MCP server not found");

    const next: Partial<typeof companyMcpServers.$inferInsert> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if (patch.name !== undefined) {
      const name = asString(patch.name);
      if (!name) throw unprocessable("name cannot be empty");
      next.name = name;
    }
    if (patch.description !== undefined) {
      next.description = patch.description ?? null;
    }
    if (patch.command !== undefined || patch.args !== undefined) {
      const command = asString(patch.command ?? current.command);
      if (!command) throw unprocessable("command cannot be empty");
      const args = patch.args ?? current.args;
      assertCommandAllowed(command, args);
      next.command = command;
      next.args = args;
    }
    if (patch.env !== undefined) {
      next.envTemplate = await buildEnvTemplate(companyId, patch.env, current.key, actor);
    }
    if (patch.enabled !== undefined) {
      next.enabled = patch.enabled;
    }
    if (patch.metadata !== undefined) {
      next.metadata = patch.metadata;
    }

    const updated = await db
      .update(companyMcpServers)
      .set(next)
      .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.id, id)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("MCP server not found");
    if (next.envTemplate !== undefined) {
      await syncBindingsForServer(companyId, updated.id, next.envTemplate);
    }
    return toCompanyMcpServer(updated);
  }

  async function remove(
    companyId: string,
    id: string,
  ): Promise<CompanyMcpServer | null> {
    const current = await getById(companyId, id);
    if (!current) return null;
    await secrets.syncSecretRefsForTarget(
      companyId,
      { targetType: "mcp_server", targetId: id },
      [],
    );
    await db
      .delete(companyMcpServers)
      .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.id, id)));
    return current;
  }

  async function resolveRuntimeConfig(
    companyId: string,
    mcpServerIds: string[],
  ): Promise<ResolvedMcpServer[]> {
    if (mcpServerIds.length === 0) return [];
    const seen = new Set<string>();
    const out: ResolvedMcpServer[] = [];

    for (const id of mcpServerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const server = await getById(companyId, id);
      if (!server) {
        throw notFound(`MCP server ${id} not found`);
      }
      if (!server.enabled) continue;

      const resolvedEnv: Record<string, string> = {};
      for (const [envKey, templateValue] of Object.entries(server.envTemplate)) {
        const secretKey = parseSecretReference(templateValue);
        if (!secretKey) {
          resolvedEnv[envKey] = templateValue;
          continue;
        }
        const secretId = await findSecretIdByKey(companyId, secretKey);
        if (!secretId) {
          throw unprocessable(
            `MCP server "${server.key}" env ${envKey} references missing secret "${secretKey}".`,
          );
        }
        resolvedEnv[envKey] = await secrets.resolveSecretValue(companyId, secretId, "latest", {
          consumerType: "mcp_server",
          consumerId: server.id,
          configPath: `env.${envKey}`,
        });
      }

      out.push({
        id: server.id,
        key: server.key,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: resolvedEnv,
      });
    }

    return out;
  }

  async function resolveRuntimeConfigSafe(
    companyId: string,
    mcpServerIds: string[],
  ): Promise<{ resolved: ResolvedMcpServer[]; warnings: string[] }> {
    const resolved: ResolvedMcpServer[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const id of mcpServerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const [server] = await resolveRuntimeConfig(companyId, [id]);
        if (server) resolved.push(server);
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
      }
    }
    return { resolved, warnings };
  }

  async function testHandshake(
    companyId: string,
    id: string,
    options: CompanyMcpServerTestRequest = {},
  ): Promise<CompanyMcpServerTestResult> {
    const server = await getById(companyId, id);
    if (!server) throw notFound("MCP server not found");
    if (!server.enabled) {
      throw unprocessable(`MCP server "${server.key}" is disabled. Enable it before testing.`);
    }
    const [resolved] = await resolveRuntimeConfig(companyId, [id]);
    if (!resolved) {
      throw unprocessable(`MCP server "${server.key}" could not be resolved for test.`);
    }
    const timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? 10_000));
    const startedAt = Date.now();
    try {
      const handshake = await runMcpHandshake(resolved, timeoutMs);
      return {
        ok: true,
        durationMs: Date.now() - startedAt,
        serverName: handshake.serverInfo?.name ?? null,
        serverVersion: handshake.serverInfo?.version ?? null,
        protocolVersion: handshake.protocolVersion ?? null,
        capabilities: handshake.capabilities ?? {},
        tools: handshake.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? null,
        })),
        resources: handshake.resources.map((resource) => ({
          uri: resource.uri,
          name: resource.name ?? null,
        })),
        warnings: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw unprocessable(`MCP handshake failed: ${message}`);
    }
  }

  return {
    list,
    getById,
    getByKey,
    create,
    update,
    delete: remove,
    resolveRuntimeConfig,
    resolveRuntimeConfigSafe,
    testHandshake,
    // Exported for tests so we can exercise validation without a DB.
    _internal: {
      assertCommandAllowed,
      buildEnvTemplate,
    },
  };
}

export { assertCommandAllowed };

