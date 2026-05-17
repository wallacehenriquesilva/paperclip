import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";

function assertInstanceAdmin(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

interface AuthServiceDefinition {
  key: string;
  label: string;
  command: string;
  args: string[];
  credentialPath: string;
  parser: (raw: string) => {
    authenticated: boolean;
    expiresAt: string | null;
    accountLabel: string | null;
  } | null;
}

function home() {
  return process.env.HOME ?? "/paperclip";
}

function parseClaudeCredentials(raw: string) {
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: number; subscription?: string } };
    const oauth = data.claudeAiOauth;
    if (!oauth) return null;
    const expiresAt = typeof oauth.expiresAt === "number" ? new Date(oauth.expiresAt).toISOString() : null;
    const authenticated = expiresAt ? new Date(expiresAt).getTime() > Date.now() : true;
    return {
      authenticated,
      expiresAt,
      accountLabel: typeof oauth.subscription === "string" ? oauth.subscription : null,
    };
  } catch {
    return null;
  }
}

function parseGenericJsonPresence(raw: string) {
  try {
    JSON.parse(raw);
    return { authenticated: true, expiresAt: null, accountLabel: null };
  } catch {
    return null;
  }
}

function authServiceDefinitions(): AuthServiceDefinition[] {
  const h = home();
  return [
    {
      key: "claude",
      label: "Claude Code",
      command: "claude",
      args: ["/login"],
      credentialPath: path.join(h, ".claude", ".credentials.json"),
      parser: parseClaudeCredentials,
    },
    {
      key: "codex",
      label: "Codex",
      command: "codex",
      args: ["login"],
      credentialPath: path.join(h, ".codex", "auth.json"),
      parser: parseGenericJsonPresence,
    },
    {
      key: "cursor",
      label: "Cursor Agent",
      command: "cursor-agent",
      args: ["login"],
      credentialPath: path.join(h, ".cursor", "auth.json"),
      parser: parseGenericJsonPresence,
    },
    {
      key: "gemini",
      label: "Gemini",
      command: "gemini",
      args: ["auth", "login"],
      credentialPath: path.join(h, ".gemini", "oauth_creds.json"),
      parser: parseGenericJsonPresence,
    },
    {
      key: "opencode",
      label: "OpenCode",
      command: "opencode",
      args: ["auth", "login"],
      credentialPath: path.join(h, ".opencode", "auth.json"),
      parser: parseGenericJsonPresence,
    },
  ];
}

async function inspectService(def: AuthServiceDefinition) {
  let exists = false;
  let stat: { uid: number; gid: number; mtime: Date } | null = null;
  try {
    const result = await fs.stat(def.credentialPath);
    exists = true;
    stat = { uid: result.uid, gid: result.gid, mtime: result.mtime };
  } catch {
    /* not present */
  }
  let parsed: ReturnType<AuthServiceDefinition["parser"]> = null;
  if (exists) {
    try {
      const raw = await fs.readFile(def.credentialPath, "utf8");
      parsed = def.parser(raw);
    } catch {
      /* unreadable or invalid */
    }
  }

  const status: "authenticated" | "expired" | "unreadable" | "missing" = !exists
    ? "missing"
    : parsed === null
      ? "unreadable"
      : parsed.authenticated
        ? "authenticated"
        : "expired";

  return {
    key: def.key,
    label: def.label,
    command: def.command,
    args: def.args,
    credentialPath: def.credentialPath,
    status,
    accountLabel: parsed?.accountLabel ?? null,
    expiresAt: parsed?.expiresAt ?? null,
    lastModifiedAt: stat?.mtime.toISOString() ?? null,
  };
}

export function instanceAiAuthRoutes(_db: Db) {
  const router = Router();

  router.get("/instance/ai-auth/status", async (req, res) => {
    assertInstanceAdmin(req);
    const services = await Promise.all(authServiceDefinitions().map(inspectService));
    res.json({ services });
  });

  router.delete("/instance/ai-auth/:serviceKey", async (req, res) => {
    assertInstanceAdmin(req);
    const key = req.params.serviceKey as string;
    const def = authServiceDefinitions().find((entry) => entry.key === key);
    if (!def) {
      res.status(404).json({ error: `Unknown service: ${key}` });
      return;
    }
    try {
      await fs.rm(def.credentialPath, { force: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    res.json({ ok: true, key, credentialPath: def.credentialPath });
  });

  return router;
}
