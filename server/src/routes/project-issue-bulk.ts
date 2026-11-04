import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { isUuidLike, type ProjectCancelOpenIssuesJob } from "@paperclipai/shared";
import {
  heartbeatService,
  logActivity,
  projectIssueBulkCancelService,
  projectService,
} from "../services/index.js";
import type { ProjectBulkCancelActor } from "../services/project-issue-bulk-cancel.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const ACTIVITY_SOURCE = "project_cancel_open_issues";
const WAKEUP_CANCEL_REASON = "Cancelled because all open issues of the project were cancelled";

function errorToMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function projectIssueBulkRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    batchSize?: number;
    pauseMs?: number;
  } = {},
) {
  const router = Router();
  const projectsSvc = projectService(db);
  const bulkCancelSvc = projectIssueBulkCancelService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  // Latest job per project. In-memory on purpose: the operation is idempotent, so a job lost
  // to a restart is resumed by starting it again, and this also serializes jobs per project.
  const jobsByProjectId = new Map<string, ProjectCancelOpenIssuesJob>();

  async function resolveProject(req: Request) {
    let projectId = (req.params.id as string).trim();
    if (!isUuidLike(projectId)) {
      const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
      if (!companyId) return null;
      assertCompanyAccess(req, companyId);
      const resolved = await projectsSvc.resolveByReference(companyId, projectId);
      if (resolved.ambiguous) {
        throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
      }
      if (!resolved.project) return null;
      projectId = resolved.project.id;
    }
    const project = await projectsSvc.getById(projectId);
    if (!project) return null;
    assertCompanyAccess(req, project.companyId);
    return project;
  }

  async function interruptRun(
    job: ProjectCancelOpenIssuesJob,
    actor: ProjectBulkCancelActor,
    run: { id: string; agentId: string; issueId: string },
  ) {
    try {
      const cancelled = await heartbeat.cancelRun(run.id);
      if (!cancelled) return;
      job.interruptedRunCount += 1;
      await logActivity(db, {
        companyId: job.companyId,
        ...actor,
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId, source: ACTIVITY_SOURCE, issueId: run.issueId },
      });
    } catch (error) {
      logger.warn({ err: error, projectId: job.projectId, runId: run.id }, "failed to cancel run for bulk-cancelled issue");
      await Promise.resolve(logActivity(db, {
        companyId: job.companyId,
        ...actor,
        action: "heartbeat.cancel_failed",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { source: ACTIVITY_SOURCE, issueId: run.issueId, error: errorToMessage(error) },
      })).catch(() => null);
    }
  }

  async function runJob(job: ProjectCancelOpenIssuesJob, actor: ProjectBulkCancelActor) {
    try {
      const summary = await bulkCancelSvc.cancelOpenIssues(job.companyId, job.projectId, {
        actor,
        wakeupCancelReason: WAKEUP_CANCEL_REASON,
        batchSize: options.batchSize,
        pauseMs: options.pauseMs,
        onBatch: async (batch) => {
          job.batchCount += 1;
          job.cancelledCount += batch.cancelledCount;
          job.cancelledWakeupCount += batch.cancelledWakeupCount;
          // A handful per batch at most (bounded by agents), so sequential is fine.
          for (const run of batch.activeRuns) await interruptRun(job, actor, run);
        },
      });
      job.remainingCount = summary.remainingCount;
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      await logActivity(db, {
        companyId: job.companyId,
        ...actor,
        action: "project.open_issues_cancelled",
        entityType: "project",
        entityId: job.projectId,
        details: {
          jobId: job.id,
          cancelledIssueCount: summary.cancelledCount,
          batchCount: summary.batchCount,
          interruptedRunCount: job.interruptedRunCount,
          cancelledWakeupCount: summary.cancelledWakeupCount,
          finalizedRoutineRunCount: summary.finalizedRoutineRunCount,
          remainingCount: summary.remainingCount,
        },
      });
    } catch (error) {
      logger.error({ err: error, projectId: job.projectId, jobId: job.id }, "project open-issue cancellation job failed");
      job.status = "failed";
      job.error = errorToMessage(error);
      job.finishedAt = new Date().toISOString();
      await Promise.resolve(logActivity(db, {
        companyId: job.companyId,
        ...actor,
        action: "project.open_issues_cancel_failed",
        entityType: "project",
        entityId: job.projectId,
        details: { jobId: job.id, cancelledIssueCount: job.cancelledCount, error: job.error },
      })).catch(() => null);
    }
  }

  router.get("/projects/:id/issues/cancel-open", async (req, res) => {
    assertBoard(req);
    const project = await resolveProject(req);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(jobsByProjectId.get(project.id) ?? null);
  });

  router.post("/projects/:id/issues/cancel-open", async (req, res) => {
    assertBoard(req);
    const project = await resolveProject(req);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const current = jobsByProjectId.get(project.id);
    if (current?.status === "running") {
      res.status(202).json(current);
      return;
    }

    const actorInfo = getActorInfo(req);
    const actor: ProjectBulkCancelActor = {
      actorType: actorInfo.actorType,
      actorId: actorInfo.actorId,
      agentId: actorInfo.agentId ?? null,
      runId: actorInfo.runId ?? null,
    };
    const job: ProjectCancelOpenIssuesJob = {
      id: randomUUID(),
      projectId: project.id,
      companyId: project.companyId,
      status: "running",
      totalEstimate: 0,
      cancelledCount: 0,
      batchCount: 0,
      interruptedRunCount: 0,
      cancelledWakeupCount: 0,
      remainingCount: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    // Register before any await so a double-click cannot start a second job.
    jobsByProjectId.set(project.id, job);

    try {
      job.totalEstimate = await bulkCancelSvc.countOpenIssues(project.companyId, project.id);
      await logActivity(db, {
        companyId: project.companyId,
        ...actor,
        action: "project.open_issues_cancel_started",
        entityType: "project",
        entityId: project.id,
        details: { jobId: job.id, totalEstimate: job.totalEstimate },
      });
    } catch (error) {
      jobsByProjectId.delete(project.id);
      throw error;
    }

    void runJob(job, actor);
    res.status(202).json(job);
  });

  return router;
}
