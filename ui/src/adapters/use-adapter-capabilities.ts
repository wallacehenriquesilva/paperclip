import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { adaptersApi, type AdapterCapabilities } from "@/api/adapters";
import { queryKeys } from "@/lib/queryKeys";

const ALL_FALSE: AdapterCapabilities = {
  supportsInstructionsBundle: false,
  supportsSkills: false,
  supportsLocalAgentJwt: false,
  requiresMaterializedRuntimeSkills: false,
  supportsModelProfiles: false,
  supportsScriptBundle: false,
};

/**
 * Synchronous fallback for known built-in adapter types so capability checks
 * return correct values on first render before the /api/adapters call resolves.
 */
const KNOWN_DEFAULTS: Record<string, AdapterCapabilities> = {
  acpx_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: false, supportsModelProfiles: false, supportsScriptBundle: false },
  claude_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: false, supportsModelProfiles: true, supportsScriptBundle: false },
  codex_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: false, supportsModelProfiles: true, supportsScriptBundle: false },
  cursor: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: true, supportsModelProfiles: true, supportsScriptBundle: false },
  gemini_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: true, supportsModelProfiles: true, supportsScriptBundle: false },
  grok_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: true, supportsModelProfiles: false, supportsScriptBundle: false },
  opencode_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: true, supportsModelProfiles: true, supportsScriptBundle: false },
  pi_local: { supportsInstructionsBundle: true, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: true, supportsModelProfiles: false, supportsScriptBundle: false },
  hermes_local: { supportsInstructionsBundle: false, supportsSkills: true, supportsLocalAgentJwt: true, requiresMaterializedRuntimeSkills: false, supportsModelProfiles: false, supportsScriptBundle: false },
  openclaw_gateway: ALL_FALSE,
  process: { ...ALL_FALSE, supportsScriptBundle: true },
  http: { ...ALL_FALSE, supportsScriptBundle: true },
};

/**
 * Returns a lookup function that resolves adapter capabilities by type.
 *
 * Capabilities are fetched from the server adapter listing API and cached
 * via react-query. Before the data loads, known built-in adapter types
 * return correct synchronous defaults to avoid cold-load regressions.
 */
export function useAdapterCapabilities(): (type: string) => AdapterCapabilities {
  const { data: adapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  const capMap = useMemo(() => {
    const map = new Map<string, AdapterCapabilities>();
    if (adapters) {
      for (const a of adapters) {
        map.set(a.type, a.capabilities);
      }
    }
    return map;
  }, [adapters]);

  return (type: string): AdapterCapabilities =>
    capMap.get(type) ?? KNOWN_DEFAULTS[type] ?? ALL_FALSE;
}
