import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockBulkCancelService = vi.hoisted(() => ({
  countOpenIssues: vi.fn(),
  cancelOpenIssues: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  projectIssueBulkCancelService: () => mockBulkCancelService,
  projectService: () => mockProjectService,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { projectIssueBulkRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/project-issue-bulk.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectIssueBulkRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const summary = {
  cancelledCount: 2,
  batchCount: 1,
  cancelledWakeupCount: 1,
  finalizedRoutineRunCount: 0,
  interruptedRunIds: ["run-1"],
  remainingCount: 0,
};

async function waitForJob(app: express.Express) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/issues/cancel-open`);
    if (res.body?.status !== "running") return res.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not finish");
}

describe("project issue bulk routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue({ id: PROJECT_ID, companyId: "company-1", name: "Target" });
    mockBulkCancelService.countOpenIssues.mockResolvedValue(2);
    mockHeartbeatService.cancelRun.mockImplementation(async (id: string) => ({ id, companyId: "company-1" }));
  });

  it("requires board access", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: null,
      source: "api_key",
    });

    const res = await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});

    expect(res.status).toBe(403);
    expect(mockBulkCancelService.cancelOpenIssues).not.toHaveBeenCalled();
  });

  it("rejects cross-company requests", async () => {
    mockProjectService.getById.mockResolvedValue({ id: PROJECT_ID, companyId: "company-2", name: "Target" });
    const app = await createApp(boardActor);

    const res = await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});

    expect(res.status).toBe(403);
    expect(mockBulkCancelService.cancelOpenIssues).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown projects", async () => {
    mockProjectService.getById.mockResolvedValue(null);
    const app = await createApp(boardActor);

    const res = await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});

    expect(res.status).toBe(404);
  });

  it("starts a background job, interrupts runs per batch and reports completion", async () => {
    mockBulkCancelService.cancelOpenIssues.mockImplementation(async (_companyId, _projectId, opts) => {
      await opts.onBatch({
        cancelledCount: 2,
        cancelledWakeupCount: 1,
        finalizedRoutineRunCount: 0,
        activeRuns: [{ id: "run-1", agentId: "agent-1", issueId: "issue-1" }],
      });
      return summary;
    });
    const app = await createApp(boardActor);

    const res = await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ projectId: PROJECT_ID, status: "running", totalEstimate: 2 });

    const job = await waitForJob(app);
    expect(job).toMatchObject({
      status: "completed",
      cancelledCount: 2,
      batchCount: 1,
      interruptedRunCount: 1,
      cancelledWakeupCount: 1,
      remainingCount: 0,
      error: null,
    });
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");

    const actions = mockLogActivity.mock.calls.map(([, entry]) => entry.action);
    expect(actions).toEqual([
      "project.open_issues_cancel_started",
      "heartbeat.cancelled",
      "project.open_issues_cancelled",
    ]);
    const finished = mockLogActivity.mock.calls.at(-1)![1];
    expect(finished.details).not.toHaveProperty("cancelledIssueIds");
  });

  it("does not start a second job while one is running for the project", async () => {
    let finish!: () => void;
    mockBulkCancelService.cancelOpenIssues.mockImplementation(
      () => new Promise((resolve) => { finish = () => resolve(summary); }),
    );
    const app = await createApp(boardActor);

    const first = await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});
    const second = await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});

    expect(second.status).toBe(202);
    expect(second.body.id).toBe(first.body.id);
    expect(mockBulkCancelService.cancelOpenIssues).toHaveBeenCalledTimes(1);
    finish();
    await waitForJob(app);
  });

  it("marks the job as failed when the service throws", async () => {
    mockBulkCancelService.cancelOpenIssues.mockRejectedValue(new Error("statement timeout"));
    const app = await createApp(boardActor);

    await request(app).post(`/api/projects/${PROJECT_ID}/issues/cancel-open`).send({});
    const job = await waitForJob(app);

    expect(job).toMatchObject({ status: "failed", error: "statement timeout" });
    expect(mockLogActivity.mock.calls.map(([, entry]) => entry.action)).toContain("project.open_issues_cancel_failed");
  });

  it("returns null when no job ran for the project", async () => {
    const app = await createApp(boardActor);

    const res = await request(app).get(`/api/projects/${PROJECT_ID}/issues/cancel-open`);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
