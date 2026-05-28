import type { EnvBinding } from "@paperclipai/shared";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { EnvVarEditor } from "../../components/EnvVarEditor";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const EMPTY_HEADERS: Record<string, EnvBinding> = {};

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  secrets,
  onCreateSecret,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Webhook URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://..."
        />
      </Field>

      {/* Method, headers and timeout are edit-only — set them after the agent exists. */}
      {!isCreate && (
        <>
          <Field label="Method" hint={help.httpMethod}>
            <DraftInput
              value={eff("adapterConfig", "method", String(config.method ?? "POST"))}
              onCommit={(v) =>
                mark("adapterConfig", "method", v ? v.trim().toUpperCase() : undefined)
              }
              immediate
              className={inputClass}
              placeholder="POST"
            />
          </Field>

          <Field label="Headers" hint={help.httpHeaders}>
            <EnvVarEditor
              value={eff(
                "adapterConfig",
                "headers",
                (config.headers ?? EMPTY_HEADERS) as Record<string, EnvBinding>,
              )}
              secrets={secrets ?? []}
              onCreateSecret={
                onCreateSecret ??
                (async () => {
                  throw new Error("Secret creation is unavailable in this context");
                })
              }
              onChange={(headers) => mark("adapterConfig", "headers", headers)}
              keyPlaceholder="Header (e.g. Authorization)"
              description="Set KEY to the HTTP header name, for example Authorization. Choose Secret to resolve a stored value (e.g. a bearer token) at run start."
            />
          </Field>

          <Field label="Timeout (ms)" hint={help.httpTimeoutMs}>
            <DraftNumberInput
              value={eff("adapterConfig", "timeoutMs", Number(config.timeoutMs ?? 15000))}
              onCommit={(v) => mark("adapterConfig", "timeoutMs", v)}
              immediate
              className={inputClass}
            />
          </Field>
        </>
      )}
    </>
  );
}
