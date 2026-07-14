import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LogRetentionPolicy } from "@paperclipai/shared";

let svc: ReturnType<typeof import("../services/log-retention.js")["logRetentionService"]>;
let logDir: string;
let runLogBase: string;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Tiny caps so tests don't have to write hundreds of MB. The service does not
// re-validate against presets, so casting an out-of-preset value is fine here.
function policy(overrides: Partial<LogRetentionPolicy> = {}): LogRetentionPolicy {
  return { serverLogMaxSizeMb: 0.00001, runLogMaxAgeDays: 7, ...overrides } as LogRetentionPolicy;
}

async function writeServerLog(bytes: number) {
  await fs.writeFile(path.join(logDir, "server.log"), Buffer.alloc(bytes, "x"));
}

async function writeRunLog(runId: string, ageDays: number, bytes = 100) {
  const dir = path.join(runLogBase, "co", "ag");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}.ndjson`);
  await fs.writeFile(file, Buffer.alloc(bytes, "y"));
  const when = new Date(Date.now() - ageDays * MS_PER_DAY);
  await fs.utimes(file, when, when);
  return file;
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-logret-"));
  logDir = path.join(root, "logs");
  runLogBase = path.join(root, "run-logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.mkdir(runLogBase, { recursive: true });
  process.env.PAPERCLIP_LOG_DIR = logDir;
  process.env.RUN_LOG_BASE_PATH = runLogBase;
  const mod = await import("../services/log-retention.js");
  svc = mod.logRetentionService();
});

afterAll(async () => {
  await fs.rm(path.dirname(logDir), { recursive: true, force: true });
});

// Isolate log/run-log state between tests so leftovers don't cross-contaminate.
beforeEach(async () => {
  await fs.rm(runLogBase, { recursive: true, force: true });
  await fs.mkdir(runLogBase, { recursive: true });
  await fs.rm(path.join(logDir, "server.log"), { force: true });
});

describe("log-retention pruneLogs", () => {
  it("truncates an oversized server.log WITHOUT unlinking (inode preserved)", async () => {
    await writeServerLog(100_000);
    const before = await fs.stat(path.join(logDir, "server.log"));

    const result = await svc.pruneLogs(policy());

    const after = await fs.stat(path.join(logDir, "server.log"));
    expect(result.serverLog.truncated).toBe(true);
    expect(result.serverLog.reclaimedBytes).toBe(before.size);
    // Same inode + smaller size proves fs.truncate, not unlink+recreate.
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBeLessThan(before.size);
  });

  it("leaves server.log untouched when under the cap", async () => {
    await writeServerLog(4);
    const result = await svc.pruneLogs(policy({ serverLogMaxSizeMb: 2048 }));
    expect(result.serverLog.truncated).toBe(false);
    expect(result.serverLog.reclaimedBytes).toBe(0);
    expect((await fs.stat(path.join(logDir, "server.log"))).size).toBe(4);
  });

  it("deletes run-logs older than the age cap and keeps recent ones", async () => {
    const old = await writeRunLog("old-run", 30);
    const fresh = await writeRunLog("fresh-run", 1);

    const result = await svc.pruneLogs(policy({ serverLogMaxSizeMb: 2048, runLogMaxAgeDays: 7 }));

    expect(result.runLogs.deleted).toBe(1);
    expect(result.runLogs.reclaimedBytes).toBeGreaterThan(0);
    await expect(fs.stat(old)).rejects.toBeTruthy();
    await expect(fs.stat(fresh)).resolves.toBeTruthy();
  });

  it("keeps all run-logs when age cap is 0 (keep forever)", async () => {
    const ancient = await writeRunLog("ancient-run", 999);
    const result = await svc.pruneLogs(policy({ serverLogMaxSizeMb: 2048, runLogMaxAgeDays: 0 }));
    expect(result.runLogs.deleted).toBe(0);
    await expect(fs.stat(ancient)).resolves.toBeTruthy();
  });

  it("never deletes the run-log of an active run, even if stale", async () => {
    const activeSvc = (await import("../services/log-retention.js")).logRetentionService({
      activeRunIds: async () => new Set(["busy-run"]),
    });
    const busy = await writeRunLog("busy-run", 30);
    const result = await activeSvc.pruneLogs(policy({ serverLogMaxSizeMb: 2048, runLogMaxAgeDays: 7 }));
    expect(result.runLogs.deleted).toBe(0);
    await expect(fs.stat(busy)).resolves.toBeTruthy();
  });
});
