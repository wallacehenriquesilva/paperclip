import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import { SecretRefPicker } from "../../components/SecretRefPicker";
import { useCompany } from "../../context/CompanyContext";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 1000),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 1000)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <ClaudeFallbackFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        eff={eff}
        mark={mark}
      />
    </>
  );
}

function ClaudeFallbackFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: Pick<AdapterConfigFieldsProps, "isCreate" | "values" | "set" | "config" | "eff" | "mark">) {
  const persistedFallback = (config.claudeFallback ?? {}) as {
    enabled?: boolean;
    apiKeySecretRef?: string;
  };
  const fallbackValues = (values?.claudeFallback ?? {}) as {
    enabled?: boolean;
    apiKeySecretRef?: string;
  };

  // eff/mark store the value under a single flat key, so we keep the whole
  // claudeFallback object under "claudeFallback" and derive .enabled /
  // .apiKeySecretRef from the effective object.
  const effectiveFallback = isCreate
    ? {
        enabled: Boolean(fallbackValues.enabled),
        apiKeySecretRef: String(fallbackValues.apiKeySecretRef ?? ""),
      }
    : (eff(
        "adapterConfig",
        "claudeFallback",
        persistedFallback as Record<string, unknown>,
      ) as { enabled?: boolean; apiKeySecretRef?: string });

  const enabled = Boolean(effectiveFallback.enabled);
  const apiKeySecretRef = String(effectiveFallback.apiKeySecretRef ?? "");

  function patchFallback(patch: { enabled?: boolean; apiKeySecretRef?: string }) {
    const next = {
      enabled: patch.enabled !== undefined ? patch.enabled : enabled,
      apiKeySecretRef:
        patch.apiKeySecretRef !== undefined ? patch.apiKeySecretRef : apiKeySecretRef,
    };
    if (isCreate) {
      set!({ claudeFallback: next });
    } else {
      mark("adapterConfig", "claudeFallback", next);
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3 mt-3 space-y-3">
      <ToggleField
        label="Fall back to Anthropic API when subscription limits hit"
        hint="When ON, hitting a Claude session limit (e.g. Pro 5h cap) switches this agent to metered API billing until the reset — instead of sitting idle. Reverts to subscription automatically once the limit resets."
        checked={enabled}
        onChange={(v) => patchFallback({ enabled: v })}
      />
      {enabled ? (
        <Field
          label="ANTHROPIC_API_KEY secret"
          hint="Pick an existing company secret or create a new one inline. The value is stored encrypted and reusable in other agents."
        >
          <ClaudeFallbackSecretPicker
            value={apiKeySecretRef}
            onChange={(v) => patchFallback({ apiKeySecretRef: v })}
          />
        </Field>
      ) : null}
    </div>
  );
}

function ClaudeFallbackSecretPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { selectedCompanyId } = useCompany();
  if (!selectedCompanyId) {
    return (
      <DraftInput
        value={value}
        onCommit={onChange}
        immediate
        className={inputClass}
        placeholder="${secret:anthropic-api-key}"
      />
    );
  }
  return (
    <SecretRefPicker
      companyId={selectedCompanyId}
      value={value}
      onChange={onChange}
      placeholder="Pick or create an Anthropic API key"
      newSecretNameHint="Anthropic API key"
    />
  );
}
