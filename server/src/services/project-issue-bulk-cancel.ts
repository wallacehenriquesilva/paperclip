import { and, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  routineRuns,
} from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

// Bulk cancellation is built for projects with hundreds of thousands of issues:
//  - candidate ids are snapshotted once (single index scan), then processed through
//    primary-key batches, so total work stays linear instead of re-scanning the project
//    for every batch;
//  - every batch is its own short transaction (row locks held for milliseconds, WAL and
//    the non-HOT index churn on `issues` spread out) with a pause between batches;
//  - `FOR UPDATE SKIP LOCKED` never waits on rows an agent is writing right now — those
//    are retried in a later pass;
//  - activity rows are inserted in bulk and no per-issue live/plugin events are emitted
//    (hundreds of thousands of them would make every connected board refetch per event).
//    The route publishes a single project-level activity when the job finishes.

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const UNCLAIMED_WAKEUP_STATUSES = ["queued", "deferred_issue_execution"] as const;
const ROUTINE_CANCEL_FAILURE_REASON = "Execution issue moved to cancelled";

export const PROJECT_BULK_CANCEL_ACTIVITY_SOURCE = "project_cancel_open_issues";

export const DEFAULT_PROJECT_BULK_CANCEL_BATCH_SIZE = 500;
export const DEFAULT_PROJECT_BULK_CANCEL_PAUSE_MS = 50;
export const DEFAULT_PROJECT_BULK_CANCEL_MAX_PASSES = 3;
const BATCH_STATEMENT_TIMEOUT_MS = 60_000;

export interface ProjectBulkCancelActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
}

export interface ProjectActiveIssueRun {
  id: string;
  agentId: string;
  issueId: string;
}

export interface ProjectBulkCancelBatchResult {
  cancelledCount: number;
  cancelledWakeupCount: number;
  finalizedRoutineRunCount: number;
  /** Queued/running heartbeat runs attached to issues of this batch; the caller interrupts them. */
  activeRuns: ProjectActiveIssueRun[];
}

export interface ProjectBulkCancelRunOptions {
  actor: ProjectBulkCancelActor;
  wakeupCancelReason: string;
  batchSize?: number;
  pauseMs?: number;
  maxPasses?: number;
  onBatch?: (batch: ProjectBulkCancelBatchResult) => Promise<void> | void;
}

export interface ProjectBulkCancelSummary {
  cancelledCount: number;
  batchCount: number;
  cancelledWakeupCount: number;
  finalizedRoutineRunCount: number;
  interruptedRunIds: string[];
  remainingCount: number;
}

