import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type { LogRetentionPolicy, LogPruneResult } from "@paperclipai/shared";
import { readConfigFile } from "../config-file.js";
import {
  resolveDefaultLogsDir,
  resolveHomeAwarePath,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Must mirror `resolveServerLogDir` in middleware/logger.ts exactly — the prune
// truncates whatever pino writes to. If the precedence drifts, we would silently
// truncate the wrong (or a nonexistent) file and reclaim nothing.
function resolveServerLogPath(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  const logDir = envOverride
    ? resolveHomeAwarePath(envOverride)
    : (() => {
        const fileLogDir = readConfigFile()?.logging.logDir?.trim();
        return fileLogDir ? resolveHomeAwarePath(fileLogDir) : resolveDefaultLogsDir();
      })();
  return path.join(logDir, "server.log");
}

function resolveRunLogBasePath(): string {
  return (
    process.env.RUN_LOG_BASE_PATH ??
    path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs")
  );
}

async function collectNdjsonFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectNdjsonFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ndjson")) {
      files.push(full);
    }
  }
  return files;
}

export interface LogRetentionDeps {
  // Run ids that are still active; their run-log files are never deleted even if
  // their mtime is stale (a long, silent run must keep appending to its log).
  activeRunIds?: () => Promise<Set<string>>;
}

export function logRetentionService(deps: LogRetentionDeps = {}) {
  async function pruneServerLog(policy: LogRetentionPolicy): Promise<LogPruneResult["serverLog"]> {
    const filePath = resolveServerLogPath();
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      return { path: filePath, existed: false, truncated: false, reclaimedBytes: 0 };
    }
    const cap = policy.serverLogMaxSizeMb * 1024 * 1024;
    if (stat.size <= cap) {
      return { path: filePath, existed: true, truncated: false, reclaimedBytes: 0 };
    }
    // Truncate — never unlink. pino holds this file open; unlinking would keep the
    // space held by the open fd and hide the log until restart. pino appends with
    // O_APPEND, so after truncation the next write lands at offset 0 (no sparse file).
    await fs.truncate(filePath, 0);
    return { path: filePath, existed: true, truncated: true, reclaimedBytes: stat.size };
  }

  async function pruneRunLogs(policy: LogRetentionPolicy): Promise<LogPruneResult["runLogs"]> {
    const basePath = resolveRunLogBasePath();
    if (policy.runLogMaxAgeDays <= 0) {
      return { basePath, scanned: 0, deleted: 0, reclaimedBytes: 0 };
    }
    const files = await collectNdjsonFiles(basePath);
    const cutoff = Date.now() - policy.runLogMaxAgeDays * MS_PER_DAY;
    const activeRunIds = deps.activeRunIds ? await deps.activeRunIds() : new Set<string>();

    let deleted = 0;
    let reclaimedBytes = 0;
    for (const filePath of files) {
      const runId = path.basename(filePath, ".ndjson");
      if (activeRunIds.has(runId)) continue;
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;
      if (stat.mtimeMs >= cutoff) continue;
      try {
        await fs.unlink(filePath);
        deleted += 1;
        reclaimedBytes += stat.size;
      } catch {
        // Best-effort: a file removed concurrently (e.g. a run finishing) is fine.
      }
    }
    return { basePath, scanned: files.length, deleted, reclaimedBytes };
  }

  return {
    resolveServerLogPath,
    resolveRunLogBasePath,
    pruneLogs: async (policy: LogRetentionPolicy): Promise<LogPruneResult> => {
      const [serverLog, runLogs] = await Promise.all([
        pruneServerLog(policy),
        pruneRunLogs(policy),
      ]);
      const result: LogPruneResult = { serverLog, runLogs };
      if (serverLog.truncated || runLogs.deleted > 0) {
        logger.info(
          {
            serverLogTruncated: serverLog.truncated,
            serverLogReclaimedBytes: serverLog.reclaimedBytes,
            runLogsDeleted: runLogs.deleted,
            runLogsReclaimedBytes: runLogs.reclaimedBytes,
          },
          "log retention prune reclaimed disk space",
        );
      }
      return result;
    },
  };
}
