import { z } from "zod";
import {
  ISSUE_PRIORITIES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  ROUTINE_VARIABLE_TYPES,
  SLACK_COMMAND_MAX_ACK_LENGTH,
  SLACK_COMMAND_NAME_PATTERN,
  SLACK_EVENT_TRIGGER_DEFAULT_EVENT_TYPES,
} from "../constants.js";
import {
  ISSUE_EXECUTION_WORKSPACE_PREFERENCES,
  issueExecutionWorkspaceSettingsSchema,
} from "./issue.js";

const routineVariableValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const routineVariableSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().trim().max(120).optional().nullable(),
  type: z.enum(ROUTINE_VARIABLE_TYPES).optional().default("text"),
  defaultValue: routineVariableValueSchema.optional().nullable(),
  required: z.boolean().optional().default(true),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional().default([]),
}).superRefine((value, ctx) => {
  if (value.type === "select" && value.options.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Select variables require at least one option",
    });
  }
  if (value.type !== "select" && value.options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: "Only select variables can define options",
    });
  }
  if (value.type === "select" && value.defaultValue != null) {
    if (typeof value.defaultValue !== "string" || !value.options.includes(value.defaultValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultValue"],
        message: "Select variable defaults must match one of the allowed options",
      });
    }
  }
});

export const createRoutineSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentIssueId: z.string().uuid().optional().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  status: z.enum(ROUTINE_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES).optional().default("skip_missed"),
  variables: z.array(routineVariableSchema).optional().default([]),
});

export type CreateRoutine = z.infer<typeof createRoutineSchema>;

export const updateRoutineSchema = createRoutineSchema.partial().extend({
  baseRevisionId: z.string().uuid().optional().nullable(),
});
export type UpdateRoutine = z.infer<typeof updateRoutineSchema>;

export const routineRevisionSnapshotRoutineV1Schema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  goalId: z.string().uuid().nullable(),
  parentIssueId: z.string().uuid().nullable(),
  title: z.string().trim().min(1).max(200),
  description: z.string().nullable(),
  assigneeAgentId: z.string().uuid().nullable(),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ROUTINE_STATUSES),
  concurrencyPolicy: z.enum(ROUTINE_CONCURRENCY_POLICIES),
  catchUpPolicy: z.enum(ROUTINE_CATCH_UP_POLICIES),
  variables: z.array(routineVariableSchema),
}).strict();

export const routineRevisionSnapshotTriggerV1Schema = z.object({
  id: z.string().uuid(),
  kind: z.enum(ROUTINE_TRIGGER_KINDS),
  label: z.string().nullable(),
  enabled: z.boolean(),
  cronExpression: z.string().nullable(),
  timezone: z.string().nullable(),
  publicId: z.string().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).nullable(),
  allowedEventTypes: z.array(z.string().min(1)).nullable().optional(),
  botUserId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
}).strict();

export const routineRevisionSnapshotV1Schema = z.object({
  version: z.literal(1),
  routine: routineRevisionSnapshotRoutineV1Schema,
  triggers: z.array(routineRevisionSnapshotTriggerV1Schema),
}).strict();

export const routineRevisionSnapshotSchema = routineRevisionSnapshotV1Schema;
export type RoutineRevisionSnapshotV1 = z.infer<typeof routineRevisionSnapshotV1Schema>;
export type RoutineRevisionSnapshot = z.infer<typeof routineRevisionSnapshotSchema>;

const baseTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]+$/;
const SLACK_TEAM_ID_PATTERN = /^T[A-Z0-9]+$/;
const SLACK_CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]+$/;

export const createRoutineTriggerSchema = z.discriminatedUnion("kind", [
  baseTriggerSchema.extend({
    kind: z.literal("schedule"),
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).default("UTC"),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("webhook"),
    signingMode: z.enum(["bearer", "hmac_sha256", "github_hmac", "none"]).optional().default("bearer"),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("api"),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("slack_event"),
    signingSecret: z.string().trim().min(1).max(2048),
    allowedEventTypes: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(50)
      .optional()
      .default([...SLACK_EVENT_TRIGGER_DEFAULT_EVENT_TYPES]),
    botUserId: z.string().trim().regex(SLACK_USER_ID_PATTERN).optional().nullable(),
    teamId: z.string().trim().regex(SLACK_TEAM_ID_PATTERN).optional().nullable(),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
  baseTriggerSchema.extend({
    kind: z.literal("slack_command"),
    signingSecret: z.string().trim().min(1).max(2048),
    allowedCommands: z
      .array(z.string().trim().regex(SLACK_COMMAND_NAME_PATTERN))
      .min(1, "configure at least one slash command name")
      .max(50),
    allowedUserIds: z
      .array(z.string().trim().regex(SLACK_USER_ID_PATTERN))
      .max(200)
      .optional()
      .nullable(),
    allowedChannelIds: z
      .array(z.string().trim().regex(SLACK_CHANNEL_ID_PATTERN))
      .max(200)
      .optional()
      .nullable(),
    teamId: z.string().trim().regex(SLACK_TEAM_ID_PATTERN).optional().nullable(),
    ackMessage: z.string().trim().max(SLACK_COMMAND_MAX_ACK_LENGTH).optional().nullable(),
    replayWindowSec: z.number().int().min(30).max(86_400).optional().default(300),
  }),
]);

export type CreateRoutineTrigger = z.infer<typeof createRoutineTriggerSchema>;

export const updateRoutineTriggerSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().trim().min(1).optional().nullable(),
  timezone: z.string().trim().min(1).optional().nullable(),
  signingMode: z.enum(ROUTINE_TRIGGER_SIGNING_MODES).optional().nullable(),
  replayWindowSec: z.number().int().min(30).max(86_400).optional().nullable(),
  signingSecret: z.string().trim().min(1).max(2048).optional(),
  allowedEventTypes: z.array(z.string().trim().min(1).max(120)).min(1).max(50).optional().nullable(),
  botUserId: z.string().trim().regex(SLACK_USER_ID_PATTERN).optional().nullable(),
  teamId: z.string().trim().regex(SLACK_TEAM_ID_PATTERN).optional().nullable(),
  allowedCommands: z
    .array(z.string().trim().regex(SLACK_COMMAND_NAME_PATTERN))
    .min(1)
    .max(50)
    .optional()
    .nullable(),
  allowedUserIds: z
    .array(z.string().trim().regex(SLACK_USER_ID_PATTERN))
    .max(200)
    .optional()
    .nullable(),
  allowedChannelIds: z
    .array(z.string().trim().regex(SLACK_CHANNEL_ID_PATTERN))
    .max(200)
    .optional()
    .nullable(),
  ackMessage: z.string().trim().max(SLACK_COMMAND_MAX_ACK_LENGTH).optional().nullable(),
});

export type UpdateRoutineTrigger = z.infer<typeof updateRoutineTriggerSchema>;

export const runRoutineSchema = z.object({
  triggerId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()).optional().nullable(),
  variables: z.record(routineVariableValueSchema).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  idempotencyKey: z.string().trim().max(255).optional().nullable(),
  source: z.enum(["manual", "api"]).optional().default("manual"),
  executionWorkspaceId: z.string().uuid().optional().nullable(),
  executionWorkspacePreference: z.enum(ISSUE_EXECUTION_WORKSPACE_PREFERENCES).optional().nullable(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.optional().nullable(),
});

export type RunRoutine = z.infer<typeof runRoutineSchema>;

export const rotateRoutineTriggerSecretSchema = z.object({});
export type RotateRoutineTriggerSecret = z.infer<typeof rotateRoutineTriggerSecretSchema>;