interface CancelledIssueRow {
  id: string;
  identifier: string | null;
  previous_status: string;
  previous_execution_run_id: string | null;
  origin_kind: string;
  origin_run_id: string | null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function sleep(ms: number) {
  return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function projectIssueBulkCancelService(db: Db) {
  function openIssuesWhere(companyId: string, projectId: string) {
    return and(
      eq(issues.companyId, companyId),
      eq(issues.projectId, projectId),
      notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
    );
  }

  async function countOpenIssues(companyId: string, projectId: string) {
    const [row] = await db
      .select({ value: count() })
      .from(issues)
      .where(openIssuesWhere(companyId, projectId));
    return Number(row?.value ?? 0);
  }

  async function listOpenIssueIds(companyId: string, projectId: string) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(openIssuesWhere(companyId, projectId))
      .orderBy(issues.id);
    return rows.map((row) => row.id);
  }

  async function listCompanyAgentIds(companyId: string) {
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
    return rows.map((row) => row.id);
  }

  async function cancelBatch(
    companyId: string,
    projectId: string,
    issueIds: string[],
    ctx: { actor: ProjectBulkCancelActor; wakeupCancelReason: string; companyAgentIds: string[] },
  ): Promise<ProjectBulkCancelBatchResult> {
    if (issueIds.length === 0) {
      return { cancelledCount: 0, cancelledWakeupCount: 0, finalizedRoutineRunCount: 0, activeRuns: [] };
    }
    const idList = sql.join(issueIds.map((id) => sql`${id}::uuid`), sql`, `);

    const { cancelled, cancelledWakeupCount, finalizedRoutineRunCount } = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${BATCH_STATEMENT_TIMEOUT_MS}`));

      // Lock + snapshot + flip in one statement: the CTE captures the pre-update status and
      // execution run (needed for the audit trail and run interruption) under the row lock.
      const cancelledRows = rowsOf<CancelledIssueRow>(await tx.execute(sql`
        WITH target AS (
          SELECT id, status, execution_run_id
          FROM issues
          WHERE company_id = ${companyId}
            AND project_id = ${projectId}
            AND id IN (${idList})
            AND status NOT IN ('done', 'cancelled')
          FOR UPDATE SKIP LOCKED
        )
        UPDATE issues AS i
        SET status = 'cancelled',
            cancelled_at = now(),
            completed_at = NULL,
            checkout_run_id = NULL,
            execution_run_id = NULL,
            execution_agent_name_key = NULL,
            execution_locked_at = NULL,
            updated_at = now()
        FROM target
        WHERE i.id = target.id
        RETURNING i.id,
                  i.identifier,
                  target.status AS previous_status,
                  target.execution_run_id AS previous_execution_run_id,
                  i.origin_kind,
                  i.origin_run_id
      `));
      if (cancelledRows.length === 0) {
        return { cancelled: cancelledRows, cancelledWakeupCount: 0, finalizedRoutineRunCount: 0 };
      }
      const cancelledIds = cancelledRows.map((row) => row.id);

      // agent_id = ANY(...) lets Postgres use (company_id, agent_id, status) instead of
      // walking the company's whole wakeup history.
      const wakeups = ctx.companyAgentIds.length === 0
        ? []
        : await tx
          .update(agentWakeupRequests)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            error: ctx.wakeupCancelReason,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentWakeupRequests.companyId, companyId),
              inArray(agentWakeupRequests.agentId, ctx.companyAgentIds),
              inArray(agentWakeupRequests.status, [...UNCLAIMED_WAKEUP_STATUSES]),
              isNull(agentWakeupRequests.runId),
              inArray(sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`, cancelledIds),
            ),
          )
          .returning({ id: agentWakeupRequests.id });

      // Same outcome as routineService.syncRunStatusForIssue, set-based.
      const routineRunIds = [...new Set(cancelledRows
        .filter((row) => row.origin_kind === "routine_execution" && row.origin_run_id && isUuidLike(row.origin_run_id))
        .map((row) => row.origin_run_id as string))];
      const finalizedRoutineRuns = routineRunIds.length === 0
        ? []
        : await tx
          .update(routineRuns)
          .set({
            status: "failed",
            failureReason: ROUTINE_CANCEL_FAILURE_REASON,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.id, routineRunIds)))
          .returning({ id: routineRuns.id });

      await tx.insert(activityLog).values(cancelledRows.map((row) => ({
        companyId,
        actorType: ctx.actor.actorType,
        actorId: ctx.actor.actorId,
        agentId: ctx.actor.agentId,
        runId: ctx.actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: row.id,
        details: {
          status: "cancelled",
          identifier: row.identifier,
          source: PROJECT_BULK_CANCEL_ACTIVITY_SOURCE,
          projectId,
          _previous: { status: row.previous_status },
        },
      })));

      return {
        cancelled: cancelledRows,
        cancelledWakeupCount: wakeups.length,
        finalizedRoutineRunCount: finalizedRoutineRuns.length,
      };
    });

    return {
      cancelledCount: cancelled.length,
      cancelledWakeupCount,
      finalizedRoutineRunCount,
      activeRuns: cancelled.length === 0 ? [] : await activeRunsForIssues(companyId, cancelled),
    };
  }

  async function activeRunsForIssues(companyId: string, cancelled: CancelledIssueRow[]) {
    // Active runs per company are few and (company_id, status) is indexed, so fetch them
    // and match in memory instead of shipping the batch ids into a jsonb predicate.
    const issueIdSet = new Set(cancelled.map((row) => row.id));
    const issueIdByExecutionRunId = new Map(
      cancelled
        .filter((row) => row.previous_execution_run_id)
        .map((row) => [row.previous_execution_run_id as string, row.id]),
    );
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueIdFromContext: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES])));

    return runs.flatMap((run) => {
      const issueId = run.issueIdFromContext && issueIdSet.has(run.issueIdFromContext)
        ? run.issueIdFromContext
        : issueIdByExecutionRunId.get(run.id) ?? null;
      return issueId ? [{ id: run.id, agentId: run.agentId, issueId }] : [];
    });
  }

  async function cancelOpenIssues(
    companyId: string,
    projectId: string,
    opts: ProjectBulkCancelRunOptions,
  ): Promise<ProjectBulkCancelSummary> {
    const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_PROJECT_BULK_CANCEL_BATCH_SIZE);
    const pauseMs = Math.max(0, opts.pauseMs ?? DEFAULT_PROJECT_BULK_CANCEL_PAUSE_MS);
    const maxPasses = Math.max(1, opts.maxPasses ?? DEFAULT_PROJECT_BULK_CANCEL_MAX_PASSES);
    const summary: ProjectBulkCancelSummary = {
      cancelledCount: 0,
      batchCount: 0,
      cancelledWakeupCount: 0,
      finalizedRoutineRunCount: 0,
      interruptedRunIds: [],
      remainingCount: 0,
    };
    const interrupted = new Set<string>();

    // Each pass re-snapshots, which also picks up rows skipped as locked and issues created
    // while the job was running. A pass that cancels nothing means only contended rows are
    // left, so retrying immediately would not help.
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const ids = await listOpenIssueIds(companyId, projectId);
      if (ids.length === 0) break;
      const companyAgentIds = await listCompanyAgentIds(companyId);
      let cancelledThisPass = 0;

      for (let offset = 0; offset < ids.length; offset += batchSize) {
        if (summary.batchCount > 0) await sleep(pauseMs);
        const batch = await cancelBatch(companyId, projectId, ids.slice(offset, offset + batchSize), {
          actor: opts.actor,
          wakeupCancelReason: opts.wakeupCancelReason,
          companyAgentIds,
        });
        summary.batchCount += 1;
        summary.cancelledCount += batch.cancelledCount;
        summary.cancelledWakeupCount += batch.cancelledWakeupCount;
        summary.finalizedRoutineRunCount += batch.finalizedRoutineRunCount;
        cancelledThisPass += batch.cancelledCount;
        const newRuns = batch.activeRuns.filter((run) => !interrupted.has(run.id));
        for (const run of newRuns) interrupted.add(run.id);
        await opts.onBatch?.({ ...batch, activeRuns: newRuns });
      }

      if (cancelledThisPass === 0) break;
    }

    summary.interruptedRunIds = [...interrupted];
    summary.remainingCount = await countOpenIssues(companyId, projectId);
    return summary;
  }

  return { countOpenIssues, listOpenIssueIds, cancelBatch, cancelOpenIssues };
}
