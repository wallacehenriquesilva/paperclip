import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyMcpServer,
  CompanyMcpServerCreateRequest,
  CompanyMcpServerListItem,
  CompanyMcpServerTestResult,
  CompanyMcpServerUpdateRequest,
  McpServerEnvValueInput,
} from "@paperclipai/shared";
import { parseSecretReference } from "@paperclipai/shared";
import {
  CheckCircle2,
  KeyRound,
  Lock,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { companyMcpServersApi } from "../api/companyMcpServers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

type EnvRowKind = "literal" | "secret_ref" | "secret_inline";

interface EnvRow {
  key: string;
  kind: EnvRowKind;
  value: string;
}

interface FormState {
  name: string;
  key: string;
  description: string;
  command: string;
  args: string[];
  argDraft: string;
  envRows: EnvRow[];
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  key: "",
  description: "",
  command: "",
  args: [],
  argDraft: "",
  envRows: [],
  enabled: true,
};

function detailToForm(server: CompanyMcpServer): FormState {
  const envRows: EnvRow[] = Object.entries(server.envTemplate).map(([envKey, raw]) => {
    const secretKey = parseSecretReference(raw);
    if (secretKey) {
      return { key: envKey, kind: "secret_ref", value: secretKey };
    }
    return { key: envKey, kind: "literal", value: raw };
  });
  return {
    name: server.name,
    key: server.key,
    description: server.description ?? "",
    command: server.command,
    args: server.args,
    argDraft: "",
    envRows,
    enabled: server.enabled,
  };
}

function envRowsToInput(rows: EnvRow[]): Record<string, McpServerEnvValueInput> {
  const out: Record<string, McpServerEnvValueInput> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.kind === "literal") {
      out[key] = { kind: "literal", value: row.value };
    } else if (row.kind === "secret_ref") {
      out[key] = { kind: "secret", secretKey: row.value.trim() };
    } else {
      out[key] = { kind: "secret_inline", value: row.value };
    }
  }
  return out;
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function McpServerForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  onDelete,
  onTest,
  pending,
  testPending,
  testResult,
  testError,
  isCreate,
}: {
  form: FormState;
  setForm: (next: FormState | ((prev: FormState) => FormState)) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onTest?: () => void;
  pending: boolean;
  testPending: boolean;
  testResult: CompanyMcpServerTestResult | null;
  testError: string | null;
  isCreate: boolean;
}) {
  function patchEnvRow(index: number, patch: Partial<EnvRow>) {
    setForm((prev) => ({
      ...prev,
      envRows: prev.envRows.map((row, idx) => (idx === index ? { ...row, ...patch } : row)),
    }));
  }

  function addEnvRow() {
    setForm((prev) => ({
      ...prev,
      envRows: [...prev.envRows, { key: "", kind: "literal", value: "" }],
    }));
  }

  function removeEnvRow(index: number) {
    setForm((prev) => ({
      ...prev,
      envRows: prev.envRows.filter((_, idx) => idx !== index),
    }));
  }

  function appendArg() {
    const next = form.argDraft.trim();
    if (!next) return;
    setForm((prev) => ({ ...prev, args: [...prev.args, next], argDraft: "" }));
  }

  function removeArg(index: number) {
    setForm((prev) => ({
      ...prev,
      args: prev.args.filter((_, idx) => idx !== index),
    }));
  }

  const submitDisabled = pending || !form.name.trim() || !form.command.trim();

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Server</h2>
        <Input
          value={form.name}
          onChange={(event) => {
            const name = event.target.value;
            setForm((prev) => ({
              ...prev,
              name,
              key: isCreate && (!prev.key || prev.key === slugify(prev.name)) ? slugify(name) : prev.key,
            }));
          }}
          placeholder="Display name"
        />
        <Input
          value={form.key}
          onChange={(event) => setForm((prev) => ({ ...prev, key: event.target.value }))}
          placeholder="short-key"
          disabled={!isCreate}
        />
        <Textarea
          value={form.description}
          onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          placeholder="What does this MCP server expose?"
          className="min-h-16"
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Process (stdio)</h2>
        <Input
          value={form.command}
          onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))}
          placeholder="Command (e.g. npx or /path/to/binary)"
        />
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Arguments</div>
          <div className="flex flex-wrap gap-2">
            {form.args.map((arg, index) => (
              <span
                key={`${arg}-${index}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs font-mono"
              >
                {arg}
                <button
                  type="button"
                  onClick={() => removeArg(index)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove argument ${arg}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={form.argDraft}
              onChange={(event) => setForm((prev) => ({ ...prev, argDraft: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  appendArg();
                }
              }}
              placeholder="Add argument and press Enter"
            />
            <Button size="sm" variant="ghost" onClick={appendArg} disabled={!form.argDraft.trim()}>
              Add
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Environment</h2>
          <Button size="sm" variant="ghost" onClick={addEnvRow}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add var
          </Button>
        </div>
        {form.envRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No environment variables yet.</p>
        ) : (
          <ul className="space-y-2">
            {form.envRows.map((row, index) => {
              const placeholder =
                row.kind === "secret_inline"
                  ? "Paste secret (stored encrypted)"
                  : row.kind === "secret_ref"
                    ? "existing-secret-key"
                    : "Literal value";
              return (
                <li
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-center gap-2"
                >
                  <Input
                    value={row.key}
                    onChange={(event) => patchEnvRow(index, { key: event.target.value })}
                    placeholder="ENV_KEY"
                    className="font-mono"
                  />
                  <Input
                    value={row.value}
                    onChange={(event) => patchEnvRow(index, { value: event.target.value })}
                    placeholder={placeholder}
                    type={row.kind === "secret_inline" ? "password" : "text"}
                    className="font-mono"
                  />
                  <div className="flex items-center gap-1">
                    <EnvKindToggle
                      kind={row.kind}
                      onChange={(kind) => patchEnvRow(index, { kind, value: "" })}
                    />
                    <button
                      type="button"
                      onClick={() => removeEnvRow(index)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${row.key || `env row ${index}`}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">
          Inline secrets are encrypted in Paperclip and the env template stores a{" "}
          <code className="font-mono">$&#123;secret:...&#125;</code> reference.
        </p>
      </section>

      <section className="flex items-center justify-between border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm">
          <ToggleSwitch
            checked={form.enabled}
            onCheckedChange={(value) => setForm((prev) => ({ ...prev, enabled: value }))}
          />
          {form.enabled ? "Enabled" : "Disabled"}
        </label>
        <div className="flex items-center gap-2">
          {onTest ? (
            <Button variant="ghost" size="sm" onClick={onTest} disabled={testPending || pending}>
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", testPending && "animate-spin")} />
              {testPending ? "Testing..." : "Test handshake"}
            </Button>
          ) : null}
          {onDelete ? (
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={pending}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete
            </Button>
          ) : null}
          {onCancel ? (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" onClick={onSubmit} disabled={submitDisabled}>
            {pending ? "Saving..." : isCreate ? "Create" : "Save"}
          </Button>
        </div>
      </section>

      {testError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {testError}
        </div>
      ) : null}
      {testResult ? <TestResultPanel result={testResult} /> : null}
    </div>
  );
}

function EnvKindToggle({
  kind,
  onChange,
}: {
  kind: EnvRowKind;
  onChange: (next: EnvRowKind) => void;
}) {
  const variants: Array<{ kind: EnvRowKind; icon: typeof Lock; label: string }> = [
    { kind: "literal", icon: KeyRound, label: "Literal value" },
    { kind: "secret_inline", icon: Lock, label: "New encrypted secret" },
    { kind: "secret_ref", icon: KeyRound, label: "Reference an existing secret" },
  ];
  return (
    <div className="flex items-center rounded-md border border-border">
      {variants.map((variant) => {
        const Icon = variant.icon;
        const active = variant.kind === kind;
        return (
          <Tooltip key={variant.kind}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(variant.kind)}
                className={cn(
                  "flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground",
                  active && "bg-accent text-foreground",
                )}
                aria-label={variant.label}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{variant.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function TestResultPanel({ result }: { result: CompanyMcpServerTestResult }) {
  return (
    <div className="rounded-md border border-green-700/40 bg-green-700/5 p-3 text-sm">
      <div className="flex items-center gap-2 text-green-700">
        <CheckCircle2 className="h-4 w-4" />
        <span>
          Handshake OK ({result.durationMs} ms){" "}
          {result.serverName ? `· ${result.serverName}${result.serverVersion ? ` v${result.serverVersion}` : ""}` : null}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {result.protocolVersion ? (
          <>
            <dt>Protocol</dt>
            <dd className="font-mono text-foreground">{result.protocolVersion}</dd>
          </>
        ) : null}
        <dt>Tools</dt>
        <dd className="text-foreground">
          {result.tools.length === 0
            ? "—"
            : result.tools.map((tool) => tool.name).join(", ")}
        </dd>
        <dt>Resources</dt>
        <dd className="text-foreground">
          {result.resources.length === 0
            ? "—"
            : result.resources.map((resource) => resource.name ?? resource.uri).join(", ")}
        </dd>
      </dl>
    </div>
  );
}

function ServerListSidebar({
  servers,
  selectedId,
  filter,
  onFilter,
  onCreate,
  onSelect,
  isLoading,
  error,
}: {
  servers: CompanyMcpServerListItem[];
  selectedId: string | null;
  filter: string;
  onFilter: (value: string) => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  isLoading: boolean;
  error: Error | null;
}) {
  const filtered = useMemo(
    () =>
      servers.filter((server) => {
        const haystack = `${server.name} ${server.key} ${server.description ?? ""}`.toLowerCase();
        return haystack.includes(filter.toLowerCase());
      }),
    [servers, filter],
  );

  return (
    <aside className="border-r border-border">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold">MCP servers</h1>
            <p className="text-xs text-muted-foreground">{servers.length} configured</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onCreate} aria-label="Create MCP server">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-b border-border pb-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
            placeholder="Filter servers"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error ? (
        <div className="px-4 py-6 text-sm text-destructive">{error.message}</div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">No MCP servers yet.</div>
      ) : (
        <ul>
          {filtered.map((server) => (
            <li key={server.id} className="border-b border-border">
              <Link
                to={`/mcp-servers/${server.id}`}
                onClick={() => onSelect(server.id)}
                className={cn(
                  "flex flex-col gap-1 px-4 py-3 no-underline transition-colors hover:bg-accent/30",
                  server.id === selectedId && "bg-accent/40",
                )}
              >
                <div className="flex items-center gap-2 text-sm">
                  <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="truncate font-medium">{server.name}</span>
                  {!server.enabled ? (
                    <span className="ml-auto rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      disabled
                    </span>
                  ) : null}
                </div>
                <div className="font-mono text-xs text-muted-foreground">{server.key}</div>
                {server.envKeys.length > 0 ? (
                  <div className="text-[11px] text-muted-foreground">
                    env: {server.envKeys.join(", ")}
                    {server.hasSecretReferences ? " · 🔒" : ""}
                  </div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export function CompanyMcpServers() {
  const { "*": routePath } = useParams<{ "*": string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [createOpen, setCreateOpen] = useState(false);
  const [testResult, setTestResult] = useState<CompanyMcpServerTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const routeId = useMemo(() => {
    const segments = (routePath ?? "").split("/").filter(Boolean);
    if (segments.length === 0) return null;
    if (segments[0] === "new") return "new";
    return segments[0] ?? null;
  }, [routePath]);

  const listQuery = useQuery({
    queryKey: queryKeys.companyMcpServers.list(selectedCompanyId ?? ""),
    queryFn: () => companyMcpServersApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const detailQuery = useQuery({
    queryKey: queryKeys.companyMcpServers.detail(selectedCompanyId ?? "", routeId ?? ""),
    queryFn: () => companyMcpServersApi.detail(selectedCompanyId!, routeId!),
    enabled: Boolean(selectedCompanyId && routeId && routeId !== "new"),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "MCP servers", href: "/mcp-servers" },
      ...(routeId === "new"
        ? [{ label: "New" }]
        : routeId
          ? [{ label: detailQuery.data?.name ?? "Detail" }]
          : []),
    ]);
  }, [routeId, detailQuery.data?.name, setBreadcrumbs]);

  useEffect(() => {
    setTestResult(null);
    setTestError(null);
  }, [routeId]);

  useEffect(() => {
    if (routeId === "new") {
      setCreateOpen(true);
      setForm(EMPTY_FORM);
    } else if (detailQuery.data) {
      setCreateOpen(false);
      setForm(detailToForm(detailQuery.data));
    } else if (!routeId) {
      setCreateOpen(false);
      setForm(EMPTY_FORM);
    }
  }, [routeId, detailQuery.data]);

  const createMutation = useMutation({
    mutationFn: (payload: CompanyMcpServerCreateRequest) =>
      companyMcpServersApi.create(selectedCompanyId!, payload),
    onSuccess: async (server) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companyMcpServers.list(selectedCompanyId!),
      });
      pushToast({
        tone: "success",
        title: "MCP server created",
        body: server.name,
      });
      navigate(`/mcp-servers/${server.id}`);
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Create failed",
        body: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CompanyMcpServerUpdateRequest }) =>
      companyMcpServersApi.update(selectedCompanyId!, id, payload),
    onSuccess: async (server) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.companyMcpServers.list(selectedCompanyId!),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.companyMcpServers.detail(selectedCompanyId!, server.id),
        }),
      ]);
      pushToast({ tone: "success", title: "MCP server saved", body: server.name });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Save failed",
        body: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companyMcpServersApi.delete(selectedCompanyId!, id),
    onSuccess: async (server) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companyMcpServers.list(selectedCompanyId!),
      });
      pushToast({
        tone: "success",
        title: "MCP server removed",
        body: server.name,
      });
      navigate("/mcp-servers");
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Delete failed",
        body: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => companyMcpServersApi.test(selectedCompanyId!, id, { timeoutMs: 10_000 }),
    onMutate: () => {
      setTestError(null);
      setTestResult(null);
    },
    onSuccess: (result) => setTestResult(result),
    onError: (error) =>
      setTestError(error instanceof Error ? error.message : String(error)),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Plug} message="Select a company to manage MCP servers." />;
  }

  function handleSubmitCreate() {
    createMutation.mutate({
      name: form.name.trim(),
      key: form.key.trim() || undefined,
      description: form.description.trim() || null,
      command: form.command.trim(),
      args: form.args,
      env: envRowsToInput(form.envRows),
      enabled: form.enabled,
    });
  }

  function handleSubmitUpdate(id: string) {
    updateMutation.mutate({
      id,
      payload: {
        name: form.name.trim(),
        description: form.description.trim() || null,
        command: form.command.trim(),
        args: form.args,
        env: envRowsToInput(form.envRows),
        enabled: form.enabled,
      },
    });
  }

  return (
    <div className="grid min-h-[calc(100vh-12rem)] gap-0 xl:grid-cols-[19rem_minmax(0,1fr)]">
      <ServerListSidebar
        servers={listQuery.data ?? []}
        selectedId={routeId === "new" ? null : routeId}
        filter={filter}
        onFilter={setFilter}
        onCreate={() => {
          setForm(EMPTY_FORM);
          setCreateOpen(true);
          navigate("/mcp-servers/new");
        }}
        onSelect={(id) => navigate(`/mcp-servers/${id}`)}
        isLoading={listQuery.isLoading}
        error={(listQuery.error as Error | null) ?? null}
      />

      <main className="min-w-0 px-6 py-6">
        {createOpen || routeId === "new" ? (
          <div className="max-w-3xl">
            <h2 className="mb-4 text-xl font-semibold">New MCP server</h2>
            <McpServerForm
              form={form}
              setForm={setForm}
              onSubmit={handleSubmitCreate}
              onCancel={() => {
                setCreateOpen(false);
                navigate("/mcp-servers");
              }}
              pending={createMutation.isPending}
              testPending={false}
              testResult={null}
              testError={null}
              isCreate
            />
          </div>
        ) : !routeId ? (
          <EmptyState
            icon={Plug}
            message="Select a server on the left or create a new one."
          />
        ) : detailQuery.isLoading ? (
          <PageSkeleton variant="detail" />
        ) : !detailQuery.data ? (
          <EmptyState icon={Plug} message="Server not found." />
        ) : (
          <div className="max-w-3xl">
            <h2 className="mb-4 text-xl font-semibold">{detailQuery.data.name}</h2>
            <McpServerForm
              form={form}
              setForm={setForm}
              onSubmit={() => handleSubmitUpdate(detailQuery.data!.id)}
              onDelete={() => {
                if (window.confirm(`Remove "${detailQuery.data!.name}"?`)) {
                  deleteMutation.mutate(detailQuery.data!.id);
                }
              }}
              onTest={() => testMutation.mutate(detailQuery.data!.id)}
              pending={updateMutation.isPending || deleteMutation.isPending}
              testPending={testMutation.isPending}
              testResult={testResult}
              testError={testError}
              isCreate={false}
            />
          </div>
        )}
      </main>
    </div>
  );
}
