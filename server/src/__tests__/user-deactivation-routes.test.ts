import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  deactivateUser: vi.fn(),
  reactivateUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockBoardAuthService = vi.hoisted(() => ({}));
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
  const routeModulePath = `../routes/access.js?user-deactivation-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?user-deactivation-routes-${appImportCounter}`;
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

describe.sequential("user deactivation routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it.sequential("deactivates a user as an instance admin", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.deactivateUser.mockResolvedValue({
      id: "user-target",
      deactivatedAt: new Date("2026-06-28T00:00:00.000Z"),
    });

    const app = await createApp(adminActor);
    const res = await request(app).post("/api/admin/users/user-target/deactivate");

    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: "user-target" });
    expect(res.body.deactivatedAt).toBeTruthy();
    expect(mockAccessService.deactivateUser).toHaveBeenCalledWith("user-target");
  });

  it.sequential("refuses to deactivate your own account", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);

    const app = await createApp(adminActor);
    const res = await request(app).post("/api/admin/users/user-admin/deactivate");

    expect(res.status).toBe(409);
    expect(mockAccessService.deactivateUser).not.toHaveBeenCalled();
  });

  it.sequential("forbids non-admins from deactivating users", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(false);

    const app = await createApp(memberActor);
    const res = await request(app).post("/api/admin/users/user-target/deactivate");

    expect(res.status).toBe(403);
    expect(mockAccessService.deactivateUser).not.toHaveBeenCalled();
  });

  it.sequential("returns 404 when deactivating a missing user", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.deactivateUser.mockResolvedValue(null);

    const app = await createApp(adminActor);
    const res = await request(app).post("/api/admin/users/missing/deactivate");

    expect(res.status).toBe(404);
  });

  it.sequential("reactivates a user as an instance admin", async () => {
    mockAccessService.isInstanceAdmin.mockResolvedValue(true);
    mockAccessService.reactivateUser.mockResolvedValue({ id: "user-target", deactivatedAt: null });

    const app = await createApp(adminActor);
    const res = await request(app).post("/api/admin/users/user-target/reactivate");

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({ id: "user-target", deactivatedAt: null });
    expect(mockAccessService.reactivateUser).toHaveBeenCalledWith("user-target");
  });
});
