import { describe, expect, it } from "vitest";
import {
  instanceGeneralSettingsSchema,
  logRetentionPolicySchema,
} from "./instance.js";
import { DEFAULT_LOG_RETENTION } from "../types/instance.js";

describe("logRetentionPolicySchema", () => {
  it("accepts valid presets", () => {
    const parsed = logRetentionPolicySchema.parse({ serverLogMaxSizeMb: 1024, runLogMaxAgeDays: 30 });
    expect(parsed).toEqual({ serverLogMaxSizeMb: 1024, runLogMaxAgeDays: 30 });
  });

  it("accepts 0 (keep forever) for run-log age", () => {
    expect(logRetentionPolicySchema.parse({ serverLogMaxSizeMb: 256, runLogMaxAgeDays: 0 }).runLogMaxAgeDays).toBe(0);
  });

  it("rejects off-preset values", () => {
    expect(() => logRetentionPolicySchema.parse({ serverLogMaxSizeMb: 777, runLogMaxAgeDays: 14 })).toThrow();
    expect(() => logRetentionPolicySchema.parse({ serverLogMaxSizeMb: 512, runLogMaxAgeDays: 9 })).toThrow();
  });

  it("fills defaults for an empty object", () => {
    expect(logRetentionPolicySchema.parse({})).toEqual(DEFAULT_LOG_RETENTION);
  });
});

describe("instanceGeneralSettingsSchema", () => {
  it("defaults logRetention when omitted", () => {
    expect(instanceGeneralSettingsSchema.parse({}).logRetention).toEqual(DEFAULT_LOG_RETENTION);
  });

  it("stays strict — rejects unknown keys", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ nope: true })).toThrow();
  });

  it("round-trips a provided logRetention", () => {
    const parsed = instanceGeneralSettingsSchema.parse({
      logRetention: { serverLogMaxSizeMb: 2048, runLogMaxAgeDays: 7 },
    });
    expect(parsed.logRetention).toEqual({ serverLogMaxSizeMb: 2048, runLogMaxAgeDays: 7 });
  });
});
