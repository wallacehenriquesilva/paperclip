import { describe, expect, it } from "vitest";
import { quietHoursConfigSchema, updateCompanySchema } from "./company.js";

describe("quietHoursConfigSchema", () => {
  const base = {
    enabled: true,
    timezone: "America/Sao_Paulo",
    windows: [{ days: [1, 2], start: "22:00", end: "08:00" }],
    onBlock: "defer" as const,
  };

  it("accepts a valid config", () => {
    const parsed = quietHoursConfigSchema.parse(base);
    expect(parsed.windows[0].start).toBe("22:00");
  });

  it("dedupes and sorts window days", () => {
    const parsed = quietHoursConfigSchema.parse({
      ...base,
      windows: [{ days: [3, 1, 1, 2], start: "09:00", end: "17:00" }],
    });
    expect(parsed.windows[0].days).toEqual([1, 2, 3]);
  });

  it("rejects an invalid timezone", () => {
    expect(() => quietHoursConfigSchema.parse({ ...base, timezone: "Mars/Phobos" })).toThrow();
  });

  it("rejects a malformed time", () => {
    expect(() =>
      quietHoursConfigSchema.parse({ ...base, windows: [{ days: [], start: "9:00", end: "17:00" }] }),
    ).toThrow();
    expect(() =>
      quietHoursConfigSchema.parse({ ...base, windows: [{ days: [], start: "24:00", end: "08:00" }] }),
    ).toThrow();
  });

  it("rejects a window whose start equals its end", () => {
    expect(() =>
      quietHoursConfigSchema.parse({ ...base, windows: [{ days: [], start: "08:00", end: "08:00" }] }),
    ).toThrow();
  });

  it("rejects a day outside 0-6", () => {
    expect(() =>
      quietHoursConfigSchema.parse({ ...base, windows: [{ days: [7], start: "09:00", end: "17:00" }] }),
    ).toThrow();
  });

  it("requires at least one window when enabled", () => {
    expect(() => quietHoursConfigSchema.parse({ ...base, windows: [] })).toThrow();
  });

  it("allows zero windows when disabled", () => {
    const parsed = quietHoursConfigSchema.parse({ ...base, enabled: false, windows: [] });
    expect(parsed.enabled).toBe(false);
  });

  it("rejects an unknown onBlock mode", () => {
    expect(() => quietHoursConfigSchema.parse({ ...base, onBlock: "pause" })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => quietHoursConfigSchema.parse({ ...base, extra: true })).toThrow();
  });
});

describe("updateCompanySchema quietHours", () => {
  it("accepts a quietHours payload", () => {
    const parsed = updateCompanySchema.parse({
      quietHours: {
        enabled: true,
        timezone: "UTC",
        windows: [{ days: [], start: "22:00", end: "08:00" }],
        onBlock: "skip",
      },
    });
    expect(parsed.quietHours?.onBlock).toBe("skip");
  });

  it("accepts null to clear quietHours", () => {
    const parsed = updateCompanySchema.parse({ quietHours: null });
    expect(parsed.quietHours).toBeNull();
  });
});
