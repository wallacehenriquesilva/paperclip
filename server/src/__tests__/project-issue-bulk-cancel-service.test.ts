import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  projectIssueBulkCancelService,
  type ProjectBulkCancelBatchResult,
} from "../services/project-issue-bulk-cancel.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project issue bulk cancel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const actor = { actorType: "user" as const, actorId: "user-1", agentId: null, runId: null };

describeEmbeddedPostgres("projectIssueBulkCancelService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-bulk-cancel-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Target" },
      { id: otherProjectId, companyId, name: "Other" },
    ]);
    return { companyId, agentId, projectId, otherProjectId };
  }

  it("cancels every open issue of the project across batches, with bulk side effects", async () => {
    const { companyId, agentId, projectId, otherProjectId } = await seedCompany();
    const runId = randomUUID();
    const routineId = randomUUID();
    const routineRunId = randomUUID();
    const wakeupId = randomUUID();
    const otherWakeupId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: {},
    });
    await db.insert(routines).values({ id: routineId, companyId, projectId, title: "Nightly" });
    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
    });

    const base = { companyId, priority: "medium" as const };
    const openStatuses = ["backlog", "todo", "in_review", "blocked"] as const;
    const bulkOpen = Array.from({ length: 23 }, (_, i) => ({
      ...base,
      id: randomUUID(),
      projectId,
      title: `Open ${i}`,
      status: openStatuses[i % openStatuses.length],
    }));
    const runningIssueId = randomUUID();
    const routineIssueId = randomUUID();
    const doneId = randomUUID();
    const cancelledId = randomUUID();
    const otherProjectIssueId = randomUUID();
    await db.insert(issues).values([
      ...bulkOpen,
      {
        ...base,
        id: runningIssueId,
        projectId,
        title: "Running",
        status: "in_progress",
        assigneeAgentId: agentId,
        executionRunId: runId,
      },
      {
        ...base,
        id: routineIssueId,
        projectId,
        title: "Routine execution",
        status: "todo",
        originKind: "routine_execution",
        originId: routineId,
        originRunId: routineRunId,
      },
      { ...base, id: doneId, projectId, title: "Done", status: "done", completedAt: new Date() },
      { ...base, id: cancelledId, projectId, title: "Cancelled", status: "cancelled" },
      { ...base, id: otherProjectIssueId, projectId: otherProjectId, title: "Other project", status: "todo" },
    ]);
    await db.insert(agentWakeupRequests).values([
      {
        id: wakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: bulkOpen[0]!.id },
        status: "queued",
      },
      {
        id: otherWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: otherProjectIssueId },
        status: "queued",
      },
    ]);

    const svc = projectIssueBulkCancelService(db);
    expect(await svc.countOpenIssues(companyId, projectId)).toBe(25);

    const batches: ProjectBulkCancelBatchResult[] = [];
    const summary = await svc.cancelOpenIssues(companyId, projectId, {
      actor,
      wakeupCancelReason: "bulk cancel",
      batchSize: 10,
      pauseMs: 0,
      onBatch: (batch) => {
        batches.push(batch);
      },
    });

    expect(summary.cancelledCount).toBe(25);
    expect(summary.batchCount).toBe(3);
    expect(batches.map((b) => b.cancelledCount)).toEqual([10, 10, 5]);
    expect(summary.remainingCount).toBe(0);
    expect(summary.cancelledWakeupCount).toBe(1);
    expect(summary.finalizedRoutineRunCount).toBe(1);
    expect(summary.interruptedRunIds).toEqual([runId]);
    expect(batches.flatMap((b) => b.activeRuns)).toEqual([{ id: runId, agentId, issueId: runningIssueId }]);

    const rows = await db
      .select({ id: issues.id, status: issues.status, cancelledAt: issues.cancelledAt, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of [...bulkOpen.map((issue) => issue.id), runningIssueId, routineIssueId]) {
      expect(byId.get(id)?.status).toBe("cancelled");
      expect(byId.get(id)?.cancelledAt).toBeInstanceOf(Date);
    }
    expect(byId.get(runningIssueId)?.executionRunId).toBeNull();
    expect(byId.get(doneId)?.status).toBe("done");
    expect(byId.get(otherProjectIssueId)?.status).toBe("todo");

    const wakeups = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, [wakeupId, otherWakeupId]));
    expect(Object.fromEntries(wakeups.map((w) => [w.id, w.status]))).toEqual({
      [wakeupId]: "cancelled",
      [otherWakeupId]: "queued",
    });

    const [routineRun] = await db.select().from(routineRuns).where(eq(routineRuns.id, routineRunId));
    expect(routineRun?.status).toBe("failed");
    expect(routineRun?.failureReason).toBe("Execution issue moved to cancelled");

    const activity = await db
      .select({ entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.updated")));
    expect(activity).toHaveLength(25);
    expect(activity.find((row) => row.entityId === runningIssueId)?.details).toMatchObject({
      status: "cancelled",
      source: "project_cancel_open_issues",
      _previous: { status: "in_progress" },
    });

    const again = await svc.cancelOpenIssues(companyId, projectId, { actor, wakeupCancelReason: "bulk cancel" });
    expect(again.cancelledCount).toBe(0);
    expect(again.batchCount).toBe(0);
  });

  it("skips rows locked by a concurrent writer instead of waiting, and reports them as remaining", async () => {
    const { companyId, projectId } = await seedCompany();
    const lockedId = randomUUID();
    const freeIds = [randomUUID(), randomUUID()];
    await db.insert(issues).values([lockedId, ...freeIds].map((id, i) => ({
      id,
      companyId,
      projectId,
      title: `Issue ${i}`,
      status: "todo" as const,
      priority: "medium" as const,
    })));

    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM issues WHERE id = ${lockedId} FOR UPDATE`);
      lockAcquired();
      await new Promise<void>((resolve) => { releaseLock = resolve; });
    });
    await acquired;

    const svc = projectIssueBulkCancelService(db);
    try {
      const summary = await svc.cancelOpenIssues(companyId, projectId, {
        actor,
        wakeupCancelReason: "bulk cancel",
        pauseMs: 0,
      });
      expect(summary.cancelledCount).toBe(2);
      expect(summary.remainingCount).toBe(1);
    } finally {
      releaseLock();
      await holder;
    }

    const resumed = await svc.cancelOpenIssues(companyId, projectId, { actor, wakeupCancelReason: "bulk cancel" });
    expect(resumed.cancelledCount).toBe(1);
    expect(resumed.remainingCount).toBe(0);
  });
});
