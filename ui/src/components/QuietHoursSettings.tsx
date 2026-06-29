import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QuietHoursConfig, QuietHoursOnBlock, QuietHoursWindow } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Field, ToggleField } from "./agent-config-primitives";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
];

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function supportedTimezones(): string[] {
  const withSupport = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let list: string[];
  try {
    list = typeof withSupport.supportedValuesOf === "function"
      ? withSupport.supportedValuesOf("timeZone")
      : FALLBACK_TIMEZONES;
  } catch {
    list = FALLBACK_TIMEZONES;
  }
  const tz = browserTimezone();
  return list.includes(tz) ? list : [tz, ...list];
}

function defaultWindow(): QuietHoursWindow {
  return { days: [], start: "22:00", end: "08:00" };
}

function defaultConfig(): QuietHoursConfig {
  return { enabled: true, timezone: browserTimezone(), windows: [defaultWindow()], onBlock: "defer" };
}

/** Normalize for stable comparison (sorted days) so dirty detection is reliable. */
function normalize(config: QuietHoursConfig): QuietHoursConfig {
  return {
    enabled: config.enabled,
    timezone: config.timezone,
    onBlock: config.onBlock,
    windows: config.windows.map((w) => ({
      days: [...w.days].sort((a, b) => a - b),
      start: w.start,
      end: w.end,
    })),
  };
}

function windowValid(window: QuietHoursWindow): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(window.start)
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(window.end)
    && window.start !== window.end;
}

export function QuietHoursSettings({
  companyId,
  quietHours,
}: {
  companyId: string;
  quietHours: QuietHoursConfig | null;
}) {
  const queryClient = useQueryClient();
  const timezones = useMemo(() => supportedTimezones(), []);

  const [enabled, setEnabled] = useState(false);
  const [timezone, setTimezone] = useState(browserTimezone());
  const [windows, setWindows] = useState<QuietHoursWindow[]>([]);
  const [onBlock, setOnBlock] = useState<QuietHoursOnBlock>("defer");

  // Sync local state whenever the persisted config changes.
  useEffect(() => {
    const base = quietHours ?? defaultConfig();
    setEnabled(quietHours?.enabled ?? false);
    setTimezone(base.timezone);
    setWindows(base.windows.length > 0 ? base.windows.map((w) => ({ ...w, days: [...w.days] })) : [defaultWindow()]);
    setOnBlock(base.onBlock);
  }, [quietHours]);

  const current: QuietHoursConfig = { enabled, timezone, windows, onBlock };
  const saved: QuietHoursConfig | null = quietHours;

  const windowsValid = windows.every(windowValid);
  const configValid = !enabled || (windows.length > 0 && windowsValid);

  const dirty = JSON.stringify(saved ? normalize(saved) : null) !== JSON.stringify(normalize(current));

  const mutation = useMutation({
    mutationFn: (config: QuietHoursConfig) => companiesApi.update(companyId, { quietHours: config }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  function toggleDay(windowIndex: number, day: number) {
    setWindows((prev) =>
      prev.map((w, i) => {
        if (i !== windowIndex) return w;
        const days = w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day];
        return { ...w, days: days.sort((a, b) => a - b) };
      }),
    );
  }

  function updateWindow(windowIndex: number, patch: Partial<QuietHoursWindow>) {
    setWindows((prev) => prev.map((w, i) => (i === windowIndex ? { ...w, ...patch } : w)));
  }

  function removeWindow(windowIndex: number) {
    setWindows((prev) => prev.filter((_, i) => i !== windowIndex));
  }

  function addWindow() {
    setWindows((prev) => [...prev, defaultWindow()]);
  }

  function handleSave() {
    mutation.mutate(normalize(current));
  }

  return (
    <div className="space-y-4" data-testid="company-settings-quiet-hours-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Quiet hours
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <ToggleField
          label="Enable quiet hours"
          hint="During these windows, agents are not autonomously executed. Manual and on-demand wakes still run."
          checked={enabled}
          onChange={setEnabled}
          toggleTestId="quiet-hours-enabled-toggle"
        />

        {enabled && (
          <>
            <Field label="Timezone" hint="Windows are interpreted in this timezone.">
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                data-testid="quiet-hours-timezone"
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Windows" hint="Days the window applies to. Select no days to apply every day. A window whose end is earlier than its start crosses midnight.">
              <div className="space-y-3">
                {windows.map((window, index) => (
                  <div
                    key={index}
                    className="space-y-2 rounded-md border border-border px-3 py-2.5"
                    data-testid="quiet-hours-window"
                  >
                    <div className="flex flex-wrap gap-1">
                      {DAY_LABELS.map((label, day) => {
                        const active = window.days.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            onClick={() => toggleDay(index, day)}
                            className={
                              "rounded px-2 py-1 text-xs transition-colors "
                              + (active
                                ? "bg-green-600 text-white"
                                : "bg-muted text-muted-foreground hover:bg-muted/70")
                            }
                            aria-pressed={active}
                          >
                            {label}
                          </button>
                        );
                      })}
                      {window.days.length === 0 && (
                        <span className="self-center pl-1 text-xs text-muted-foreground">Every day</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={window.start}
                        onChange={(e) => updateWindow(index, { start: e.target.value })}
                        className="rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        aria-label="Start time"
                      />
                      <span className="text-xs text-muted-foreground">to</span>
                      <input
                        type="time"
                        value={window.end}
                        onChange={(e) => updateWindow(index, { end: e.target.value })}
                        className="rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        aria-label="End time"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeWindow(index)}
                        className="ml-auto text-xs text-muted-foreground"
                      >
                        Remove
                      </Button>
                    </div>
                    {!windowValid(window) && (
                      <span className="text-xs text-destructive">Start and end must differ and be valid times.</span>
                    )}
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={addWindow} data-testid="quiet-hours-add-window">
                  Add window
                </Button>
                {windows.length === 0 && (
                  <span className="block text-xs text-destructive">Add at least one window.</span>
                )}
              </div>
            </Field>

            <Field label="When an execution falls inside a window" hint="Choose what the scheduler does with a blocked run.">
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  { value: "defer", title: "Defer", desc: "Reschedule to when the window closes. Nothing is lost." },
                  { value: "skip", title: "Skip", desc: "Don't run now; resume on the next scheduled tick. A scheduled occurrence inside the window is lost." },
                ] as const).map((option) => {
                  const active = onBlock === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setOnBlock(option.value)}
                      className={
                        "rounded-md border px-3 py-2 text-left transition-colors "
                        + (active ? "border-green-600 bg-green-600/10" : "border-border hover:bg-muted/50")
                      }
                      aria-pressed={active}
                      data-testid={`quiet-hours-onblock-${option.value}`}
                    >
                      <div className="text-sm font-medium">{option.title}</div>
                      <div className="text-xs text-muted-foreground">{option.desc}</div>
                    </button>
                  );
                })}
              </div>
            </Field>
          </>
        )}

        {dirty && (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={mutation.isPending || !configValid}
              data-testid="quiet-hours-save"
            >
              {mutation.isPending ? "Saving..." : "Save quiet hours"}
            </Button>
            {mutation.isSuccess && <span className="text-xs text-muted-foreground">Saved</span>}
            {mutation.isError && (
              <span className="text-xs text-destructive">
                {mutation.error instanceof Error ? mutation.error.message : "Failed to save"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
