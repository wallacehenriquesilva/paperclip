import type { RoutineTrigger } from "@paperclipai/shared";

export type RoutineTriggerEditorDraft = {
  label: string;
  cronExpression: string;
  signingMode: string;
  replayWindowSec: string;
  slackEventTypes?: string;
  slackBotUserId?: string;
  slackTeamId?: string;
  slackSigningSecret?: string;
};

export function buildRoutineTriggerPatch(
  trigger: RoutineTrigger,
  draft: RoutineTriggerEditorDraft,
  fallbackTimezone: string,
) {
  const patch: Record<string, unknown> = {
    label: draft.label.trim() || null,
  };

  if (trigger.kind === "schedule") {
    patch.cronExpression = draft.cronExpression.trim();
    patch.timezone = trigger.timezone ?? fallbackTimezone;
  }

  if (trigger.kind === "webhook") {
    patch.signingMode = draft.signingMode;
    patch.replayWindowSec = Number(draft.replayWindowSec || "300");
  }

  if (trigger.kind === "slack_event") {
    const eventTypes = (draft.slackEventTypes ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    patch.allowedEventTypes = eventTypes.length > 0 ? eventTypes : ["app_mention"];
    patch.botUserId = draft.slackBotUserId?.trim() ? draft.slackBotUserId.trim() : null;
    patch.teamId = draft.slackTeamId?.trim() ? draft.slackTeamId.trim() : null;
    patch.replayWindowSec = Number(draft.replayWindowSec || "300");
    if (draft.slackSigningSecret && draft.slackSigningSecret.trim().length > 0) {
      patch.signingSecret = draft.slackSigningSecret.trim();
    }
  }

  return patch;
}
