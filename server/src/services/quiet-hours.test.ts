import { describe, expect, it } from "vitest";
import type { QuietHoursConfig } from "@paperclipai/shared";
import { isQuietHoursActive, nextQuietHoursEnd } from "./quiet-hours.js";

function config(overrides: Partial<QuietHoursConfig> = {}): QuietHoursConfig {
  return {
    enabled: true,
    timezone: "America/Sao_Paulo",
    windows: [],
    onBlock: "skip",
    ...overrides,
  };
}

describe("isQuietHoursActive", () => {
  it("returns false when config is null or disabled", () => {
    const now = new Date("2026-06-02T03:00:00Z");
    expect(isQuietHoursActive(null, now)).toBe(false);
    expect(isQuietHoursActive(config({ enabled: false, windows: [{ days: [], start: "00:00", end: "23:59" }] }), now)).toBe(false);
  });

  it("returns false when enabled but no windows", () => {
    expect(isQuietHoursActive(config({ windows: [] }), new Date("2026-06-02T03:00:00Z"))).toBe(false);
  });

  it("matches a same-day window in the configured timezone", () => {
    // 13:00–14:00 in America/Sao_Paulo (UTC-3) => 16:00–17:00 UTC.
    const cfg = config({ windows: [{ days: [], start: "13:00", end: "14:00" }] });
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T16:30:00Z"))).toBe(true);
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T15:30:00Z"))).toBe(false);
  });

  it("treats end as exclusive and start as inclusive", () => {
    const cfg = config({ timezone: "UTC", windows: [{ days: [], start: "09:00", end: "10:00" }] });
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T09:00:00Z"))).toBe(true);
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T10:00:00Z"))).toBe(false);
  });

  it("handles a window that crosses midnight", () => {
    const cfg = config({ timezone: "UTC", windows: [{ days: [], start: "22:00", end: "08:00" }] });
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T23:00:00Z"))).toBe(true); // evening
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T03:00:00Z"))).toBe(true); // early morning
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T12:00:00Z"))).toBe(false); // midday
  });

  it("respects the start weekday for same-day windows", () => {
    // 2026-06-01 is a Monday (weekday 1) in UTC.
    const cfg = config({ timezone: "UTC", windows: [{ days: [1], start: "09:00", end: "17:00" }] });
    expect(isQuietHoursActive(cfg, new Date("2026-06-01T12:00:00Z"))).toBe(true); // Monday
    expect(isQuietHoursActive(cfg, new Date("2026-06-02T12:00:00Z"))).toBe(false); // Tuesday
  });

  it("spills a midnight-crossing window into the day after the start weekday", () => {
    // Window starts Saturday (weekday 6) 22:00 and ends Sunday 06:00.
    const cfg = config({ timezone: "UTC", windows: [{ days: [6], start: "22:00", end: "06:00" }] });
    // 2026-06-06 is a Saturday.
    expect(isQuietHoursActive(cfg, new Date("2026-06-06T23:00:00Z"))).toBe(true); // Sat evening
    expect(isQuietHoursActive(cfg, new Date("2026-06-07T03:00:00Z"))).toBe(true); // Sun morning (spill)
    expect(isQuietHoursActive(cfg, new Date("2026-06-07T23:00:00Z"))).toBe(false); // Sun evening (not configured)
  });
});

describe("nextQuietHoursEnd", () => {
  it("returns null when not currently within a window", () => {
    const cfg = config({ timezone: "UTC", windows: [{ days: [], start: "09:00", end: "10:00" }] });
    expect(nextQuietHoursEnd(cfg, new Date("2026-06-02T11:00:00Z"))).toBeNull();
  });

  it("returns the exclusive end instant of the active window", () => {
    const cfg = config({ timezone: "UTC", windows: [{ days: [], start: "09:00", end: "10:00" }] });
    const end = nextQuietHoursEnd(cfg, new Date("2026-06-02T09:30:00Z"));
    expect(end?.toISOString()).toBe("2026-06-02T10:00:00.000Z");
  });

  it("advances past back-to-back/overlapping windows", () => {
    const cfg = config({
      timezone: "UTC",
      windows: [
        { days: [], start: "09:00", end: "10:00" },
        { days: [], start: "10:00", end: "11:00" },
      ],
    });
    const end = nextQuietHoursEnd(cfg, new Date("2026-06-02T09:30:00Z"));
    expect(end?.toISOString()).toBe("2026-06-02T11:00:00.000Z");
  });

  it("resolves the end of a midnight-crossing window", () => {
    const cfg = config({ timezone: "UTC", windows: [{ days: [], start: "22:00", end: "08:00" }] });
    const end = nextQuietHoursEnd(cfg, new Date("2026-06-02T23:30:00Z"));
    expect(end?.toISOString()).toBe("2026-06-03T08:00:00.000Z");
  });
});
