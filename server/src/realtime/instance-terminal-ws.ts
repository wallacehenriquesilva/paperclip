import { createRequire } from "node:module";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";

interface WsSocket {
  readyState: number;
  send(data: string | Buffer): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
}

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      cols?: number;
      rows?: number;
      name?: string;
    },
  ): PtyProcess;
}

const requireFromModule = createRequire(import.meta.url);
const { WebSocketServer } = requireFromModule("ws") as {
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

/**
 * Binaries that the embedded admin terminal is allowed to spawn. Everything
 * else is rejected before any process starts. Keep this list small and
 * focused on interactive auth/setup flows.
 */
export const INSTANCE_TERMINAL_ALLOWED_COMMANDS: ReadonlyArray<string> = [
  "claude",
  "codex",
  "cursor-agent",
  "gemini",
  "opencode",
  "gh",
  "uv",
  "uvx",
];

const INSTANCE_TERMINAL_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const INSTANCE_TERMINAL_MAX_INPUT_BYTES = 64 * 1024;
const INSTANCE_TERMINAL_MAX_COMMAND_BYTES = 4 * 1024;

interface UpgradeContext {
  userId: string;
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipTerminalContext?: UpgradeContext;
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  socket.destroy();
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  // local_trusted treats the local browser as a board admin with full power.
  if (opts.deploymentMode === "local_trusted") {
    return { userId: "board" };
  }

  if (!opts.resolveSessionFromHeaders) return null;
  const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
  const userId = session?.user?.id;
  if (!userId) return null;

  // Only instance admins (the highest role) may open the terminal.
  const roleRow = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  if (!roleRow) return null;

  // Touch the membership table to surface deactivated users immediately.
  // We don't gate on a specific company — the terminal is instance-wide.
  await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(eq(companyMemberships.principalId, userId));

  return { userId };
}

interface SpawnRequest {
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
}

function parseSpawnRequest(raw: unknown): { ok: true; spawn: SpawnRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "spawn payload must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) return { ok: false, error: "command is required" };
  if (command.length > INSTANCE_TERMINAL_MAX_COMMAND_BYTES) {
    return { ok: false, error: "command exceeds size limit" };
  }
  if (!INSTANCE_TERMINAL_ALLOWED_COMMANDS.includes(command)) {
    return {
      ok: false,
      error: `command "${command}" is not in the allowlist (${INSTANCE_TERMINAL_ALLOWED_COMMANDS.join(", ")})`,
    };
  }
  const args = Array.isArray(record.args)
    ? record.args
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  if (args.some((arg) => arg.length > INSTANCE_TERMINAL_MAX_COMMAND_BYTES)) {
    return { ok: false, error: "argument exceeds size limit" };
  }
  const cols = typeof record.cols === "number" && Number.isFinite(record.cols)
    ? Math.max(20, Math.min(500, Math.floor(record.cols)))
    : 80;
  const rows = typeof record.rows === "number" && Number.isFinite(record.rows)
    ? Math.max(8, Math.min(200, Math.floor(record.rows)))
    : 24;
  return { ok: true, spawn: { command, args, cols, rows } };
}

function loadPtyModule(): PtyModule | null {
  try {
    return requireFromModule("node-pty") as PtyModule;
  } catch (err) {
    logger.error({ err }, "node-pty is not available — instance terminal disabled");
    return null;
  }
}

export function setupInstanceTerminalWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const pty = loadPtyModule();
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Map<WsSocket, {
    child: PtyProcess | null;
    timer: NodeJS.Timeout | null;
    userId: string;
    lastCommand: string | null;
    commandStartedAt: number | null;
    closed: boolean;
  }>();

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipTerminalContext;
    if (!context) {
      socket.close(1011, "missing context");
      return;
    }

    const session = {
      child: null as PtyProcess | null,
      timer: null as NodeJS.Timeout | null,
      userId: context.userId,
      lastCommand: null as string | null,
      commandStartedAt: null as number | null,
      closed: false,
    };
    sessions.set(socket, session);

    function sendJson(payload: Record<string, unknown>) {
      if (session.closed) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch (err) {
        logger.warn({ err }, "failed to send to terminal client");
      }
    }

    function resetIdleTimer() {
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        sendJson({ type: "info", message: "terminal session timed out after 15 minutes of inactivity" });
        teardown(1000, "idle timeout");
      }, INSTANCE_TERMINAL_IDLE_TIMEOUT_MS);
    }

    function teardown(code: number, reason: string) {
      if (session.closed) return;
      session.closed = true;
      if (session.timer) clearTimeout(session.timer);
      if (session.child) {
        try {
          // Kill the whole process group so any backgrounded children die too.
          process.kill(-session.child.pid, "SIGTERM");
        } catch {
          try {
            session.child.kill("SIGTERM");
          } catch {
            /* noop */
          }
        }
      }
      try {
        socket.close(code, reason);
      } catch {
        /* noop */
      }
      sessions.delete(socket);
    }

    function spawnPty(spawn: SpawnRequest) {
      if (session.child) {
        sendJson({ type: "error", message: "a process is already running in this session" });
        return;
      }
      if (!pty) {
        sendJson({ type: "error", message: "terminal backend unavailable (node-pty failed to load)" });
        return;
      }
      try {
        const child = pty.spawn(spawn.command, spawn.args ?? [], {
          cwd: process.env.HOME ?? "/paperclip",
          env: { ...process.env } as Record<string, string>,
          cols: spawn.cols,
          rows: spawn.rows,
          name: "xterm-256color",
        });
        session.child = child;
        session.lastCommand = `${spawn.command}${spawn.args?.length ? ` ${spawn.args.join(" ")}` : ""}`;
        session.commandStartedAt = Date.now();
        child.onData((data) => {
          if (session.closed) return;
          try {
            socket.send(data);
          } catch (err) {
            logger.warn({ err }, "failed to forward pty data");
          }
        });
        child.onExit(({ exitCode }) => {
          const durationMs = session.commandStartedAt ? Date.now() - session.commandStartedAt : null;
          logger.info(
            {
              event: "instance.terminal_command",
              userId: session.userId,
              command: session.lastCommand,
              exitCode,
              durationMs,
            },
            "instance terminal command completed",
          );
          sendJson({ type: "exit", exitCode });
          session.child = null;
          session.lastCommand = null;
          session.commandStartedAt = null;
        });
        sendJson({ type: "spawn_ok", command: session.lastCommand });
      } catch (err) {
        sendJson({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }

    socket.on("message", (raw) => {
      resetIdleTimer();
      let parsed: unknown;
      const text = raw.toString("utf8");
      if (text.length > INSTANCE_TERMINAL_MAX_INPUT_BYTES) {
        sendJson({ type: "error", message: "message exceeds size limit" });
        return;
      }
      try {
        parsed = JSON.parse(text);
      } catch {
        sendJson({ type: "error", message: "invalid JSON message" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson({ type: "error", message: "message must be a JSON object" });
        return;
      }
      const message = parsed as Record<string, unknown>;
      const kind = typeof message.type === "string" ? message.type : "";
      switch (kind) {
        case "spawn": {
          const result = parseSpawnRequest(message);
          if (!result.ok) {
            sendJson({ type: "error", message: result.error });
            return;
          }
          spawnPty(result.spawn);
          return;
        }
        case "input": {
          if (!session.child) {
            sendJson({ type: "error", message: "no process is running" });
            return;
          }
          const data = typeof message.data === "string" ? message.data : "";
          if (data.length === 0) return;
          session.child.write(data);
          return;
        }
        case "resize": {
          if (!session.child) return;
          const cols = typeof message.cols === "number" && Number.isFinite(message.cols)
            ? Math.max(20, Math.min(500, Math.floor(message.cols)))
            : null;
          const rows = typeof message.rows === "number" && Number.isFinite(message.rows)
            ? Math.max(8, Math.min(200, Math.floor(message.rows)))
            : null;
          if (cols !== null && rows !== null) {
            try {
              session.child.resize(cols, rows);
            } catch (err) {
              logger.warn({ err }, "failed to resize pty");
            }
          }
          return;
        }
        case "kill": {
          if (session.child) {
            try {
              session.child.kill("SIGTERM");
            } catch {
              /* noop */
            }
          }
          return;
        }
        default:
          sendJson({ type: "error", message: `unknown message type: ${kind}` });
      }
    });

    socket.on("close", () => {
      teardown(1000, "client closed");
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, userId: context.userId }, "instance terminal socket error");
      teardown(1011, "socket error");
    });

    resetIdleTimer();
    logger.info(
      { event: "instance.terminal_opened", userId: context.userId },
      "instance terminal session opened",
    );
    sendJson({
      type: "ready",
      allowedCommands: INSTANCE_TERMINAL_ALLOWED_COMMANDS,
      idleTimeoutMs: INSTANCE_TERMINAL_IDLE_TIMEOUT_MS,
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) return;
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/api/instance/terminal/ws") return;

    void authorizeUpgrade(db, req, opts)
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }
        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipTerminalContext = context;
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "instance terminal upgrade authorization failed");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return {
    wss,
    closeAll: () => {
      for (const socket of wss.clients) {
        try {
          socket.terminate();
        } catch {
          /* noop */
        }
      }
      sessions.clear();
    },
  };
}
