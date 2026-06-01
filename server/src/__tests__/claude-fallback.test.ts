import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  applyClaudeFallbackPostRun,
  readActiveClaudeFallbackState,
  readClaudeFallbackAdapterConfig,
  resolveClaudeFallbackEnvInjection,
} from "../services/claude-fallback.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping claude-fallback tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describe("readActiveClaudeFallbackState (pure)", () => {
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  const pastIso = new Date(Date.now() - 60_000).toISOString();

  it("returns null when metadata is missing or unrelated", () => {
    expect(readActiveClaudeFallbackState({ metadata: null })).toBeNull();
    expect(readActiveClaudeFallbackState({ metadata: {} })).toBeNull();
    expect(readActiveClaudeFallbackState({ metadata: { other: "x" } })).toBeNull();
  });

  it("returns null when untilIso is in the past (expired)", () => {
    expect(
      readActiveClaudeFallbackState({
        metadata: { claudeFallback: { untilIso: pastIso, reason: "session_limit" } },
      }),
    ).toBeNull();
  });

  it("returns the state when untilIso is in the future", () => {
    const state = readActiveClaudeFallbackState({
      metadata: {
        claudeFallback: {
          untilIso: futureIso,
          reason: "session_limit",
          activatedAt: "2026-05-29T10:00:00Z",
          triggerRunId: "run-1",
        },
      },
    });
    expect(state).toMatchObject({
      untilIso: futureIso,
      reason: "session_limit",
      triggerRunId: "run-1",
    });
  });
});

describe("readClaudeFallbackAdapterConfig (pure)", () => {
  it("returns null when claudeFallback is missing", () => {
    expect(readClaudeFallbackAdapterConfig(null)).toBeNull();
    expect(readClaudeFallbackAdapterConfig({})).toBeNull();
  });

  it("returns the parsed config including disabled state", () => {
    expect(
      readClaudeFallbackAdapterConfig({
        claudeFallback: { enabled: false, apiKeySecretRef: "${secret:foo}" },
      }),
    ).toEqual({ enabled: false, apiKeySecretRef: "${secret:foo}" });
  });

  it("returns enabled=true when configured", () => {
    expect(
      readClaudeFallbackAdapterConfig({
        claudeFallback: { enabled: true, apiKeySecretRef: "${secret:anthropic}" },
      }),
    ).toEqual({ enabled: true, apiKeySecretRef: "${secret:anthropic}" });
  });
});

