import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import type { BoardApiKeyCreated, BoardApiKeyExpiration, BoardApiKeyStatus } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const EXPIRATION_OPTIONS: { value: BoardApiKeyExpiration; label: string }[] = [
  { value: "1d", label: "1 day" },
  { value: "7d", label: "1 week" },
  { value: "15d", label: "15 days" },
  { value: "30d", label: "1 month" },
  { value: "never", label: "Never" },
];

const STATUS_BADGE: Record<BoardApiKeyStatus, { label: string; variant: "default" | "outline" | "destructive" }> = {
  active: { label: "Active", variant: "default" },
  expired: { label: "Expired", variant: "destructive" },
  revoked: { label: "Revoked", variant: "outline" },
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    try {
      textarea.select();
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  } catch {
    return false;
  }
}

function CreatedKeyPanel({ created, onDismiss }: { created: BoardApiKeyCreated; onDismiss: () => void }) {
  const { pushToast } = useToast();
  const [revealed, setRevealed] = useState(true);

  return (
    <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="text-sm font-semibold text-foreground">API key created — “{created.name}”</div>
      <p className="text-xs text-amber-600 dark:text-amber-500">
        Copy it now. For security it is stored hashed and will never be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
          {revealed ? created.token : created.maskedKey}
        </code>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={revealed ? "Hide key" : "Show full key"}
          title={revealed ? "Hide key" : "Show full key"}
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Copy key to clipboard"
          title="Copy key to clipboard"
          onClick={async () => {
            const ok = await copyToClipboard(created.token);
            pushToast({
              title: ok ? "Key copied to clipboard" : "Failed to copy key",
              tone: ok ? "success" : "error",
            });
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function InstanceApiKeysSection() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState("");
  const [expiration, setExpiration] = useState<BoardApiKeyExpiration>("30d");
  const [createdKey, setCreatedKey] = useState<BoardApiKeyCreated | null>(null);

  const keysQuery = useQuery({
    queryKey: queryKeys.access.boardApiKeys,
    queryFn: () => accessApi.listBoardApiKeys(),
  });

  const createMutation = useMutation({
    mutationFn: () => accessApi.createBoardApiKey({ name: name.trim(), expiration }),
    onSuccess: async (created) => {
      setCreatedKey(created);
      setName("");
      setExpiration("30d");
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardApiKeys });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to create API key",
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) => accessApi.revokeBoardApiKey(keyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.boardApiKeys });
      pushToast({ title: "API key revoked", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: error instanceof Error ? error.message : "Failed to revoke API key",
        tone: "error",
      });
    },
  });

  const isForbidden = keysQuery.error instanceof ApiError && keysQuery.error.status === 403;
  const keys = keysQuery.data ?? [];

  return (
    <section className="space-y-5 rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="text-base font-semibold">Instance API keys</h2>
          <p className="text-sm text-muted-foreground">
            Board API keys for automation (e.g. GitOps imports). Visible to instance admins only.
          </p>
        </div>
      </div>

      <form
        className="flex flex-col gap-3 rounded-lg border border-border bg-background p-4 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) {
            pushToast({ title: "An identifier is required", tone: "error" });
            return;
          }
          createMutation.mutate();
        }}
      >
        <label className="flex-1 space-y-1.5 text-sm">
          <span className="font-medium">Identifier</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. gitops-ci"
            maxLength={120}
          />
        </label>
        <label className="space-y-1.5 text-sm sm:w-44">
          <span className="font-medium">Expires in</span>
          <Select value={expiration} onValueChange={(value) => setExpiration(value as BoardApiKeyExpiration)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRATION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? "Generating…" : "Generate key"}
        </Button>
      </form>

      {createdKey ? (
        <CreatedKeyPanel created={createdKey} onDismiss={() => setCreatedKey(null)} />
      ) : null}

      {keysQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading API keys…</div>
      ) : isForbidden ? (
        <div className="text-sm text-destructive">Instance admin access is required to manage API keys.</div>
      ) : keysQuery.error ? (
        <div className="text-sm text-destructive">
          {keysQuery.error instanceof Error ? keysQuery.error.message : "Failed to load API keys."}
        </div>
      ) : keys.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No API keys yet. Generate one above.
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => {
            const badge = STATUS_BADGE[key.status];
            return (
              <div
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{key.name}</span>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <code className="block font-mono text-xs text-muted-foreground">{key.maskedKey}</code>
                  <div className="text-xs text-muted-foreground">
                    {key.owner ? `${key.owner.name || key.owner.email || key.owner.id} · ` : ""}
                    created {formatDate(key.createdAt)} · expires {key.expiresAt ? formatDate(key.expiresAt) : "never"} · last used {formatDate(key.lastUsedAt)}
                  </div>
                </div>
                {key.status !== "revoked" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revokeMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Revoke API key “${key.name}”? This cannot be undone.`)) {
                        revokeMutation.mutate(key.id);
                      }
                    }}
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    Revoke
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
