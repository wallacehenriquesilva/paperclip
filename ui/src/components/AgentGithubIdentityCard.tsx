import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  RotateCw,
  Github as GithubIcon,
} from "lucide-react";
import type {
  AgentGithubIdentityInput,
  AgentGithubIdentityStatus,
  AgentGithubIdentityView,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToastActions } from "../context/ToastContext";
import { agentGithubIdentityApi } from "../api/agentGithubIdentity";
import { secretsApi } from "../api/secrets";

interface Props {
  agentId: string;
  companyId: string;
}

function statusBadge(status: AgentGithubIdentityStatus) {
  switch (status) {
    case "connected":
      return { label: "Connected", icon: CheckCircle2, tone: "text-green-600 dark:text-green-400" };
    case "missing_token":
      return { label: "Token missing or unbound", icon: AlertCircle, tone: "text-amber-600 dark:text-amber-400" };
    case "incomplete":
      return { label: "Incomplete — missing email or name", icon: AlertCircle, tone: "text-amber-600 dark:text-amber-400" };
    case "not_configured":
      return { label: "Not configured", icon: XCircle, tone: "text-muted-foreground" };
  }
}

export function AgentGithubIdentityCard({ agentId, companyId }: Props) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const identityQuery = useQuery({
    queryKey: ["agent-github-identity", agentId],
    queryFn: () => agentGithubIdentityApi.read(agentId),
    refetchOnWindowFocus: true,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["agent-github-identity", agentId] });

  const clearMutation = useMutation({
    mutationFn: () => agentGithubIdentityApi.clear(agentId),
    onSuccess: async () => {
      await invalidate();
      pushToast({ tone: "success", title: "GitHub disconnected", body: "Credentials cleared for this agent." });
    },
    onError: (err) =>
      pushToast({
        tone: "error",
        title: "Failed to disconnect",
        body: err instanceof Error ? err.message : String(err),
      }),
  });

  const testMutation = useMutation({
    mutationFn: () => agentGithubIdentityApi.test(agentId),
    onSuccess: (result) => {
      if (result.ok) {
        pushToast({ tone: "success", title: "GitHub access OK", body: result.detail ?? "Authenticated." });
      } else {
        pushToast({ tone: "error", title: `GitHub test: ${result.status}`, body: result.detail ?? "" });
      }
    },
    onError: (err) =>
      pushToast({
        tone: "error",
        title: "Test failed",
        body: err instanceof Error ? err.message : String(err),
      }),
  });

  const view = identityQuery.data;
  const isConnected = view && view.status !== "not_configured";

  if (identityQuery.isLoading) {
    return (
      <section className="rounded-md border border-border bg-card p-4">
        <header className="flex items-center gap-2">
          <GithubIcon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">GitHub</h3>
        </header>
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      </section>
    );
  }

  if (identityQuery.error) {
    return (
      <section className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load GitHub identity: {(identityQuery.error as Error).message}
      </section>
    );
  }

  if (!view) return null;

  const badge = statusBadge(view.status);
  const StatusIcon = badge.icon;

  return (
    <section className="rounded-md border border-border bg-card p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <GithubIcon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">GitHub</h3>
          <span className={`flex items-center gap-1 text-xs ${badge.tone}`}>
            <StatusIcon className="h-3.5 w-3.5" />
            {badge.label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isConnected ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                Test
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => clearMutation.mutate()}
                disabled={clearMutation.isPending}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)}>
              Connect GitHub
            </Button>
          )}
        </div>
      </header>

      {isConnected ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <Row label="Username">{view.username ? `@${view.username}` : "—"}</Row>
          <Row label="Token secret">{view.tokenSecretName ?? "(not bound)"}</Row>
          <Row label="Commit email">{view.userEmail ?? "—"}</Row>
          <Row label="Commit name">{view.userName ?? "—"}</Row>
        </dl>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Configure to let this agent clone, push, and open PRs as a specific GitHub user.
        </p>
      )}

      <EditDialog
        agentId={agentId}
        companyId={companyId}
        current={view}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          await invalidate();
          setEditing(false);
        }}
      />
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  );
}

function EditDialog({
  agentId,
  companyId,
  current,
  open,
  onClose,
  onSaved,
}: {
  agentId: string;
  companyId: string;
  current: AgentGithubIdentityView;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { pushToast } = useToastActions();
  const [username, setUsername] = useState(current.username ?? "");
  const [userEmail, setUserEmail] = useState(current.userEmail ?? "");
  const [userName, setUserName] = useState(current.userName ?? "");
  const [tokenSecretId, setTokenSecretId] = useState(current.tokenSecretId ?? "");

  useEffect(() => {
    if (!open) return;
    setUsername(current.username ?? "");
    setUserEmail(current.userEmail ?? "");
    setUserName(current.userName ?? "");
    setTokenSecretId(current.tokenSecretId ?? "");
  }, [open, current]);

  const secretsQuery = useQuery({
    queryKey: ["secrets", companyId],
    queryFn: () => secretsApi.list(companyId),
    enabled: open,
  });

  const saveMutation = useMutation({
    mutationFn: (payload: AgentGithubIdentityInput) => agentGithubIdentityApi.set(agentId, payload),
    onSuccess: async () => {
      pushToast({ tone: "success", title: "GitHub identity saved" });
      await onSaved();
    },
    onError: (err) =>
      pushToast({
        tone: "error",
        title: "Save failed",
        body: err instanceof Error ? err.message : String(err),
      }),
  });

  const canSave = username.trim().length > 0 || userEmail.trim().length > 0 || tokenSecretId.length > 0;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>GitHub identity</DialogTitle>
          <DialogDescription>
            Bind a company secret as the GitHub token and set the commit author for this agent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="GitHub username (display only)">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="paperclip-bot-eng" />
          </Field>
          <Field label="Commit email" hint="Used as git config user.email">
            <Input
              type="email"
              value={userEmail}
              onChange={(e) => setUserEmail(e.target.value)}
              placeholder="bot@your-domain.example"
            />
          </Field>
          <Field label="Commit name" hint="Used as git config user.name">
            <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Paperclip Bot" />
          </Field>
          <Field label="Token secret" hint="Company secret that holds the PAT or app token">
            <Select value={tokenSecretId || "__none__"} onValueChange={(value) => setTokenSecretId(value === "__none__" ? "" : value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a secret" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">(none)</SelectItem>
                {(secretsQuery.data ?? []).map((secret) => (
                  <SelectItem key={secret.id} value={secret.id}>
                    {secret.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saveMutation.isPending}>
            Cancel
          </Button>
          <Button
            disabled={!canSave || saveMutation.isPending}
            onClick={() =>
              saveMutation.mutate({
                username: username.trim() || null,
                userEmail: userEmail.trim() || null,
                userName: userName.trim() || null,
                tokenSecretId: tokenSecretId || null,
              })
            }
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
