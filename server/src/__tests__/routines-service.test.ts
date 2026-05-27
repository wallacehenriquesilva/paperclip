import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import * as providerRegistry from "../secrets/provider-registry.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const originalSecretsProviderEnv = process.env.PAPERCLIP_SECRETS_PROVIDER;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routines service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type FirePublicTriggerResult = Awaited<ReturnType<ReturnType<typeof routineService>["firePublicTrigger"]>>;

function expectRunResult(result: FirePublicTriggerResult) {
  expect(result.kind).toBe("run");
  if (result.kind !== "run") throw new Error(`expected run result, got ${result.kind}`);
  return result.run;
}

describeEmbeddedPostgres("routine service live-execution coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (originalSecretsProviderEnv === undefined) {
      delete process.env.PAPERCLIP_SECRETS_PROVIDER;
    } else {
      process.env.PAPERCLIP_SECRETS_PROVIDER = originalSecretsProviderEnv;
    }
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts?: {
    wakeup?: (
      agentId: string,
      wakeupOpts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      },
    ) => Promise<unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeups: Array<{
      agentId: string;
      opts: {
        source?: string;
        triggerDetail?: string;
        reason?: string | null;
        payload?: Record<string, unknown> | null;
        requestedByActorType?: "user" | "agent" | "system";
        requestedByActorId?: string | null;
        contextSnapshot?: Record<string, unknown>;
      };
    }> = [];

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: {
        wakeup: async (wakeupAgentId, wakeupOpts) => {
          wakeups.push({ agentId: wakeupAgentId, opts: wakeupOpts });
          if (opts?.wakeup) return opts.wakeup(wakeupAgentId, wakeupOpts);
          const issueId =
            (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
            (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const queuedRunId = randomUUID();
          await db.insert(heartbeatRuns).values({
            id: queuedRunId,
            companyId,
            agentId: wakeupAgentId,
            invocationSource: wakeupOpts.source ?? "assignment",
            triggerDetail: wakeupOpts.triggerDetail ?? null,
            status: "queued",
            contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
          });
          await db
            .update(issues)
            .set({
              executionRunId: queuedRunId,
              executionLockedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
          return { id: queuedRunId };
        },
      },
    });
    const issueSvc = issueService(db);
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ascii frog",
        description: "Run the frog routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, issueSvc, projectId, routine, svc, wakeups };
  }

  it("filters listed routines by project", async () => {
    const { companyId, agentId, projectId, routine, svc } = await seedFixture();
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other routines",
      status: "in_progress",
    });
    const otherRoutine = await svc.create(
      companyId,
      {
        projectId: otherProjectId,
        goalId: null,
        parentIssueId: null,
        title: "other project routine",
        description: null,
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const projectRoutines = await svc.list(companyId, { projectId });
    const allRoutines = await svc.list(companyId);

    expect(projectRoutines.map((entry) => entry.id)).toEqual([routine.id]);
    expect(allRoutines.map((entry) => entry.id)).toEqual(expect.arrayContaining([routine.id, otherRoutine.id]));
  });

  it("creates a fresh execution issue when the previous routine issue is open but idle", async () => {
    const { companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "todo",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
      completedAt: new Date("2026-03-20T12:00:00.000Z"),
    });

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue).toBeNull();

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).not.toBe(previousIssue.id);

    const routineIssues = await db
      .select({
        id: issues.id,
        originRunId: issues.originRunId,
      })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.id)).toContain(previousIssue.id);
    expect(routineIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("creates draft routines without a project or default assignee", async () => {
    const { companyId, svc } = await seedFixture();

    const routine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: "No defaults yet",
        assigneeAgentId: null,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    expect(routine.projectId).toBeNull();
    expect(routine.assigneeAgentId).toBeNull();
    expect(routine.status).toBe("paused");
  });

  it("creates revision 1 on routine create and appends revisions for real updates only", async () => {
    const { routine, svc } = await seedFixture();

    const initialRevisions = await svc.listRevisions(routine.id);
    expect(initialRevisions).toHaveLength(1);
    expect(initialRevisions[0]).toMatchObject({
      id: routine.latestRevisionId,
      revisionNumber: 1,
      title: "ascii frog",
      changeSummary: "Created routine",
    });
    expect(initialRevisions[0]?.snapshot.routine.description).toBe("Run the frog routine");

    const updated = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: routine.latestRevisionId,
      },
      {},
    );
    expect(updated?.latestRevisionNumber).toBe(2);
    expect(updated?.latestRevisionId).not.toBe(routine.latestRevisionId);

    const noOp = await svc.update(
      routine.id,
      {
        description: "Run the frog routine with logs",
        baseRevisionId: updated?.latestRevisionId,
      },
      {},
    );
    expect(noOp?.latestRevisionId).toBe(updated?.latestRevisionId);
    expect(noOp?.latestRevisionNumber).toBe(2);

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
    expect(revisions[0]?.snapshot.routine.description).toBe("Run the frog routine with logs");
    expect(revisions[1]?.snapshot.routine.description).toBe("Run the frog routine");
  });

  it("rejects stale routine baseRevisionId updates", async () => {
    const { routine, svc } = await seedFixture();
    const updated = await svc.update(routine.id, { description: "new description" }, {});
    await expect(
      svc.update(routine.id, {
        title: "stale update",
        baseRevisionId: routine.latestRevisionId,
      }, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: updated?.latestRevisionId,
      },
    });
  });

  it("restores an older routine revision append-only and preserves run history", async () => {
    const { routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    const run = await svc.runRoutine(routine.id, { source: "manual" });
    const revision2Routine = await svc.update(routine.id, { description: "revision 2" }, {});

    const restored = await svc.restoreRevision(routine.id, revision1Id, {});

    expect(restored.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.restoredFromRevisionNumber).toBe(1);
    expect(restored.routine.latestRevisionNumber).toBe(3);
    expect(restored.routine.latestRevisionId).not.toBe(revision2Routine?.latestRevisionId);
    expect(restored.routine.description).toBe("Run the frog routine");
    expect(restored.revision.restoredFromRevisionId).toBe(revision1Id);
    expect(restored.revision.snapshot.routine.description).toBe("Run the frog routine");

    const revisions = await svc.listRevisions(routine.id);
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([3, 2, 1]);
    await expect(db.select().from(routineRuns).where(eq(routineRuns.id, run.id))).resolves.toHaveLength(1);
  });

  it("rejects restoring the current latest routine revision", async () => {
    const { routine, svc } = await seedFixture();

    await expect(
      svc.restoreRevision(routine.id, routine.latestRevisionId!, {}),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        currentRevisionId: routine.latestRevisionId,
      },
    });
  });

  it("recreates deleted webhook trigger secrets when restoring a historical revision", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    await svc.deleteTrigger(created.trigger.id, {});

    const restored = await svc.restoreRevision(routine.id, created.revision.id, {});

    expect(restored.secretMaterials).toHaveLength(1);
    expect(restored.secretMaterials[0]).toMatchObject({
      triggerId: created.trigger.id,
    });
    expect(restored.secretMaterials[0]?.webhookSecret).toBeTruthy();
    expect(restored.secretMaterials[0]?.webhookUrl).toContain("/api/routine-triggers/public/");

    const restoredTrigger = await svc.getTrigger(created.trigger.id);
    expect(restoredTrigger?.secretId).toBeTruthy();
    expect(restoredTrigger?.publicId).toBeTruthy();
    expect(restoredTrigger?.publicId).not.toBe(created.trigger.publicId);
  });

  it("blocks agents from restoring routine revisions assigned to another agent", async () => {
    const { companyId, routine, svc } = await seedFixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const revision1Id = routine.latestRevisionId!;

    await svc.update(routine.id, { assigneeAgentId: otherAgentId }, {});

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { agentId: otherAgentId }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agents can only restore routine revisions assigned to themselves",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      assigneeAgentId: otherAgentId,
      latestRevisionNumber: 2,
    });
  });

  it("blocks restoring routine revisions assigned to agents that are no longer assignable", async () => {
    const { agentId, routine, svc } = await seedFixture();
    const revision1Id = routine.latestRevisionId!;
    await svc.update(routine.id, { description: "revision 2" }, {});
    await db
      .update(agents)
      .set({ status: "terminated" })
      .where(eq(agents.id, agentId));

    await expect(
      svc.restoreRevision(routine.id, revision1Id, { userId: "board-user" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Cannot assign routines to terminated agents",
    });
    await expect(svc.get(routine.id)).resolves.toMatchObject({
      description: "revision 2",
      latestRevisionNumber: 2,
    });
  });

  it("appends safe trigger metadata revisions without leaking webhook secrets", async () => {
    const { routine, svc } = await seedFixture();
    const created = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    expect(created.revision.revisionNumber).toBe(2);
    expect(created.secretMaterial?.webhookSecret).toBeTruthy();

    const updated = await svc.updateTrigger(created.trigger.id, { label: "deploy hook" }, {});
    expect(updated?.revision.revisionNumber).toBe(3);

    const rotated = await svc.rotateTriggerSecret(created.trigger.id, {});
    expect(rotated.revision.revisionNumber).toBe(4);
    expect(rotated.secretMaterial.webhookSecret).toBeTruthy();

    const deleted = await svc.deleteTrigger(created.trigger.id, {});
    expect(deleted.revision?.revisionNumber).toBe(5);

    const revisions = await svc.listRevisions(routine.id);
    const serialized = JSON.stringify(revisions.map((revision) => revision.snapshot));
    expect(serialized).toContain(created.trigger.publicId!);
    expect(serialized).not.toContain(created.secretMaterial!.webhookSecret);
    expect(serialized).not.toContain(rotated.secretMaterial.webhookSecret);
    expect(serialized).not.toContain(created.trigger.secretId!);
    expect(revisions[0]?.snapshot.triggers).toHaveLength(0);
  });

  it("wakes the assignee when a routine creates a fresh execution issue", async () => {
    const { agentId, routine, svc, wakeups } = await seedFixture();

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    expect(wakeups).toEqual([
      {
        agentId,
        opts: {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: run.linkedIssueId, mutation: "create" },
          requestedByActorType: undefined,
          requestedByActorId: null,
          contextSnapshot: { issueId: run.linkedIssueId, source: "routine.dispatch" },
        },
      },
    ]);
  });

  it("records the manual board runner on fresh routine issues so they appear in that user's inbox", async () => {
    const { companyId, agentId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
    const [createdIssue] = await db
      .select({
        id: issues.id,
        assigneeAgentId: issues.assigneeAgentId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(createdIssue).toMatchObject({
      id: run.linkedIssueId,
      assigneeAgentId: agentId,
      createdByUserId: userId,
    });

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(run.linkedIssueId);
  });

  it("waits for the assignee wakeup to be queued before returning the routine run", async () => {
    let wakeupResolved = false;
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        wakeupResolved = true;
        return null;
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("issue_created");
    expect(wakeupResolved).toBe(true);
  });

  it("coalesces only when the existing routine issue has a live execution run", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });

    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });

    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));

    const detailBefore = await svc.getDetail(routine.id);
    expect(detailBefore?.activeIssue?.id).toBe(previousIssue.id);

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    expect(run.coalescedIntoRunId).toBe(previousRunId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
    expect(routineIssues[0]?.id).toBe(previousIssue.id);
  });

  it("touches a coalesced routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();
    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("coalesced");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("touches a skipped active routine issue for the manual runner's inbox", async () => {
    const { agentId, companyId, issueSvc, routine, svc } = await seedFixture();
    const userId = randomUUID();
    const previousRunId = randomUUID();
    const liveHeartbeatRunId = randomUUID();

    await db
      .update(routines)
      .set({ concurrencyPolicy: "skip_if_active" })
      .where(eq(routines.id, routine.id));

    const previousIssue = await issueSvc.create(companyId, {
      projectId: routine.projectId,
      title: routine.title,
      description: routine.description,
      status: "in_progress",
      priority: routine.priority,
      assigneeAgentId: routine.assigneeAgentId,
      originKind: "routine_execution",
      originId: routine.id,
      originRunId: previousRunId,
    });

    await db.insert(routineRuns).values({
      id: previousRunId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "issue_created",
      triggeredAt: new Date("2026-03-20T12:00:00.000Z"),
      linkedIssueId: previousIssue.id,
    });
    await db.insert(heartbeatRuns).values({
      id: liveHeartbeatRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: previousIssue.id },
      startedAt: new Date("2026-03-20T12:01:00.000Z"),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: liveHeartbeatRunId,
        executionRunId: liveHeartbeatRunId,
        executionLockedAt: new Date("2026-03-20T12:01:00.000Z"),
      })
      .where(eq(issues.id, previousIssue.id));
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: previousIssue.id,
      userId,
      archivedAt: new Date("2026-03-20T12:02:00.000Z"),
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" }, { userId });

    expect(run.status).toBe("skipped");
    expect(run.linkedIssueId).toBe(previousIssue.id);
    await expect(
      db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, previousIssue.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(issueReadStates).where(eq(issueReadStates.issueId, previousIssue.id)),
    ).resolves.toEqual([
      expect.objectContaining({
        companyId,
        issueId: previousIssue.id,
        userId,
      }),
    ]);

    const inboxIssues = await issueSvc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
      includeRoutineExecutions: true,
    });
    expect(inboxIssues.map((issue) => issue.id)).toContain(previousIssue.id);
  });

  it("does not coalesce live routine runs with different resolved variables", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "pre-pr for {{branch}}",
        description: "Create a pre-PR from {{branch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "branch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const first = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/a" },
    });
    const second = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { branch: "feature/b" },
    });

    expect(first.status).toBe("issue_created");
    expect(second.status).toBe("issue_created");
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).not.toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        originFingerprint: issues.originFingerprint,
      })
      .from(issues)
      .where(eq(issues.originId, variableRoutine.id));

    expect(routineIssues).toHaveLength(2);
    expect(routineIssues.map((issue) => issue.title).sort()).toEqual([
      "pre-pr for feature/a",
      "pre-pr for feature/b",
    ]);
    expect(new Set(routineIssues.map((issue) => issue.originFingerprint)).size).toBe(2);
  });

  it("interpolates routine variables into the execution issue and stores resolved values", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage for {{repo}}",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
          { name: "priority", label: null, type: "select", defaultValue: "high", required: true, options: ["high", "low"] },
        ],
      },
      {},
    );
    expect(variableRoutine.variables.map((variable) => variable.name)).toEqual(["repo", "priority"]);

    const run = await svc.runRoutine(variableRoutine.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("repo triage for paperclip");
    expect(storedIssue?.description).toBe("Review paperclip for high bugs");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });
  });

  it("attaches the selected execution workspace to manually triggered routine issues", async () => {
    const { companyId, projectId, routine, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });

    const run = await svc.runRoutine(routine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });

  it("auto-populates workspaceBranch from a reused isolated workspace", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
      branchName: "pap-1634-routine-branch",
    });

    const branchRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Review {{workspaceBranch}}",
        description: "Use branch {{workspaceBranch}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "workspaceBranch", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    const run = await svc.runRoutine(branchRoutine.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const storedIssue = await db
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);
    const storedRun = await db
      .select({ triggerPayload: routineRuns.triggerPayload })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue?.title).toBe("Review pap-1634-routine-branch");
    expect(storedIssue?.description).toBe("Use branch pap-1634-routine-branch");
    expect(storedRun?.triggerPayload).toEqual({
      variables: {
        workspaceBranch: "pap-1634-routine-branch",
      },
    });
  });

  it("runs draft routines with one-off agent and project overrides", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft dispatch",
        description: "Pick defaults at run time",
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    const run = await svc.runRoutine(draftRoutine.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const storedIssue = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!))
      .then((rows) => rows[0] ?? null);

    expect(storedIssue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("rejects enabling automation for routines without a default agent", async () => {
    const { companyId, svc } = await seedFixture();
    const draftRoutine = await svc.create(
      companyId,
      {
        projectId: null,
        goalId: null,
        parentIssueId: null,
        title: "draft routine",
        description: null,
        assigneeAgentId: null,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    await expect(
      svc.update(draftRoutine.id, { status: "active" }, {}),
    ).rejects.toThrow(/default agent required/i);
  });

  it("blocks schedule triggers when required variables do not have defaults", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "repo triage",
        description: "Review {{repo}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
        ],
      },
      {},
    );

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("treats malformed stored defaults as missing when validating schedule triggers", async () => {
    const { companyId, agentId, projectId, svc } = await seedFixture();
    const variableRoutine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "ship check",
        description: "Review {{approved}}",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          { name: "approved", label: null, type: "boolean", defaultValue: true, required: true, options: [] },
        ],
      },
      {},
    );

    await db
      .update(routines)
      .set({
        variables: [
          {
            name: "approved",
            label: null,
            type: "boolean",
            defaultValue: "definitely",
            required: true,
            options: [],
          },
        ],
      })
      .where(eq(routines.id, variableRoutine.id));

    await expect(
      svc.createTrigger(variableRoutine.id, {
        kind: "schedule",
        label: "daily",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      }, {}),
    ).rejects.toThrow(/require defaults for required variables/i);
  });

  it("serializes concurrent dispatches until the first execution issue is linked to a queued run", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async (wakeupAgentId, wakeupOpts) => {
        const issueId =
          (typeof wakeupOpts.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
          (typeof wakeupOpts.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
          null;
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (!issueId) return null;
        const queuedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: queuedRunId,
          companyId: routine.companyId,
          agentId: wakeupAgentId,
          invocationSource: wakeupOpts.source ?? "assignment",
          triggerDetail: wakeupOpts.triggerDetail ?? null,
          status: "queued",
          contextSnapshot: { ...(wakeupOpts.contextSnapshot ?? {}), issueId },
        });
        await db
          .update(issues)
          .set({
            executionRunId: queuedRunId,
            executionLockedAt: new Date(),
          })
          .where(eq(issues.id, issueId));
        return { id: queuedRunId };
      },
    });

    const [first, second] = await Promise.all([
      svc.runRoutine(routine.id, { source: "manual" }),
      svc.runRoutine(routine.id, { source: "manual" }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["coalesced", "issue_created"]);
    expect(first.linkedIssueId).toBeTruthy();
    expect(second.linkedIssueId).toBeTruthy();
    expect(first.linkedIssueId).toBe(second.linkedIssueId);

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(1);
  });

  it("fails the run and cleans up the execution issue when wakeup queueing fails", async () => {
    const { routine, svc } = await seedFixture({
      wakeup: async () => {
        throw new Error("queue unavailable");
      },
    });

    const run = await svc.runRoutine(routine.id, { source: "manual" });

    expect(run.status).toBe("failed");
    expect(run.failureReason).toContain("queue unavailable");
    expect(run.linkedIssueId).toBeNull();

    const routineIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, routine.id));

    expect(routineIssues).toHaveLength(0);
  });

  it("accepts standard second-precision webhook timestamps for HMAC triggers", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "hmac_sha256",
        replayWindowSec: 300,
      },
      {},
    );

    expect(trigger.publicId).toBeTruthy();
    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { ok: true };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestampSeconds = String(Math.floor(Date.now() / 1000));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(`${timestampSeconds}.`)
      .update(rawBody)
      .digest("hex")}`;

    const run = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, {
      signatureHeader: signature,
      timestampHeader: timestampSeconds,
      rawBody,
      payload,
    }));

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();
  });

  it("interpolates the webhook body into the issue via the {{payload}} builtin", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(
      routine.id,
      {
        description: "Triggered with payload:\n{{payload}}",
      },
      {},
    );

    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "bearer",
        replayWindowSec: 300,
      },
      {},
    );

    expect(secretMaterial?.webhookSecret).toBeTruthy();

    const payload = { context: "from slack", user: "wallace" };
    const run = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, {
      authorizationHeader: `Bearer ${secretMaterial!.webhookSecret}`,
      payload,
    }));

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
    expect(run.linkedIssueId).toBeTruthy();

    const [issue] = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(issue?.description).toContain('"context": "from slack"');
    expect(issue?.description).toContain('"user": "wallace"');
    expect(issue?.description).toContain("Triggered with payload:");
  });

  it("leaves {{payload}} empty for non-webhook dispatches", async () => {
    const { routine, svc } = await seedFixture();
    await svc.update(
      routine.id,
      {
        description: "Body:[{{payload}}]",
      },
      {},
    );

    const run = await svc.runRoutine(routine.id, { source: "manual" });
    expect(run.status).toBe("issue_created");

    const [issue] = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, run.linkedIssueId!));
    expect(issue?.description).toBe("Body:[]");
  });

  it("uses the configured provider for generated webhook trigger secrets", async () => {
    process.env.PAPERCLIP_SECRETS_PROVIDER = "aws_secrets_manager";
    const originalGetSecretProvider = providerRegistry.getSecretProvider;
    const getSecretProviderSpy = vi.spyOn(providerRegistry, "getSecretProvider").mockImplementation((provider) => {
      if (provider !== "aws_secrets_manager") {
        return originalGetSecretProvider(provider);
      }
      return {
        id: "aws_secrets_manager",
        descriptor: () => ({
          id: "aws_secrets_manager",
          label: "AWS Secrets Manager",
          supportsManaged: true,
          supportsExternalReference: true,
        }),
        validateConfig: async () => ({ ok: true, warnings: [] }),
        createSecret: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v1" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v1",
        }),
        createVersion: async ({ value }) => ({
          material: { source: "managed", secretId: "arn:aws:secretsmanager:stub", versionId: "v2" },
          valueSha256: `sha:${value}`,
          fingerprintSha256: `sha:${value}`,
          externalRef: "arn:aws:secretsmanager:stub",
          providerVersionRef: "v2",
        }),
        linkExternalSecret: async ({ externalRef, providerVersionRef }) => ({
          material: { source: "external", secretId: externalRef, versionId: providerVersionRef ?? null },
          valueSha256: "external",
          fingerprintSha256: "external",
          externalRef,
          providerVersionRef: providerVersionRef ?? null,
        }),
        resolveVersion: async () => "resolved-secret",
        deleteOrArchive: async () => undefined,
        healthCheck: async () => ({
          provider: "aws_secrets_manager",
          status: "ok",
          message: "stubbed",
        }),
      };
    });

    try {
      const { routine, svc } = await seedFixture();
      const { trigger } = await svc.createTrigger(
        routine.id,
        {
          kind: "webhook",
          signingMode: "hmac_sha256",
          replayWindowSec: 300,
        },
        {},
      );

      const [secret] = await db
        .select({
          id: companySecrets.id,
          provider: companySecrets.provider,
        })
        .from(companySecrets)
        .where(eq(companySecrets.id, trigger.secretId!));

      expect(secret).toMatchObject({
        id: trigger.secretId,
        provider: "aws_secrets_manager",
      });
    } finally {
      getSecretProviderSpy.mockRestore();
    }
  });

  it("accepts GitHub-style X-Hub-Signature-256 with github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger, secretMaterial } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const payload = { action: "opened", pull_request: { number: 1 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac("sha256", secretMaterial!.webhookSecret)
      .update(rawBody)
      .digest("hex")}`;

    const run = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, {
      hubSignatureHeader: signature,
      rawBody,
      payload,
    }));

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  it("rejects invalid signature for github_hmac signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "github_hmac",
      },
      {},
    );

    const rawBody = Buffer.from(JSON.stringify({ ok: true }));

    await expect(
      svc.firePublicTrigger(trigger.publicId!, {
        hubSignatureHeader: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody,
        payload: { ok: true },
      }),
    ).rejects.toThrow();
  });

  it("accepts any request with none signing mode", async () => {
    const { routine, svc } = await seedFixture();
    const { trigger } = await svc.createTrigger(
      routine.id,
      {
        kind: "webhook",
        signingMode: "none",
      },
      {},
    );

    const run = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, {
      payload: { event: "error.created" },
    }));

    expect(run.source).toBe("webhook");
    expect(run.status).toBe("issue_created");
  });

  describe("slack_event triggers", () => {
    function signSlackBody(secret: string, timestampSec: string, body: string) {
      return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:`).update(body).digest("hex")}`;
    }

    async function createSlackTriggerFixture(opts?: {
      signingSecret?: string;
      allowedEventTypes?: string[];
      botUserId?: string | null;
      teamId?: string | null;
    }) {
      const fixture = await seedFixture();
      const signingSecret = opts?.signingSecret ?? "slack-signing-secret-test";
      const { trigger } = await fixture.svc.createTrigger(
        fixture.routine.id,
        {
          kind: "slack_event",
          signingSecret,
          allowedEventTypes: opts?.allowedEventTypes ?? ["app_mention"],
          botUserId: opts?.botUserId ?? null,
          teamId: opts?.teamId ?? null,
          replayWindowSec: 300,
        },
        {},
      );
      return { ...fixture, trigger, signingSecret };
    }

    function buildAppMentionEnvelope(overrides?: {
      eventId?: string;
      teamId?: string;
      user?: string;
      text?: string;
      channel?: string;
      threadTs?: string | null;
      ts?: string;
      eventType?: string;
    }) {
      const event: Record<string, unknown> = {
        type: overrides?.eventType ?? "app_mention",
        user: overrides?.user ?? "U061F7AUR",
        text: overrides?.text ?? "<@U0LAN0Z89> what's up?",
        ts: overrides?.ts ?? "1515449522.000016",
        channel: overrides?.channel ?? "C123ABC456",
        event_ts: "1515449522000016",
      };
      if (overrides?.threadTs !== undefined && overrides.threadTs !== null) {
        event.thread_ts = overrides.threadTs;
      }
      return {
        token: "verification-token",
        team_id: overrides?.teamId ?? "T123ABC456",
        api_app_id: "A0000000",
        type: "event_callback",
        event_id: overrides?.eventId ?? "Ev123ABC456",
        event_time: 1515449523,
        authorizations: [],
        event,
      };
    }

    it("answers the Slack url_verification handshake with the provided challenge", async () => {
      const { trigger, signingSecret, svc } = await createSlackTriggerFixture();
      const envelope = { type: "url_verification", token: "tok", challenge: "abc123" };
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      });
      expect(result.kind).toBe("url_verification");
      if (result.kind === "url_verification") {
        expect(result.challenge).toBe("abc123");
      }
    });

    it("rejects a tampered Slack signature with 401", async () => {
      const { trigger, svc } = await createSlackTriggerFixture();
      const envelope = buildAppMentionEnvelope();
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      await expect(
        svc.firePublicTrigger(trigger.publicId!, {
          slackSignatureHeader: "v0=0000000000000000000000000000000000000000000000000000000000000000",
          slackTimestampHeader: ts,
          rawBody: Buffer.from(body),
          payload: envelope,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("rejects Slack requests whose timestamp falls outside the replay window", async () => {
      const { trigger, signingSecret, svc } = await createSlackTriggerFixture();
      const envelope = buildAppMentionEnvelope();
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 min ago
      await expect(
        svc.firePublicTrigger(trigger.publicId!, {
          slackSignatureHeader: signSlackBody(signingSecret, ts, body),
          slackTimestampHeader: ts,
          rawBody: Buffer.from(body),
          payload: envelope,
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("matches pluralised Slack subscription names against singular channel_type", async () => {
      // Slack ships `message.channels` as the subscription name but the
      // payload arrives with `channel_type: "channel"` (singular). Same for
      // `message.groups` / `group`.
      for (const [subscription, channelType] of [
        ["message.channels", "channel"],
        ["message.groups", "group"],
      ] as const) {
        const { trigger, signingSecret, svc } = await createSlackTriggerFixture({
          allowedEventTypes: [subscription],
        });
        const envelope = buildAppMentionEnvelope({
          eventType: "message",
          eventId: `Ev-${subscription}`,
        });
        (envelope.event as Record<string, unknown>).channel_type = channelType;
        const body = JSON.stringify(envelope);
        const ts = String(Math.floor(Date.now() / 1000));
        const result = await svc.firePublicTrigger(trigger.publicId!, {
          slackSignatureHeader: signSlackBody(signingSecret, ts, body),
          slackTimestampHeader: ts,
          rawBody: Buffer.from(body),
          payload: envelope,
        });
        expect(result.kind, `expected ${subscription} (channel_type=${channelType}) to dispatch`).toBe("run");
      }
    });

    it("matches Slack subscription names like message.im against event.type + channel_type", async () => {
      const { routine, trigger, signingSecret, svc } = await createSlackTriggerFixture({
        allowedEventTypes: ["message.im"],
      });
      await svc.update(routine.id, { description: "channel={{slack_channel}}" }, {});
      const envelope = buildAppMentionEnvelope({
        eventType: "message",
        channel: "D123IM",
      });
      // Augment the event with channel_type=im (the discriminator Slack ships).
      (envelope.event as Record<string, unknown>).channel_type = "im";
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      });
      expect(result.kind).toBe("run");
    });

    it("filters Slack events whose type is outside the allowlist", async () => {
      const { trigger, signingSecret, svc } = await createSlackTriggerFixture({
        allowedEventTypes: ["app_mention"],
      });
      const envelope = buildAppMentionEnvelope({ eventType: "message" });
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      });
      expect(result.kind).toBe("filtered");
      if (result.kind === "filtered") {
        expect(result.reason).toContain("event_type");
      }
    });

    it("filters Slack events from a workspace other than the configured team_id", async () => {
      const { trigger, signingSecret, svc } = await createSlackTriggerFixture({
        teamId: "TAAA000000",
      });
      const envelope = buildAppMentionEnvelope({ teamId: "TBBB000000" });
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      });
      expect(result.kind).toBe("filtered");
      if (result.kind === "filtered") {
        expect(result.reason).toBe("team_id_mismatch");
      }
    });

    it("filters Slack events authored by the bot itself", async () => {
      const { trigger, signingSecret, svc } = await createSlackTriggerFixture({
        botUserId: "UBOT00000",
      });
      const envelope = buildAppMentionEnvelope({ user: "UBOT00000" });
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      });
      expect(result.kind).toBe("filtered");
      if (result.kind === "filtered") {
        expect(result.reason).toBe("bot_self_event");
      }
    });

    it("dispatches a run and interpolates the six slack_* builtins plus {{payload}}", async () => {
      const { routine, trigger, signingSecret, svc } = await createSlackTriggerFixture();
      await svc.update(
        routine.id,
        {
          description: [
            "user={{slack_user}}",
            "text={{slack_text}}",
            "channel={{slack_channel}}",
            "thread={{slack_thread_ts}}",
            "team={{slack_team_id}}",
            "event={{slack_event_id}}",
            "payload-snippet={{payload}}",
          ].join("\n"),
        },
        {},
      );

      const envelope = buildAppMentionEnvelope({
        eventId: "Ev9000",
        teamId: "T9000",
        user: "U9000",
        text: "hello",
        channel: "C9000",
        threadTs: null,
        ts: "1700000000.000100",
      });
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));

      const run = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      }));

      expect(run.source).toBe("slack_event");
      expect(run.status).toBe("issue_created");
      expect(run.linkedIssueId).toBeTruthy();

      const [issue] = await db
        .select({ description: issues.description })
        .from(issues)
        .where(eq(issues.id, run.linkedIssueId!));
      expect(issue?.description).toContain("user=U9000");
      expect(issue?.description).toContain("text=hello");
      expect(issue?.description).toContain("channel=C9000");
      expect(issue?.description).toContain("thread=1700000000.000100");
      expect(issue?.description).toContain("team=T9000");
      expect(issue?.description).toContain("event=Ev9000");
      expect(issue?.description).toContain('"event_id": "Ev9000"');
    });

    it("uses event.thread_ts when present and falls back to event.ts otherwise", async () => {
      const { routine, trigger, signingSecret, svc } = await createSlackTriggerFixture();
      await svc.update(
        routine.id,
        { description: "thread={{slack_thread_ts}}" },
        {},
      );

      const envelope = buildAppMentionEnvelope({
        eventId: "EvThread",
        ts: "1700000100.000200",
        threadTs: "1700000050.000050",
      });
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const run = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      }));
      const [issue] = await db
        .select({ description: issues.description })
        .from(issues)
        .where(eq(issues.id, run.linkedIssueId!));
      expect(issue?.description).toBe("thread=1700000050.000050");
    });

    it("collapses retried Slack deliveries onto the same run via event_id", async () => {
      const { trigger, signingSecret, svc } = await createSlackTriggerFixture();
      const envelope = buildAppMentionEnvelope({ eventId: "EvDup", ts: "1700000200.000300" });
      const body = JSON.stringify(envelope);
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: envelope,
      };
      const first = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, headers));
      const second = expectRunResult(await svc.firePublicTrigger(trigger.publicId!, headers));
      expect(second.id).toBe(first.id);
      expect(second.idempotencyKey).toBe("EvDup");
    });
  });

  describe("slack_command triggers", () => {
    function signSlackBody(secret: string, timestampSec: string, body: string) {
      return `v0=${createHmac("sha256", secret).update(`v0:${timestampSec}:`).update(body).digest("hex")}`;
    }

    function encodeSlashForm(form: Record<string, string>): string {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) params.set(key, value);
      return params.toString();
    }

    function buildSlashForm(overrides?: Partial<{
      command: string;
      text: string;
      team_id: string;
      user_id: string;
      user_name: string;
      channel_id: string;
      channel_name: string;
      trigger_id: string;
      response_url: string;
    }>): Record<string, string> {
      return {
        token: "verification-token",
        team_id: overrides?.team_id ?? "T123ABC456",
        team_domain: "example",
        channel_id: overrides?.channel_id ?? "C2147483705",
        channel_name: overrides?.channel_name ?? "test",
        user_id: overrides?.user_id ?? "U2147483697",
        user_name: overrides?.user_name ?? "steve",
        command: overrides?.command ?? "/paperclip",
        text: overrides?.text ?? "review PR 42",
        response_url: overrides?.response_url ?? "https://hooks.slack.com/commands/T123/B456/abcdef",
        trigger_id: overrides?.trigger_id ?? "13345224609.738474920.8088930838d88f008e0",
        api_app_id: "A123456",
      };
    }

    async function createSlashTriggerFixture(opts?: {
      signingSecret?: string;
      allowedCommands?: string[];
      allowedUserIds?: string[] | null;
      allowedChannelIds?: string[] | null;
      teamId?: string | null;
      ackMessage?: string | null;
    }) {
      const fixture = await seedFixture();
      const signingSecret = opts?.signingSecret ?? "slack-slash-signing-secret";
      const { trigger } = await fixture.svc.createTrigger(
        fixture.routine.id,
        {
          kind: "slack_command",
          signingSecret,
          allowedCommands: opts?.allowedCommands ?? ["/paperclip"],
          allowedUserIds: opts?.allowedUserIds ?? null,
          allowedChannelIds: opts?.allowedChannelIds ?? null,
          teamId: opts?.teamId ?? null,
          ackMessage: opts?.ackMessage ?? null,
          replayWindowSec: 300,
        },
        {},
      );
      return { ...fixture, trigger, signingSecret };
    }

    async function waitForRoutineRun(triggerId: string, expectedCount: number, timeoutMs = 5_000) {
      // The slash handler dispatches the run fire-and-forget, so we poll the
      // table until the expected number of rows lands or the timeout expires.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const rows = await db
          .select()
          .from(routineRuns)
          .where(eq(routineRuns.triggerId, triggerId));
        if (rows.length >= expectedCount) return rows;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const finalRows = await db
        .select()
        .from(routineRuns)
        .where(eq(routineRuns.triggerId, triggerId));
      return finalRows;
    }

    it("returns an ack body with the default message for an allowed slash command", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture();
      const body = encodeSlashForm(buildSlashForm());
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      });
      expect(result.kind).toBe("ack");
      if (result.kind !== "ack") throw new Error(`expected ack, got ${result.kind}`);
      expect(result.body).toEqual({
        response_type: "ephemeral",
        text: "Working on it — I'll follow up here when ready.",
      });
      const runs = await waitForRoutineRun(trigger.id, 1);
      expect(runs.length).toBe(1);
      expect(runs[0]!.source).toBe("slack_command");
      expect(runs[0]!.idempotencyKey).toBe("13345224609.738474920.8088930838d88f008e0");
    });

    it("returns the operator-provided ack message verbatim", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture({
        ackMessage: "Got it boss",
      });
      const body = encodeSlashForm(buildSlashForm({ trigger_id: "trig-ack-msg" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      });
      expect(result.kind).toBe("ack");
      if (result.kind !== "ack") throw new Error(`expected ack, got ${result.kind}`);
      expect(result.body.text).toBe("Got it boss");
      // Drain the background dispatch so the FK row lands before the fixture
      // tears down the parent routine.
      await waitForRoutineRun(trigger.id, 1);
    });

    it("rejects a tampered slash signature with 401", async () => {
      const { trigger, svc } = await createSlashTriggerFixture();
      const body = encodeSlashForm(buildSlashForm({ trigger_id: "trig-tampered" }));
      const ts = String(Math.floor(Date.now() / 1000));
      await expect(
        svc.firePublicTrigger(trigger.publicId!, {
          slackSignatureHeader: "v0=0000000000000000000000000000000000000000000000000000000000000000",
          slackTimestampHeader: ts,
          rawBody: Buffer.from(body),
          payload: Object.fromEntries(new URLSearchParams(body)),
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("rejects slash requests outside the replay window", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture();
      const body = encodeSlashForm(buildSlashForm({ trigger_id: "trig-stale" }));
      const ts = String(Math.floor(Date.now() / 1000) - 10 * 60);
      await expect(
        svc.firePublicTrigger(trigger.publicId!, {
          slackSignatureHeader: signSlackBody(signingSecret, ts, body),
          slackTimestampHeader: ts,
          rawBody: Buffer.from(body),
          payload: Object.fromEntries(new URLSearchParams(body)),
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("filters commands not in the allowlist", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture({
        allowedCommands: ["/paperclip"],
      });
      const body = encodeSlashForm(buildSlashForm({ command: "/other", trigger_id: "trig-other-cmd" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      });
      expect(result.kind).toBe("filtered");
    });

    it("filters team_id mismatches when team_id is configured", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture({
        teamId: "T_EXPECTED",
      });
      const body = encodeSlashForm(buildSlashForm({ team_id: "T_DIFFERENT", trigger_id: "trig-team-mm" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      });
      expect(result.kind).toBe("filtered");
    });

    it("filters user ids not in the allowlist", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture({
        allowedUserIds: ["U_OK_1", "U_OK_2"],
      });
      const body = encodeSlashForm(buildSlashForm({ user_id: "U_OTHER", trigger_id: "trig-user-mm" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      });
      expect(result.kind).toBe("filtered");
    });

    it("filters channel ids not in the allowlist", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture({
        allowedChannelIds: ["C_OK"],
      });
      const body = encodeSlashForm(buildSlashForm({ channel_id: "C_OTHER", trigger_id: "trig-channel-mm" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const result = await svc.firePublicTrigger(trigger.publicId!, {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      });
      expect(result.kind).toBe("filtered");
    });

    it("collapses repeated slash deliveries onto the same run via trigger_id", async () => {
      const { trigger, signingSecret, svc } = await createSlashTriggerFixture();
      const body = encodeSlashForm(buildSlashForm({ trigger_id: "trig-dup" }));
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = {
        slackSignatureHeader: signSlackBody(signingSecret, ts, body),
        slackTimestampHeader: ts,
        rawBody: Buffer.from(body),
        payload: Object.fromEntries(new URLSearchParams(body)),
      };
      const first = await svc.firePublicTrigger(trigger.publicId!, headers);
      expect(first.kind).toBe("ack");
      await waitForRoutineRun(trigger.id, 1);
      const second = await svc.firePublicTrigger(trigger.publicId!, headers);
      expect(second.kind).toBe("ack");
      // Give the second dispatch enough time to attempt an insert; idempotency
      // should collapse it onto the existing row, so the count stays at 1.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const runs = await db.select().from(routineRuns).where(eq(routineRuns.triggerId, trigger.id));
      expect(runs.length).toBe(1);
      expect(runs[0]!.idempotencyKey).toBe("trig-dup");
    });
  });
});
