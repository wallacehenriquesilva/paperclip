import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROUTINE_VARIABLE_NAMES,
  extractRoutineVariableNames,
  getBuiltinRoutineVariableValues,
  interpolateRoutineTemplate,
  isBuiltinRoutineVariable,
  syncRoutineVariablesWithTemplate,
} from "./routine-variables.js";

describe("routine variable helpers", () => {
  it("extracts placeholder names in first-appearance order", () => {
    expect(
      extractRoutineVariableNames("Review {{repo}} and {{priority}} for {{repo}}"),
    ).toEqual(["repo", "priority"]);
  });

  it("deduplicates placeholder names across the routine title and description", () => {
    expect(
      extractRoutineVariableNames([
        "Triage {{repo}}",
        "Review {{repo}} for {{priority}} bugs",
      ]),
    ).toEqual(["repo", "priority"]);
  });

  it("preserves existing metadata when syncing variables from a template", () => {
    expect(
      syncRoutineVariablesWithTemplate(["Triage {{repo}}", "Review {{repo}} and {{priority}}"], [
        { name: "repo", label: "Repository", type: "text", defaultValue: "paperclip", required: true, options: [] },
      ]),
    ).toEqual([
      { name: "repo", label: "Repository", type: "text", defaultValue: "paperclip", required: true, options: [] },
      { name: "priority", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("interpolates provided variable values into the routine template", () => {
    expect(
      interpolateRoutineTemplate("Review {{repo}} for {{priority}}", {
        repo: "paperclip",
        priority: "high",
      }),
    ).toBe("Review paperclip for high");
  });

  it("identifies built-in variable names", () => {
    expect(isBuiltinRoutineVariable("date")).toBe(true);
    expect(isBuiltinRoutineVariable("timestamp")).toBe(true);
    expect(isBuiltinRoutineVariable("payload")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_user")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_text")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_channel")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_thread_ts")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_team_id")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_event_id")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_command")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_user_id")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_user_name")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_channel_id")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_channel_name")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_trigger_id")).toBe(true);
    expect(isBuiltinRoutineVariable("slack_response_url")).toBe(true);
    expect(isBuiltinRoutineVariable("repo")).toBe(false);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("date")).toBe(true);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("timestamp")).toBe(true);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("payload")).toBe(true);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("slack_event_id")).toBe(true);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("slack_command")).toBe(true);
    expect(BUILTIN_ROUTINE_VARIABLE_NAMES.has("slack_response_url")).toBe(true);
  });

  it("getBuiltinRoutineVariableValues defaults payload and slack_* to empty strings", () => {
    const values = getBuiltinRoutineVariableValues();
    expect(values.payload).toBe("");
    expect(values.slack_user).toBe("");
    expect(values.slack_text).toBe("");
    expect(values.slack_channel).toBe("");
    expect(values.slack_thread_ts).toBe("");
    expect(values.slack_team_id).toBe("");
    expect(values.slack_event_id).toBe("");
    expect(values.slack_command).toBe("");
    expect(values.slack_user_id).toBe("");
    expect(values.slack_user_name).toBe("");
    expect(values.slack_channel_id).toBe("");
    expect(values.slack_channel_name).toBe("");
    expect(values.slack_trigger_id).toBe("");
    expect(values.slack_response_url).toBe("");
  });

  it("getBuiltinRoutineVariableValues returns date in YYYY-MM-DD format", () => {
    const values = getBuiltinRoutineVariableValues();
    expect(values.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(values.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("getBuiltinRoutineVariableValues returns a human-readable timestamp with year, time, and UTC", () => {
    const values = getBuiltinRoutineVariableValues();
    const year = String(new Date().getUTCFullYear());
    expect(values.timestamp).toContain(year);
    expect(values.timestamp).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    expect(values.timestamp).toContain("UTC");
  });

  it("excludes built-in variables from syncRoutineVariablesWithTemplate", () => {
    const result = syncRoutineVariablesWithTemplate(
      "Daily report for {{date}} at {{timestamp}} ({{payload}}) — {{repo}} from {{slack_user}} in {{slack_channel}}",
      [],
    );
    expect(result).toEqual([
      { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("resolves dotted paths against the object context when present", () => {
    const result = interpolateRoutineTemplate(
      "user={{payload.event.user}} ts={{payload.event.ts}}",
      {},
      { payload: { event: { user: "U123", ts: "1700000000.000100" } } },
    );
    expect(result).toBe("user=U123 ts=1700000000.000100");
  });

  it("stringifies nested objects and arrays resolved by dotted path", () => {
    const blocks = [{ type: "rich_text", text: "hi" }];
    const result = interpolateRoutineTemplate(
      "blocks={{payload.event.blocks}}",
      {},
      { payload: { event: { blocks } } },
    );
    expect(result).toBe(`blocks=${JSON.stringify(blocks)}`);
  });

  it("leaves a dotted placeholder literal when the path does not resolve", () => {
    const result = interpolateRoutineTemplate(
      "ghost={{payload.event.missing.deep}}",
      {},
      { payload: { event: {} } },
    );
    expect(result).toBe("ghost={{payload.event.missing.deep}}");
  });

  it("extracts only the head of dotted placeholder names for variable sync", () => {
    expect(
      extractRoutineVariableNames("Hi {{payload.event.user}} from {{repo}}"),
    ).toEqual(["payload", "repo"]);
    const result = syncRoutineVariablesWithTemplate(
      "Hi {{payload.event.user}} from {{repo}}",
      [],
    );
    expect(result).toEqual([
      { name: "repo", label: null, type: "text", defaultValue: null, required: true, options: [] },
    ]);
  });

  it("interpolates built-in variables alongside user variables", () => {
    const builtins = getBuiltinRoutineVariableValues();
    const allVars = { ...builtins, repo: "paperclip" };
    expect(
      interpolateRoutineTemplate("Report for {{date}} ({{timestamp}}) on {{repo}}", allVars),
    ).toBe(`Report for ${builtins.date} (${builtins.timestamp}) on paperclip`);
  });
});
