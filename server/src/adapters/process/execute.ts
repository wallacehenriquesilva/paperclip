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
import { agentScriptsService } from "../../services/agent-scripts.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta } = ctx;

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

  const cwd = asString(config.cwd, scriptsRoot ?? process.cwd());
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
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
