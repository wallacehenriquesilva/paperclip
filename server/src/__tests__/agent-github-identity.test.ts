import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentGithubIdentityService } from "../services/agent-github-identity.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent github identity tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbedded("agentGithubIdentityService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const tmpDir = path.join(os.tmpdir(), `paperclip-agent-github-identity-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(tmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-github-identity");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent-${randomUUID().slice(0, 6)}`,
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        metadata: {},
      })
      .returning();
    return agent!;
  }

  async function seedSecret(companyId: string, name = "github-pat") {
    const secrets = secretService(db);
    return await secrets.create(companyId, {
      name: `${name}-${randomUUID().slice(0, 6)}`,
      provider: "local_encrypted",
      value: "ghp_test_token_value",
    });
  }

  it("reports not_configured when no metadata.github exists", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const svc = agentGithubIdentityService(db);
    const view = await svc.read(agent.id);
    expect(view).not.toBeNull();
    expect(view!.status).toBe("not_configured");
    expect(view!.tokenSecretId).toBeNull();
    expect(view!.boundAtAdapterConfig).toBe(false);
  });

  it("set() mirrors identity to metadata.github AND adapter_config.env.GH_TOKEN", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const secret = await seedSecret(companyId);
    const svc = agentGithubIdentityService(db);

    const result = await svc.set(agent.id, {
      username: "paperclip-bot",
      userEmail: "bot@x.io",
      userName: "Paperclip Bot",
      tokenSecretId: secret.id,
    });

    expect(result.changeKind).toBe("connected");
    expect(result.view.status).toBe("connected");
    expect(result.view.boundAtAdapterConfig).toBe(true);
    expect(result.view.tokenSecretName).toBe(secret.name);

    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(stored!.metadata).toMatchObject({
      github: {
        username: "paperclip-bot",
        userEmail: "bot@x.io",
        userName: "Paperclip Bot",
        tokenSecretId: secret.id,
      },
    });
    const env = (stored!.adapterConfig as Record<string, unknown>)!.env as Record<string, unknown>;
    expect(env.GH_TOKEN).toMatchObject({ type: "secret_ref", secretId: secret.id });
    expect(env.GITHUB_TOKEN).toMatchObject({ type: "secret_ref", secretId: secret.id });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agent.id));
    expect(bindings.map((b) => b.configPath).sort()).toEqual(["env.GH_TOKEN", "env.GITHUB_TOKEN"]);
  });

  it("set() with existing identity reports 'updated'", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const secret = await seedSecret(companyId);
    const svc = agentGithubIdentityService(db);
    await svc.set(agent.id, {
      username: "v1",
      userEmail: "a@x.io",
      userName: "A",
      tokenSecretId: secret.id,
    });

    const second = await svc.set(agent.id, {
      username: "v2",
      userEmail: "b@x.io",
      userName: "B",
      tokenSecretId: secret.id,
    });
    expect(second.changeKind).toBe("updated");
    expect(second.view.username).toBe("v2");
    expect(second.view.userEmail).toBe("b@x.io");
  });

  it("clear() removes metadata.github AND GH_TOKEN/GITHUB_TOKEN secret refs", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const secret = await seedSecret(companyId);
    const svc = agentGithubIdentityService(db);
    await svc.set(agent.id, {
      username: "bot",
      userEmail: "bot@x.io",
      userName: "Bot",
      tokenSecretId: secret.id,
    });

    const result = await svc.clear(agent.id);
    expect(result.changeKind).toBe("disconnected");
    expect(result.view.status).toBe("not_configured");

    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect((stored!.metadata as Record<string, unknown>)?.github).toBeUndefined();
    const env = (stored!.adapterConfig as Record<string, unknown>)?.env as Record<string, unknown>;
    expect(env?.GH_TOKEN).toBeUndefined();
    expect(env?.GITHUB_TOKEN).toBeUndefined();

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agent.id));
    expect(bindings).toHaveLength(0);
  });

  it("clear() on never-configured agent reports 'noop'", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const svc = agentGithubIdentityService(db);
    const result = await svc.clear(agent.id);
    expect(result.changeKind).toBe("noop");
  });

  it("rejects tokenSecretId from another company", async () => {
    const otherCompanyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const otherSecret = await seedSecret(otherCompanyId, "foreign");
    const agent = await seedAgent(targetCompanyId);
    const svc = agentGithubIdentityService(db);

    await expect(
      svc.set(agent.id, {
        username: "bot",
        userEmail: "bot@x.io",
        userName: "Bot",
        tokenSecretId: otherSecret.id,
      }),
    ).rejects.toThrow(/does not reference a company secret/);
  });

  it("rejects empty input payloads", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const svc = agentGithubIdentityService(db);
    await expect(svc.set(agent.id, { username: "" })).rejects.toThrow(/empty/);
    await expect(svc.set(agent.id, { tokenSecretId: "   " })).rejects.toThrow(/empty/);
  });

  it("incomplete identity surfaces as 'incomplete' status", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const secret = await seedSecret(companyId);
    const svc = agentGithubIdentityService(db);
    const result = await svc.set(agent.id, {
      username: "bot",
      tokenSecretId: secret.id,
    });
    expect(result.view.status).toBe("incomplete");
  });

  it("preserves other env entries when setting GH_TOKEN", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    await db
      .update(agents)
      .set({ adapterConfig: { env: { CUSTOM_THING: "keep-me" } } })
      .where(eq(agents.id, agent.id));
    const secret = await seedSecret(companyId);
    const svc = agentGithubIdentityService(db);
    await svc.set(agent.id, {
      username: "bot",
      userEmail: "bot@x.io",
      userName: "Bot",
      tokenSecretId: secret.id,
    });
    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const env = (stored!.adapterConfig as Record<string, unknown>).env as Record<string, unknown>;
    expect(env.CUSTOM_THING).toBe("keep-me");
    expect(env.GH_TOKEN).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("preserves other env entries when clearing identity", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const secret = await seedSecret(companyId);
    const svc = agentGithubIdentityService(db);
    await svc.set(agent.id, {
      username: "bot",
      userEmail: "bot@x.io",
      userName: "Bot",
      tokenSecretId: secret.id,
    });
    // Add an unrelated env entry directly
    const [beforeClear] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const beforeEnv = (beforeClear!.adapterConfig as Record<string, unknown>).env as Record<string, unknown>;
    await db
      .update(agents)
      .set({ adapterConfig: { env: { ...beforeEnv, OTHER: "stay" } } })
      .where(eq(agents.id, agent.id));

    await svc.clear(agent.id);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const env = (stored!.adapterConfig as Record<string, unknown>).env as Record<string, unknown>;
    expect(env.OTHER).toBe("stay");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("test() returns no_token when nothing is configured", async () => {
    const companyId = await seedCompany();
    const agent = await seedAgent(companyId);
    const svc = agentGithubIdentityService(db);
    const result = await svc.test(agent.id);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("no_token");
  });
});
