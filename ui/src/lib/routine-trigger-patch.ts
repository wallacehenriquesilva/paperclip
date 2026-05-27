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
  slackCommandAllowedCommands?: string;
  slackCommandAllowedUserIds?: string;
  slackCommandAllowedChannelIds?: string;
  slackCommandAckMessage?: string;
};

function splitCommaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

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
    const eventTypes = splitCommaList(draft.slackEventTypes);
    patch.allowedEventTypes = eventTypes.length > 0 ? eventTypes : ["app_mention"];
    patch.botUserId = draft.slackBotUserId?.trim() ? draft.slackBotUserId.trim() : null;
    patch.teamId = draft.slackTeamId?.trim() ? draft.slackTeamId.trim() : null;
    patch.replayWindowSec = Number(draft.replayWindowSec || "300");
    if (draft.slackSigningSecret && draft.slackSigningSecret.trim().length > 0) {
      patch.signingSecret = draft.slackSigningSecret.trim();
    }
  }

  if (trigger.kind === "slack_command") {
    const commands = splitCommaList(draft.slackCommandAllowedCommands);
    if (commands.length > 0) {
      patch.allowedCommands = commands;
    }
    const userIds = splitCommaList(draft.slackCommandAllowedUserIds);
    patch.allowedUserIds = userIds.length > 0 ? userIds : null;
    const channelIds = splitCommaList(draft.slackCommandAllowedChannelIds);
    patch.allowedChannelIds = channelIds.length > 0 ? channelIds : null;
    patch.teamId = draft.slackTeamId?.trim() ? draft.slackTeamId.trim() : null;
    patch.ackMessage = draft.slackCommandAckMessage?.trim() ? draft.slackCommandAckMessage.trim() : null;
    patch.replayWindowSec = Number(draft.replayWindowSec || "300");
    if (draft.slackSigningSecret && draft.slackSigningSecret.trim().length > 0) {
      patch.signingSecret = draft.slackSigningSecret.trim();
    }
  }

  return patch;
}