describeEmbeddedPostgres("claude-fallback (DB-integrated)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Acme",
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<{
      adapterType: string;
      adapterConfig: Record<string, unknown>;
      metadata: Record<string, unknown> | null;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "ClaudeAgent",
      role: "engineer",
      status: "active",
      adapterType: overrides.adapterType ?? "claude_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
      metadata: overrides.metadata ?? null,
    });
    return id;
  }

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("claude-fallback");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companySecrets);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  describe("resolveClaudeFallbackEnvInjection", () => {
    it("returns null when fallback state is not present", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

      const result = await resolveClaudeFallbackEnvInjection({
        agent,
        secretsSvc: { resolveSecretValue: vi.fn() } as any,
        db,
      });
      expect(result).toBeNull();
    });

    it("returns null when fallback state has expired", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        adapterConfig: { claudeFallback: { enabled: true, apiKeySecretRef: "${secret:k}" } },
        metadata: { claudeFallback: { untilIso: pastIso, reason: "session_limit" } },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

      const result = await resolveClaudeFallbackEnvInjection({
        agent,
        secretsSvc: { resolveSecretValue: vi.fn() } as any,
        db,
      });
      expect(result).toBeNull();
    });

    it("returns null when adapter is not claude_local", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        adapterType: "codex_local",
        adapterConfig: { claudeFallback: { enabled: true, apiKeySecretRef: "${secret:k}" } },
        metadata: { claudeFallback: { untilIso: futureIso, reason: "session_limit" } },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

      const result = await resolveClaudeFallbackEnvInjection({
        agent,
        secretsSvc: { resolveSecretValue: vi.fn() } as any,
        db,
      });
      expect(result).toBeNull();
    });

    it("returns null when adapterConfig.claudeFallback is disabled", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        adapterConfig: { claudeFallback: { enabled: false, apiKeySecretRef: "${secret:k}" } },
        metadata: { claudeFallback: { untilIso: futureIso, reason: "session_limit" } },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

      const result = await resolveClaudeFallbackEnvInjection({
        agent,
        secretsSvc: { resolveSecretValue: vi.fn() } as any,
        db,
      });
      expect(result).toBeNull();
    });

    it("resolves the secret and returns the API key when active + configured", async () => {
      const companyId = await seedCompany();
      const secretId = randomUUID();
      await db.insert(companySecrets).values({
        id: secretId,
        companyId,
        key: "anthropic-api-key",
        name: "anthropic-api-key",
        provider: "local_encrypted",
        status: "active",
        managedMode: "paperclip_managed",
        latestVersion: 1,
      });
      const agentId = await seedAgent(companyId, {
        adapterConfig: {
          claudeFallback: { enabled: true, apiKeySecretRef: "${secret:anthropic-api-key}" },
        },
        metadata: { claudeFallback: { untilIso: futureIso, reason: "session_limit" } },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      const resolveSecretValue = vi.fn().mockResolvedValue("sk-ant-resolved-key");

      const result = await resolveClaudeFallbackEnvInjection({
        agent,
        secretsSvc: { resolveSecretValue } as any,
        db,
      });
      expect(result?.apiKey).toBe("sk-ant-resolved-key");
      expect(resolveSecretValue).toHaveBeenCalledWith(
        companyId,
        secretId,
        "latest",
        expect.objectContaining({ consumerType: "agent" }),
      );
    });
  });

  describe("applyClaudeFallbackPostRun", () => {
    it("activates fallback when adapter signals it: persists metadata, logs, enqueues wakeup, returns fallbackActivated=true", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        adapterConfig: {
          claudeFallback: { enabled: true, apiKeySecretRef: "${secret:k}" },
        },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      const enqueueWakeup = vi.fn().mockResolvedValue({ id: "wake-1" });

      const result = await applyClaudeFallbackPostRun({
        db,
        agent,
        adapterResult: {
          errorMeta: {
            claudeFallbackActivation: {
              untilIso: futureIso,
              reason: "session_limit",
              triggerRunId: "run-from-adapter",
            },
          },
        },
        triggerRunId: "outer-run-id",
        actions: { enqueueWakeup },
      });

      // The heartbeat uses this return flag to SKIP scheduleBoundedRetryForRun,
      // which would otherwise honor retryNotBefore and stall the next run
      // until the subscription reset time.
      expect(result).toEqual({ fallbackActivated: true, fallbackDeactivated: false });

      const updated = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      const persisted = (updated.metadata as Record<string, unknown>)?.claudeFallback as Record<string, unknown>;
      expect(persisted).toMatchObject({
        untilIso: futureIso,
        reason: "session_limit",
        triggerRunId: "run-from-adapter",
      });
      expect(typeof persisted.activatedAt).toBe("string");

      const activities = await db.select().from(activityLog);
      const activation = activities.find((a) => a.action === "claude.fallback_activated");
      expect(activation).toBeDefined();
      expect((activation!.details as Record<string, unknown>).untilIso).toBe(futureIso);

      expect(enqueueWakeup).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({
          source: "automation",
          reason: "claude_fallback_activated",
        }),
      );
    });

    it("clears metadata + logs deactivation when fallback has expired and adapter signaled nothing new", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, {
        metadata: {
          claudeFallback: {
            untilIso: pastIso,
            reason: "session_limit",
            activatedAt: "2026-05-29T10:00:00Z",
            triggerRunId: "previous-run",
          },
        },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      const enqueueWakeup = vi.fn();

      const result = await applyClaudeFallbackPostRun({
        db,
        agent,
        adapterResult: { errorMeta: undefined },
        triggerRunId: "any-run",
        actions: { enqueueWakeup },
      });
      expect(result).toEqual({ fallbackActivated: false, fallbackDeactivated: true });

      const updated = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      const persisted = (updated.metadata as Record<string, unknown> | null)?.claudeFallback;
      expect(persisted).toBeUndefined();

      const activities = await db.select().from(activityLog);
      const deact = activities.find((a) => a.action === "claude.fallback_deactivated");
      expect(deact).toBeDefined();
      expect(enqueueWakeup).not.toHaveBeenCalled();
    });

    it("does nothing on a normal run when fallback is still active (untilIso in the future)", async () => {
      const companyId = await seedCompany();
      const initialState = {
        untilIso: futureIso,
        reason: "session_limit",
        activatedAt: "2026-05-29T10:00:00Z",
        triggerRunId: "run-1",
      };
      const agentId = await seedAgent(companyId, {
        metadata: { claudeFallback: initialState },
      });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

      await applyClaudeFallbackPostRun({
        db,
        agent,
        adapterResult: { errorMeta: undefined },
        triggerRunId: "x",
        actions: { enqueueWakeup: vi.fn() },
      });

      const updated = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      const persisted = (updated.metadata as Record<string, unknown>)?.claudeFallback;
      expect(persisted).toMatchObject(initialState);

      const activities = await db.select().from(activityLog);
      expect(activities).toHaveLength(0);
    });

    it("is a no-op when adapter is not claude_local", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId, { adapterType: "codex_local" });
      const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;

      await applyClaudeFallbackPostRun({
        db,
        agent,
        adapterResult: {
          errorMeta: {
            claudeFallbackActivation: { untilIso: futureIso, reason: "session_limit" },
          },
        },
        triggerRunId: "x",
        actions: { enqueueWakeup: vi.fn() },
      });

      const updated = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      expect(updated.metadata).toBeNull();
      const activities = await db.select().from(activityLog);
      expect(activities).toHaveLength(0);
    });
  });
});
