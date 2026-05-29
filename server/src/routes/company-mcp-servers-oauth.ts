import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  accessService,
  agentService,
  logActivity,
  mcpOAuthService,
  secretService,
} from "../services/index.js";
import type { McpOAuthService } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { loadConfig } from "../config.js";

export interface CompanyMcpOAuthRouteOptions {
  /** Override for tests; otherwise builds from loadConfig().authPublicBaseUrl. */
  publicBaseUrl?: string | null;
  /** Test seam to inject the service (bypasses internal construction). */
  serviceFactory?: (db: Db, publicBaseUrl: string | null) => McpOAuthService;
}

export function companyMcpServerOauthRoutes(db: Db, opts: CompanyMcpOAuthRouteOptions = {}) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);

  function resolvePublicBaseUrl(): string | null {
    if (opts.publicBaseUrl !== undefined) return opts.publicBaseUrl;
    try {
      const cfg = loadConfig();
      return cfg.authPublicBaseUrl ?? null;
    } catch {
      return null;
    }
  }

  const publicBaseUrl = resolvePublicBaseUrl();
  const oauth = (opts.serviceFactory ?? defaultServiceFactory)(db, publicBaseUrl);

  function canManageMcp(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canManageMcp);
  }

  async function assertCanManageMcp(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(companyId, req.actor.userId, "mcp:manage");
      if (!allowed) throw forbidden("Missing permission: mcp:manage");
      return;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const allowedByGrant = await access.hasPermission(
      companyId,
      "agent",
      actorAgent.id,
      "mcp:manage",
    );
    if (allowedByGrant || canManageMcp(actorAgent)) return;
    throw forbidden("Missing permission: mcp:manage");
  }

  router.post(
    "/companies/:companyId/mcp-servers/:id/oauth/authorize",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mcpServerId = req.params.id as string;
      await assertCanManageMcp(req, companyId);
      const actor = getActorInfo(req);
      const result = await oauth.startAuthorization(
        companyId,
        mcpServerId,
        actor.actorType === "user" ? actor.actorId : null,
      );

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mcp.oauth.authorize_initiated",
        entityType: "company_mcp_server",
        entityId: mcpServerId,
        details: { state: result.state, expiresAt: result.expiresAt.toISOString() },
      });

      res.status(201).json(result);
    },
  );

  // OAuth providers redirect here after the user logs in. No auth: the state
  // parameter is the integrity check (single-use, TTL-bound).
  router.get(
    "/companies/:companyId/mcp-servers/oauth/callback",
    async (req, res) => {
      const code = typeof req.query.code === "string" ? req.query.code : null;
      const state = typeof req.query.state === "string" ? req.query.state : null;
      const errorParam = typeof req.query.error === "string" ? req.query.error : null;

      if (errorParam) {
        renderCallbackPage(res, {
          status: "failed",
          message: errorParam,
          mcpServerId: null,
        });
        return;
      }
      if (!code || !state) {
        renderCallbackPage(res, {
          status: "failed",
          message: "Missing code or state in callback",
          mcpServerId: null,
        });
        return;
      }

      try {
        const result = await oauth.completeAuthorization(state, code);
        await logActivity(db, {
          companyId: result.companyId,
          actorType: "user",
          actorId: "oauth-callback",
          action: "mcp.oauth.authorize_completed",
          entityType: "company_mcp_server",
          entityId: result.mcpServerId,
          details: { state },
        });
        renderCallbackPage(res, {
          status: "ok",
          message: "Authorization complete",
          mcpServerId: result.mcpServerId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        renderCallbackPage(res, {
          status: "failed",
          message,
          mcpServerId: null,
        });
      }
    },
  );

  router.post(
    "/companies/:companyId/mcp-servers/:id/oauth/revoke",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mcpServerId = req.params.id as string;
      await assertCanManageMcp(req, companyId);
      const actor = getActorInfo(req);
      await oauth.revoke(companyId, mcpServerId);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "mcp.oauth.revoked",
        entityType: "company_mcp_server",
        entityId: mcpServerId,
        details: {},
      });
      res.status(204).send();
    },
  );

  router.get(
    "/companies/:companyId/mcp-servers/:id/oauth/status",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const mcpServerId = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const status = await oauth.getStatus(companyId, mcpServerId);
      res.json(status);
    },
  );

  router.get(
    "/companies/:companyId/mcp-servers/oauth/callback-url",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      try {
        const url = oauth.buildCallbackUrl(companyId);
        res.json({ callbackUrl: url });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : "Could not derive callback URL" });
      }
    },
  );

  return router;
}

function defaultServiceFactory(db: Db, publicBaseUrl: string | null): McpOAuthService {
  return mcpOAuthService(db, {
    secrets: secretService(db),
    publicBaseUrl,
  });
}

interface CallbackResult {
  status: "ok" | "failed";
  message: string;
  mcpServerId: string | null;
}

function renderCallbackPage(
  res: import("express").Response,
  result: CallbackResult,
) {
  const safeMessage = result.message
    .slice(0, 500)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeServerId = result.mcpServerId
    ? result.mcpServerId.replace(/[^a-zA-Z0-9-]/g, "")
    : null;
  const payload = JSON.stringify({
    paperclipOAuth: {
      status: result.status,
      message: result.message,
      mcpServerId: safeServerId,
    },
  });
  res
    .status(result.status === "ok" ? 200 : 400)
    .setHeader("content-type", "text/html; charset=utf-8")
    .send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>MCP authorization ${result.status === "ok" ? "complete" : "failed"}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem; max-width: 480px; margin: auto; }
    h1 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    p { color: ${result.status === "ok" ? "#16a34a" : "#dc2626"}; }
    code { background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>${result.status === "ok" ? "Authorization complete" : "Authorization failed"}</h1>
  <p>${safeMessage}</p>
  <p>You can close this window.</p>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage(${payload}, "*");
      }
    } catch (e) {
      // best effort
    }
    setTimeout(function () {
      try { window.close(); } catch (e) {}
    }, 1500);
  </script>
</body>
</html>`);
}
