import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildInvocationEnvForLogs,
  ensurePathInEnv,
  resolveCommandForLogs,
  runChildProcess,
} from "../utils.js";
import { applyPaperclipWorkspaceEnv } from "@paperclipai/adapter-utils/server-utils";
import { agentScriptsService } from "../../services/agent-scripts.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;

  // If the operator didn't supply an explicit command, fall back to the
  // managed script bundle entry script. The materialize call ensures the
  // file exists on disk and is chmod +x'd before we try to spawn it.
  let command = asString(config.command, "");
  let args = asStringArray(config.args);
  let scriptsRoot: string | null = null;
  if (!command) {
    const scripts = agentScriptsService();
    const materialized = await scripts.materializeBundle(agent);
    command = materialized.entryFilePath;
    scriptsRoot = materialized.rootPath;
  }
  if (!command) throw new Error("Process adapter missing command");

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }

  // Expose the wake / run context to the child process so scripts can call
  // the Paperclip API and act on the assigned task. Mirrors what the local
  // CLI adapters (gemini/codex/claude/...) do, but without their CLI-specific
  // prompt rendering.
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken && typeof env.PAPERCLIP_API_KEY !== "string") {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  const issueWorkMode =
    typeof context.issueWorkMode === "string" && context.issueWorkMode.trim().length > 0
      ? context.issueWorkMode.trim()
      : null;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  try {
    const wakePayload = (context as Record<string, unknown>).paperclipWake;
    if (wakePayload !== undefined && wakePayload !== null) {
      env.PAPERCLIP_WAKE_PAYLOAD_JSON = JSON.stringify(wakePayload);
    }
  } catch {
    // Non-fatal: drop the payload var if serialization fails (cycles, etc.).
  }

  // Workspace env (cwd, repo URL, branch, etc.) — pulled from the wake
  // context the orchestrator already prepared.
  const workspaceContext = parseObject(context.paperclipWorkspace);
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: asString(workspaceContext.cwd, ""),
    workspaceSource: asString(workspaceContext.source, ""),
    workspaceStrategy: asString(workspaceContext.strategy, ""),
    workspaceId: asString(workspaceContext.workspaceId, ""),
    workspaceRepoUrl: asString(workspaceContext.repoUrl, ""),
    workspaceRepoRef: asString(workspaceContext.repoRef, ""),
    workspaceBranch: asString(workspaceContext.branch, ""),
    workspaceWorktreePath: asString(workspaceContext.worktreePath, ""),
  });

  // Default cwd: the explicit config.cwd, or the workspace cwd, or the
  // scripts root when running the bundle entry.
  const cwd = asString(
    config.cwd,
    asString(workspaceContext.cwd, "") || scriptsRoot || process.cwd(),
  );

  if (scriptsRoot && typeof env.PAPERCLIP_SCRIPTS_ROOT !== "string") {
    env.PAPERCLIP_SCRIPTS_ROOT = scriptsRoot;
  } else if (!scriptsRoot && typeof env.PAPERCLIP_SCRIPTS_ROOT !== "string") {
    // Even when the operator set an explicit command, expose the scripts
    // root so the command can reference sibling helper files if it wants.
    const explicitRoot = asString(config.scriptBundleRoot, "");
    if (explicitRoot) env.PAPERCLIP_SCRIPTS_ROOT = path.resolve(explicitRoot);
  }
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      env: loggedEnv,
    });
  }

  const proc = await runChildProcess(runId, command, args, {
    cwd,
    env,
    timeoutSec,
    graceSec,
    onLog,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
  };
}
