import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { secretsApi } from "../api/secrets";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SECRET_REFERENCE_PATTERN = /^\$\{secret:([a-z0-9][a-z0-9_-]*)\}$/;

function parseSecretRef(value: string): string | null {
  const match = value.match(SECRET_REFERENCE_PATTERN);
  return match ? (match[1] ?? null) : null;
}

function buildSecretRef(key: string): string {
  return `\${secret:${key}}`;
}

function suggestSecretKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * A reusable picker for `${secret:...}` references against the company's
 * secrets store. Lists existing secrets in a dropdown and lets the operator
 * create a new one inline (paste once, reuse anywhere). Returns the parent
 * a `${secret:<key>}` string that the server can resolve at runtime.
 */
export function SecretRefPicker({
  companyId,
  value,
  onChange,
  placeholder = "Pick or create a secret",
  /** Optional prefix shown in the "create new" name suggestion. */
  newSecretNameHint,
}: {
  companyId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  newSecretNameHint?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(newSecretNameHint ?? "");
  const [newValue, setNewValue] = useState("");

  const secretsQuery = useQuery({
    queryKey: ["secrets", companyId],
    queryFn: () => secretsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const secrets = secretsQuery.data ?? [];
  const activeSecrets = useMemo(
    () => secrets.filter((s) => s.status !== "deleted"),
    [secrets],
  );

  // Currently selected key extracted from the ${secret:...} reference.
  const selectedKey = parseSecretRef(value);
  const selectValue =
    !value ? "__none__"
    : selectedKey && activeSecrets.some((s) => s.key === selectedKey) ? selectedKey
    : "__custom__";

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: newName.trim(),
        value: newValue,
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["secrets", companyId] });
      onChange(buildSecretRef(created.key));
      setCreating(false);
      setNewName(newSecretNameHint ?? "");
      setNewValue("");
      pushToast({
        tone: "success",
        title: "Secret created",
        body: `${created.name} is now available to all agents in this company.`,
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Could not create secret",
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (creating) {
    const suggestedKey = suggestSecretKey(newName);
    return (
      <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium">Create new secret</div>
          <button
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName(newSecretNameHint ?? "");
              setNewValue("");
            }}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Secret name (e.g. Anthropic API Key)"
          className="text-sm"
        />
        <Input
          type="password"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="Secret value (stored encrypted)"
          className="text-sm font-mono"
        />
        {suggestedKey ? (
          <div className="text-[11px] text-muted-foreground">
            Will be saved as <code className="font-mono">${"{"}secret:{suggestedKey}{"}"}</code> and
            reusable in other agents/MCPs.
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(false);
              setNewName(newSecretNameHint ?? "");
              setNewValue("");
            }}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !newName.trim() || !newValue}
          >
            {createMutation.isPending ? "Creating…" : "Create + use"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === "__none__") {
            onChange("");
            return;
          }
          if (v === "__custom__") {
            // Keep the raw value as-is; allow the inline input below to take over.
            return;
          }
          if (v === "__create_new__") {
            setCreating(true);
            return;
          }
          // It's a secret key
          onChange(buildSecretRef(v));
        }}
      >
        <SelectTrigger className="flex-1">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">(none)</SelectItem>
          {selectValue === "__custom__" ? (
            <SelectItem value="__custom__">
              <span className="font-mono text-xs">{value}</span> · custom reference
            </SelectItem>
          ) : null}
          {activeSecrets.map((secret) => (
            <SelectItem key={secret.id} value={secret.key}>
              {secret.name} <span className="text-muted-foreground">· {secret.key}</span>
            </SelectItem>
          ))}
          <SelectItem value="__create_new__">
            <span className="inline-flex items-center gap-1.5">
              <Plus className="h-3 w-3" /> Create new secret…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
