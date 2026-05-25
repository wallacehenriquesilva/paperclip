import { describe, expect, it } from "vitest";
import type { RoutineTrigger } from "@paperclipai/shared";
import { buildRoutineTriggerPatch } from "./routine-trigger-patch";

function makeScheduleTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return {
    id: "trigger-1",
    companyId: "company-1",
    routineId: "routine-1",
    kind: "schedule",
    label: "Daily",
    enabled: true,
    cronExpression: "0 10 * * *",
    timezone: "UTC",
    nextRunAt: null,
    lastFiredAt: null,
    publicId: null,
    secretId: null,
    signingMode: null,
    replayWindowSec: null,
    allowedEventTypes: null,
    botUserId: null,
    teamId: null,
    lastRotatedAt: null,
    lastResult: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
    ...overrides,
  };
}

function makeSlackTrigger(overrides: Partial<RoutineTrigger> = {}): RoutineTrigger {
  return makeScheduleTrigger({
    kind: "slack_event",
    cronExpression: null,
    timezone: null,
    publicId: "abc123",
    signingMode: "slack_v0",
    replayWindowSec: 300,
    allowedEventTypes: ["app_mention"],
    ...overrides,
  });
}

describe("buildRoutineTriggerPatch", () => {
  it("preserves an existing schedule trigger timezone when saving edits", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: "UTC" }),
      {
        label: "Daily label edit",
        cronExpression: "0 10 * * *",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: "Daily label edit",
      cronExpression: "0 10 * * *",
      timezone: "UTC",
    });
  });

  it("falls back to the local timezone when a schedule trigger has none", () => {
    const patch = buildRoutineTriggerPatch(
      makeScheduleTrigger({ timezone: null }),
      {
        label: "",
        cronExpression: "15 9 * * 1-5",
        signingMode: "bearer",
        replayWindowSec: "300",
      },
      "America/Chicago",
    );

    expect(patch).toEqual({
      label: null,
      cronExpression: "15 9 * * 1-5",
      timezone: "America/Chicago",
    });
  });

  it("builds a Slack trigger patch with parsed event types and optional fields", () => {
    const patch = buildRoutineTriggerPatch(
      makeSlackTrigger(),
      {
        label: "Slack mentions",
        cronExpression: "",
        signingMode: "slack_v0",
        replayWindowSec: "120",
        slackEventTypes: " app_mention, message.channels ",
        slackBotUserId: " U123 ",
        slackTeamId: "",
        slackSigningSecret: "  secret  ",
      },
      "UTC",
    );

    expect(patch).toEqual({
      label: "Slack mentions",
      allowedEventTypes: ["app_mention", "message.channels"],
      botUserId: "U123",
      teamId: null,
      replayWindowSec: 120,
      signingSecret: "secret",
    });
  });

  it("defaults Slack event types to app_mention and omits empty signing secret", () => {
    const patch = buildRoutineTriggerPatch(
      makeSlackTrigger(),
      {
        label: "",
        cronExpression: "",
        signingMode: "slack_v0",
        replayWindowSec: "",
      },
      "UTC",
    );

    expect(patch).toEqual({
      label: null,
      allowedEventTypes: ["app_mention"],
      botUserId: null,
      teamId: null,
      replayWindowSec: 300,
    });
  });
});
