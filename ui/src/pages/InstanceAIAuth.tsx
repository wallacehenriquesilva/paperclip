import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { instanceAiAuthApi, type InstanceAiAuthService } from "../api/instanceAiAuth";
import { CheckCircle2, AlertCircle, XCircle, RotateCw, LogOut } from "lucide-react";

function statusBadge(status: InstanceAiAuthService["status"]) {
  switch (status) {
    case "authenticated":
      return { label: "Authenticated", icon: CheckCircle2, tone: "text-green-600 dark:text-green-400" };
    case "expired":
      return { label: "Expired", icon: AlertCircle, tone: "text-amber-600 dark:text-amber-400" };
    case "unreadable":
      return { label: "Unreadable", icon: AlertCircle, tone: "text-amber-600 dark:text-amber-400" };
    case "missing":
      return { label: "Not authenticated", icon: XCircle, tone: "text-muted-foreground" };
  }
}

function relativeFromNow(iso: string | null) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  const future = ms > 0;
  const abs = Math.abs(ms);
  const days = Math.floor(abs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((abs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days >= 1) return future ? `in ${days}d` : `${days}d ago`;
  if (hours >= 1) return future ? `in ${hours}h` : `${hours}h ago`;
  return future ? "in <1h" : "just now";
}

function TerminalModal({
  service,
  open,
  onClose,
  onCompleted,
}: {
  service: InstanceAiAuthService | null;
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const completedRef = useRef(false);
  const [statusText, setStatusText] = useState("Connecting...");

  useEffect(() => {
    if (!open || !containerRef.current || !service) return;
    completedRef.current = false;
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
    term.open(containerRef.current);
    requestAnimationFrame(() => fit.fit());
    termRef.current = term;
    fitRef.current = fit;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/api/instance/terminal/ws`;
    const socket = new WebSocket(url);
    socketRef.current = socket;
    term.write(`\x1b[2mOpening terminal for ${service.label}...\x1b[0m\r\n`);

    socket.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (raw.startsWith("{")) {
        try {
          const message = JSON.parse(raw) as Record<string, unknown>;
          if (typeof message.type === "string") {
            switch (message.type) {
              case "ready":
                setStatusText("Starting login...");
                socket.send(JSON.stringify({
                  type: "spawn",
                  command: service.command,
                  args: service.args,
                  cols: term.cols,
                  rows: term.rows,
                }));
                return;
              case "spawn_ok":
                setStatusText("Login in progress · follow the prompts");
                return;
              case "exit": {
                const exitCode = typeof message.exitCode === "number" ? message.exitCode : null;
                if (exitCode === 0) {
                  setStatusText("Login complete · refreshing status...");
                  completedRef.current = true;
                  setTimeout(() => onCompleted(), 1500);
                } else {
                  setStatusText(`Process exited (code ${exitCode ?? "?"})`);
                }
                return;
              }
              case "error":
                setStatusText(`Error: ${message.message ?? "unknown"}`);
                term.write(`\r\n\x1b[31m✗ ${message.message ?? ""}\x1b[0m\r\n`);
                return;
              case "info":
                term.write(`\r\n\x1b[33m${message.message ?? ""}\x1b[0m\r\n`);
                return;
            }
            return;
          }
        } catch {
          /* fallthrough */
        }
      }
      term.write(raw);
    };
    socket.onerror = () => setStatusText("WebSocket error");
    socket.onclose = () => {
      if (!completedRef.current) setStatusText("Connection closed");
    };

    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const handleResize = () => {
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* noop */
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      dataDisposable.dispose();
      try {
        socket.close(1000, "modal closed");
      } catch {
        /* noop */
      }
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [open, service, onCompleted]);

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{service ? `Authenticate ${service.label}` : "Authenticate"}</DialogTitle>
          <DialogDescription>
            <span className="text-xs">{statusText}</span>
          </DialogDescription>
        </DialogHeader>
        <div ref={containerRef} className="h-[420px] overflow-hidden rounded-md border border-border bg-black p-2" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstanceAIAuth() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [active, setActive] = useState<InstanceAiAuthService | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance settings", href: "/instance/settings/general" },
      { label: "AI authentication" },
    ]);
  }, [setBreadcrumbs]);

  const statusQuery = useQuery({
    queryKey: ["instance-ai-auth-status"],
    queryFn: () => instanceAiAuthApi.status(),
    refetchOnWindowFocus: true,
  });

  const signOutMutation = useMutation({
    mutationFn: (key: string) => instanceAiAuthApi.signOut(key),
    onSuccess: async (_data, key) => {
      await queryClient.invalidateQueries({ queryKey: ["instance-ai-auth-status"] });
      pushToast({ tone: "success", title: "Signed out", body: `${key} credentials removed.` });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Sign out failed",
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const handleAuthCompleted = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["instance-ai-auth-status"] });
    setActive(null);
  }, [queryClient]);

  const services = useMemo(() => statusQuery.data?.services ?? [], [statusQuery.data]);

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">AI authentication</h1>
        <p className="text-sm text-muted-foreground">
          Manage Claude / Codex / Cursor / Gemini / OpenCode CLI logins from here.
          Admin-only. Credentials are stored under the Paperclip data volume and
          reused across agent runs.
        </p>
      </div>

      {statusQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : statusQuery.error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {(statusQuery.error as Error).message}
        </div>
      ) : (
        <ul className="space-y-3">
          {services.map((service) => {
            const badge = statusBadge(service.status);
            const Icon = badge.icon;
            const expiresLabel = relativeFromNow(service.expiresAt);
            return (
              <li
                key={service.key}
                className="flex items-start justify-between gap-4 rounded-md border border-border bg-card p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{service.label}</span>
                    <span className={`flex items-center gap-1 text-xs ${badge.tone}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {service.accountLabel ? <span>Account: {service.accountLabel}</span> : null}
                    {expiresLabel ? <span>Expires {expiresLabel}</span> : null}
                    <span>
                      Path:{" "}
                      <code className="font-mono">{service.credentialPath}</code>
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        onClick={() => setActive(service)}
                      >
                        <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                        {service.status === "authenticated" ? "Re-authenticate" : "Authenticate"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Will run {`${service.command} ${service.args.join(" ")}`} in a terminal
                    </TooltipContent>
                  </Tooltip>
                  {service.status === "authenticated" || service.status === "expired" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={signOutMutation.isPending}
                      onClick={() => signOutMutation.mutate(service.key)}
                    >
                      <LogOut className="mr-1.5 h-3.5 w-3.5" />
                      Sign out
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <TerminalModal
        service={active}
        open={active !== null}
        onClose={() => setActive(null)}
        onCompleted={handleAuthCompleted}
      />
    </div>
  );
}
