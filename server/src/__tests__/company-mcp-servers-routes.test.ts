import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMcpServers,
  companySecretBindings,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyMcpServerRoutes } from "../routes/company-mcp-servers.ts";
import { errorHandler } from "../middleware/error-handler.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres MCP route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyMcpServerRoutes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: Express;
  let companyId!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("mcp-routes");
    stopDb = started.stop;
    db = createDb(started.connectionString);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { actor?: unknown }).actor = {
        type: "board",
        userId: "local-board",
        companyIds: ["__all__"],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", companyMcpServerRoutes(db));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await db.delete(companySecretBindings);
    await db.delete(companyMcpServers);
    await db.delete(activityLog);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(): Promise<string> {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("creates, lists, fetches, updates and deletes an MCP server", async () => {
    const id = await seedCompany();

    const created = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({
        name: "Filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { LOG_LEVEL: "info" },
      });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("filesystem");
    expect(created.body.envTemplate).toEqual({ LOG_LEVEL: "info" });

    const list = await request(app).get(`/api/companies/${id}/mcp-servers`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      key: "filesystem",
      envKeys: ["LOG_LEVEL"],
      hasSecretReferences: false,
    });

    const detail = await request(app).get(`/api/companies/${id}/mcp-servers/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.command).toBe("npx");

    const patched = await request(app)
      .patch(`/api/companies/${id}/mcp-servers/${created.body.id}`)
      .send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body.enabled).toBe(false);

    const removed = await request(app)
      .delete(`/api/companies/${id}/mcp-servers/${created.body.id}`);
    expect(removed.status).toBe(200);

    const listAfter = await request(app).get(`/api/companies/${id}/mcp-servers`);
    expect(listAfter.body).toEqual([]);
  });

  it("rejects creation with denylisted commands", async () => {
    const id = await seedCompany();
    const res = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({ name: "BadShell", command: "bash", args: ["-c", "ls"] });
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/shell evaluation|not allowed/i);
  });

  it("rejects invalid env keys with 400", async () => {
    const id = await seedCompany();
    const res = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({
        name: "Bad",
        command: "node",
        env: { "bad-key": { kind: "literal", value: "x" } },
      });
    expect(res.status).toBe(400);
  });

  it("materializes inline secrets and persists secret bindings", async () => {
    const id = await seedCompany();
    const res = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({
        name: "Atlassian",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-atlassian"],
        env: {
          ATLASSIAN_TOKEN: { kind: "secret_inline", value: "rotate-me" },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.envTemplate.ATLASSIAN_TOKEN).toMatch(/^\$\{secret:/);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.companyId, id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.configPath).toBe("env.ATLASSIAN_TOKEN");
    expect(bindings[0]!.targetType).toBe("mcp_server");
  });

  it("returns 404 when fetching unknown server", async () => {
    const id = await seedCompany();
    const res = await request(app).get(`/api/companies/${id}/mcp-servers/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("returns 409 on duplicate key", async () => {
    const id = await seedCompany();
    await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({ name: "Atlassian", command: "npx", args: ["-y", "x"] });
    const dup = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({ name: "Atlassian", command: "npx", args: ["-y", "x"] });
    expect(dup.status).toBe(409);
  });

  it("writes activity log entries for mutating endpoints", async () => {
    const id = await seedCompany();
    const created = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({ name: "Test", command: "node", args: ["server.js"] });
    expect(created.status).toBe(201);

    await request(app)
      .patch(`/api/companies/${id}/mcp-servers/${created.body.id}`)
      .send({ enabled: false });

    await request(app).delete(`/api/companies/${id}/mcp-servers/${created.body.id}`);

    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, id));
    const actions = entries.map((entry) => entry.action).sort();
    expect(actions).toEqual([
      "company.mcp_server_created",
      "company.mcp_server_deleted",
      "company.mcp_server_updated",
    ]);
  });

  it("test endpoint reports failure when the command cannot start", async () => {
    const id = await seedCompany();
    const created = await request(app)
      .post(`/api/companies/${id}/mcp-servers`)
      .send({
        name: "Missing",
        command: "/nonexistent/binary/paperclip-mcp",
        args: [],
      });
    expect(created.status).toBe(201);

    const test = await request(app)
      .post(`/api/companies/${id}/mcp-servers/${created.body.id}/test`)
      .send({ timeoutMs: 1500 });
    expect(test.status).toBe(422);
    expect(String(test.body.error)).toMatch(/handshake failed/i);
  });
});
