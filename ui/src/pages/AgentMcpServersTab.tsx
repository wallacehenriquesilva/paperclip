import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, CompanyMcpServerListItem } from "@paperclipai/shared";
import { Plug } from "lucide-react";
import { agentsApi } from "../api/agents";
import { companyMcpServersApi } from "../api/companyMcpServers";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Button } from "@/components/ui/button";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

function readDesiredIds(agent: Agent): string[] {
  const value = (agent.runtimeConfig as Record<string, unknown>).desiredMcpServers;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function AgentMcpServersTab({
  agent,
  companyId,
}: {
  agent: Agent;
  companyId?: string;
}) {
  const effectiveCompanyId = companyId ?? agent.companyId;
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const agentDesiredIds = useMemo(() => readDesiredIds(agent), [agent]);
  const [localDesiredIds, setLocalDesiredIds] = useState<string[]>(agentDesiredIds);
  useEffect(() => {
    setLocalDesiredIds(agentDesiredIds);
  }, [agentDesiredIds]);
  const desiredIds = useMemo(() => new Set(localDesiredIds), [localDesiredIds]);

  const listQuery = useQuery({
    queryKey: queryKeys.companyMcpServers.list(effectiveCompanyId),
    queryFn: () => companyMcpServersApi.list(effectiveCompanyId),
    enabled: Boolean(effectiveCompanyId),
  });

  const saveMutation = useMutation({
    mutationFn: async (nextIds: string[]) => {
      const nextRuntimeConfig = {
        ...(agent.runtimeConfig as Record<string, unknown>),
        desiredMcpServers: nextIds,
      };
      return agentsApi.update(agent.id, { runtimeConfig: nextRuntimeConfig }, effectiveCompanyId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
      pushToast({ tone: "success", title: "Agent MCP servers updated" });
    },
    onError: (error, _vars, _ctx) => {
      setLocalDesiredIds(agentDesiredIds);
      pushToast({
        tone: "error",
        title: "Update failed",
        body: error instanceof Error ? error.message : String(error),
      });
    },
  });

  function toggleServer(server: CompanyMcpServerListItem, next: boolean) {
    const current = new Set(localDesiredIds);
    if (next) current.add(server.id);
    else current.delete(server.id);
    const nextIds = Array.from(current);
    setLocalDesiredIds(nextIds);
    saveMutation.mutate(nextIds);
  }

  if (listQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (listQuery.error) {
    return (
      <div className="px-4 py-6 text-sm text-destructive">
        {(listQuery.error as Error).message}
      </div>
    );
  }

  const servers = listQuery.data ?? [];

  if (servers.length === 0) {
    return (
      <div className="max-w-2xl space-y-3">
        <EmptyState
          icon={Plug}
          message="No MCP servers configured for this company yet."
        />
        <div className="flex justify-center">
          <Button asChild variant="outline" size="sm">
            <Link to="/mcp-servers/new">Create an MCP server</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-muted-foreground">
        Toggle which MCP servers this agent should mount on its next run.
        Selections are stored on{" "}
        <code className="font-mono">runtimeConfig.desiredMcpServers</code>.
      </p>
      <ul className="overflow-hidden rounded-md border border-border">
        {servers.map((server) => {
          const checked = desiredIds.has(server.id);
          return (
            <li
              key={server.id}
              className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <Plug className="h-3.5 w-3.5 text-muted-foreground" />
                  <Link
                    to={`/mcp-servers/${server.id}`}
                    className="font-medium no-underline hover:underline"
                  >
                    {server.name}
                  </Link>
                  {!server.enabled ? (
                    <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      disabled
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  <span className="font-mono">{server.key}</span>
                  {server.envKeys.length > 0
                    ? ` · env: ${server.envKeys.join(", ")}${server.hasSecretReferences ? " · 🔒" : ""}`
                    : null}
                </div>
              </div>
              <ToggleSwitch
                checked={checked}
                onCheckedChange={(next) => toggleServer(server, next)}
                disabled={saveMutation.isPending || !server.enabled}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
