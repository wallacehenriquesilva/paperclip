import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  companyMcpServerCreateSchema,
  companyMcpServerTestSchema,
  companyMcpServerUpdateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  companyMcpServerService,
  logActivity,
} from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyMcpServerRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = companyMcpServerService(db);

  function canManageMcp(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canManageMcp);
  }

  async function assertCanMutateCompanyMcp(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "mcp:manage");
      if (!allowed) {
        throw forbidden("Missing permission: mcp:manage");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const allowedByGrant = await access.hasPermission(companyId, "agent", actorAgent.id, "mcp:manage");
    if (allowedByGrant || canManageMcp(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: mcp:manage");
  }

  router.get("/companies/:companyId/mcp-servers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/mcp-servers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getById(companyId, id);
    if (!result) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/companies/:companyId/mcp-servers",
    validate(companyMcpServerCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateCompanyMcp(req, companyId);
      const actor = getActorInfo(req);
      const server = await svc.create(
        companyId,
        req.body,
        { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId },
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.mcp_server_created",
        entityType: "company_mcp_server",
        entityId: server.id,
        details: {
          key: server.key,
          name: server.name,
          command: server.command,
          envKeys: Object.keys(server.envTemplate),
        },
      });

      res.status(201).json(server);
    },
  );

  router.patch(
    "/companies/:companyId/mcp-servers/:id",
    validate(companyMcpServerUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCanMutateCompanyMcp(req, companyId);
      const actor = getActorInfo(req);
      const updated = await svc.update(
        companyId,
        id,
        req.body,
        { userId: actor.actorType === "user" ? actor.actorId : null, agentId: actor.agentId },
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.mcp_server_updated",
        entityType: "company_mcp_server",
        entityId: updated.id,
        details: {
          key: updated.key,
          patchedFields: Object.keys(req.body ?? {}),
          envKeys: Object.keys(updated.envTemplate),
          enabled: updated.enabled,
        },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/mcp-servers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertCanMutateCompanyMcp(req, companyId);

    const removed = await svc.delete(companyId, id);
    if (!removed) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "company.mcp_server_deleted",
      entityType: "company_mcp_server",
      entityId: removed.id,
      details: {
        key: removed.key,
        name: removed.name,
      },
    });

    res.json(removed);
  });

  router.post(
    "/companies/:companyId/mcp-servers/:id/test",
    validate(companyMcpServerTestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertCanMutateCompanyMcp(req, companyId);

      const result = await svc.testHandshake(companyId, id, req.body ?? {});

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.mcp_server_tested",
        entityType: "company_mcp_server",
        entityId: id,
        details: {
          ok: result.ok,
          durationMs: result.durationMs,
          serverName: result.serverName,
          toolCount: result.tools.length,
          resourceCount: result.resources.length,
        },
      });

      res.json(result);
    },
  );

  return router;
}
