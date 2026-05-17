import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { Terminal as TerminalIcon, AlertTriangle } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";

type ConnectionState = "idle" | "connecting" | "ready" | "running" | "closed" | "error";

interface ReadyPayload {
  allowedCommands: string[];
  idleTimeoutMs: number;
}

const QUICK_LOGIN_BUTTONS: Array<{ label: string; command: string; args: string[] }> = [
  { label: "claude /login", command: "claude", args: ["/login"] },
  { label: "codex login", command: "codex", args: ["login"] },
  { label: "cursor-agent login", command: "cursor-agent", args: ["login"] },
  { label: "gemini auth login", command: "gemini", args: ["auth", "login"] },
  { label: "opencode auth login", command: "opencode", args: ["auth", "login"] },
];

export function InstanceTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const { setBreadcrumbs } = useBreadcrumbs();

  const [state, setState] = useState<ConnectionState>("idle");
  const [allowedCommands, setAllowedCommands] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [currentCommand, setCurrentCommand] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance settings", href: "/instance/settings/general" },
      { label: "Terminal" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: { background: "#0a0a0a" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const handleResize = () => {
      try {
        fit.fit();
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* noop */
      }
    };
    window.addEventListener("resize", handleResize);

    const dataDisposable = term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      window.removeEventListener("resize", handleResize);
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const writeTerm = useCallback((text: string) => {
    termRef.current?.write(text);
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState !== WebSocket.CLOSED) return;
    setState("connecting");
    setErrorMessage(null);
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/api/instance/terminal/ws`;
    const socket = new WebSocket(url);
    socketRef.current = socket;
    writeTerm("\r\n\x1b[2mConnecting...\x1b[0m\r\n");

    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      // Server frames are JSON envelopes; pty output also arrives as JSON-wrapped
      // strings? No — we send pty output as raw strings via socket.send(data).
      // So we attempt to JSON.parse and fall through to raw write if it fails.
      if (raw.startsWith("{")) {
        try {
          const message = JSON.parse(raw) as Record<string, unknown>;
          if (typeof message.type === "string") {
            handleEnvelope(message);
            return;
          }
        } catch {
          /* fallthrough to raw write */
        }
      }
      writeTerm(raw);
    };
    socket.onerror = () => {
      setState("error");
      setErrorMessage("WebSocket error — check your connection and admin permissions.");
    };
    socket.onclose = () => {
      setState("closed");
      setCurrentCommand(null);
      writeTerm("\r\n\x1b[2mSession closed.\x1b[0m\r\n");
    };
  }, [writeTerm]);

  const handleEnvelope = useCallback((message: Record<string, unknown>) => {
    switch (message.type) {
      case "ready": {
        const payload = message as unknown as ReadyPayload;
        setAllowedCommands(Array.isArray(payload.allowedCommands) ? payload.allowedCommands : []);
        setState("ready");
        writeTerm(
          `\r\n\x1b[32m✓ Connected.\x1b[0m Allowed commands: ${(payload.allowedCommands ?? []).join(", ")}\r\n`,
        );
        return;
      }
      case "spawn_ok": {
        const command = typeof message.command === "string" ? message.command : "";
        setCurrentCommand(command);
        setState("running");
        writeTerm(`\r\n\x1b[34m$ ${command}\x1b[0m\r\n`);
        return;
      }
      case "exit": {
        const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
        const color = exitCode === 0 ? "\x1b[32m" : "\x1b[31m";
        writeTerm(`\r\n${color}Process exited (code ${exitCode ?? "?"}).\x1b[0m\r\n`);
        setCurrentCommand(null);
        setState("ready");
        return;
      }
      case "error": {
        const text = typeof message.message === "string" ? message.message : "Unknown error";
        writeTerm(`\r\n\x1b[31m✗ ${text}\x1b[0m\r\n`);
        setErrorMessage(text);
        return;
      }
      case "info": {
        const text = typeof message.message === "string" ? message.message : "";
        writeTerm(`\r\n\x1b[33m${text}\x1b[0m\r\n`);
        return;
      }
      default:
        return;
    }
  }, [writeTerm]);

  const disconnect = useCallback(() => {
    socketRef.current?.close(1000, "user closed");
    socketRef.current = null;
  }, []);

  const runCommand = useCallback((command: string, args: string[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setErrorMessage("Not connected. Click Connect first.");
      return;
    }
    const term = termRef.current;
    socket.send(JSON.stringify({
      type: "spawn",
      command,
      args,
      cols: term?.cols ?? 80,
      rows: term?.rows ?? 24,
    }));
  }, []);

  const killProcess = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "kill" }));
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  const statusText = useMemo(() => {
    switch (state) {
      case "idle": return "Not connected";
      case "connecting": return "Connecting...";
      case "ready": return "Connected · idle";
      case "running": return `Running: ${currentCommand ?? "(unknown)"}`;
      case "closed": return "Closed";
      case "error": return "Error";
    }
  }, [state, currentCommand]);

  const isRunnable = state === "ready";
  const isRunning = state === "running";

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Instance terminal</h1>
          <p className="text-sm text-muted-foreground">
            Admin-only. Runs as <code className="font-mono">node</code> inside the Paperclip
            container with a strict command allowlist.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border px-3 py-1 text-xs">
            {statusText}
          </span>
          {state === "idle" || state === "closed" || state === "error" ? (
            <Button size="sm" onClick={connect}>Connect</Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={disconnect}>Disconnect</Button>
          )}
        </div>
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Only the following binaries can be spawned: {allowedCommands.length === 0 ? "(load by connecting)" : allowedCommands.join(", ")}.
            Sessions time out after 15 minutes of inactivity.
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Quick login:</span>
        {QUICK_LOGIN_BUTTONS.map((item) => (
          <Button
            key={item.label}
            size="sm"
            variant="outline"
            disabled={!isRunnable}
            onClick={() => runCommand(item.command, item.args)}
            className="font-mono text-xs"
          >
            {item.label}
          </Button>
        ))}
        {isRunning ? (
          <Button size="sm" variant="ghost" onClick={killProcess} className="ml-auto">
            Send SIGTERM
          </Button>
        ) : null}
      </div>

      {errorMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="flex-1 overflow-hidden rounded-md border border-border bg-black p-2"
      />

      {state === "idle" && allowedCommands.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <EmptyState icon={TerminalIcon} message="Click Connect to open a terminal." />
        </div>
      ) : null}
    </div>
  );
}
