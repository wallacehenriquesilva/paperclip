import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createManagedBoardApiKey: vi.fn(),
  listManagedBoardApiKeys: vi.fn(),
  getBoardApiKeyById: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

let appImportCounter = 0;

async function createApp(actor: any, db: any = {} as any) {
  appImportCounter += 1;
  const routeModulePath = `../routes/access.js?board-api-key-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?board-api-key-routes-${appImportCounter}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { ...actor };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

const adminActor = { type: "board", source: "session", userId: "user-admin" };
const memberActor = { type: "board", source: "session", userId: "user-member" };

describe.sequential("board API key routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it.sequential("lists keys for an instance admin", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockBoardAuthService.listManagedBoardApiKeys.mockResolvedValue([
      {
        id: "key-1",
        name: "gitops-ci",
        maskedKey: "pcp_board_••••1a2b",
        status: "active",
        owner: { id: "user-admin", name: "Admin", email: "admin@example.com" },
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdAt: "2026-06-28T00:00:00.000Z",
      },
    ]);

    const app = await createApp(adminActor);
    const res = await request(app).get("/api/admin/board-api-keys");

    expect(res.status, res.text).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: "key-1", maskedKey: "pcp_board_••••1a2b" });
  });

  it.sequential("forbids non-admins from listing keys", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);

    const app = await createApp(memberActor);
    const res = await request(app).get("/api/admin/board-api-keys");

    expect(res.status).toBe(403);
    expect(mockBoardAuthService.listManagedBoardApiKeys).not.toHaveBeenCalled();
  });

  it.sequential("creates a key owned by the current admin and returns the token once", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockBoardAuthService.createManagedBoardApiKey.mockResolvedValue({
      id: "key-2",
      name: "gitops-ci",
      token: "pcp_board_secrettoken",
      maskedKey: "pcp_board_••••oken",
      expiresAt: null,
      createdAt: "2026-06-28T00:00:00.000Z",
    });

    const app = await createApp(adminActor);
    const res = await request(app)
      .post("/api/admin/board-api-keys")
      .send({ name: "gitops-ci", expiration: "never" });

    expect(res.status, res.text).toBe(201);
    expect(res.body.token).toBe("pcp_board_secrettoken");
    expect(mockBoardAuthService.createManagedBoardApiKey).toHaveBeenCalledWith({
      userId: "user-admin",
      name: "gitops-ci",
      expiration: "never",
    });
  });

  it.sequential("rejects an invalid expiration option", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);

    const app = await createApp(adminActor);
    const res = await request(app)
      .post("/api/admin/board-api-keys")
      .send({ name: "gitops-ci", expiration: "100y" });

    expect(res.status).toBe(400);
    expect(mockBoardAuthService.createManagedBoardApiKey).not.toHaveBeenCalled();
  });

  it.sequential("revokes an existing key", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockBoardAuthService.getBoardApiKeyById.mockResolvedValue({ id: "key-3" });
    mockBoardAuthService.revokeBoardApiKey.mockResolvedValue({ id: "key-3" });

    const app = await createApp(adminActor);
    const res = await request(app).delete("/api/admin/board-api-keys/key-3");

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockBoardAuthService.revokeBoardApiKey).toHaveBeenCalledWith("key-3");
  });

  it.sequential("returns 404 when revoking a missing key", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockBoardAuthService.getBoardApiKeyById.mockResolvedValue(null);

    const app = await createApp(adminActor);
    const res = await request(app).delete("/api/admin/board-api-keys/missing");

    expect(res.status).toBe(404);
    expect(mockBoardAuthService.revokeBoardApiKey).not.toHaveBeenCalled();
  });
});
