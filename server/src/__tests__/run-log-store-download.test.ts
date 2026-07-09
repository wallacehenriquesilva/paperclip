import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let store: import("../services/run-log-store.js").RunLogStore;
let baseDir: string;

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runlog-"));
  process.env.RUN_LOG_BASE_PATH = baseDir;
  const mod = await import("../services/run-log-store.js");
  store = mod.getRunLogStore();
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe("run-log-store openReadStream", () => {
  it("streams the complete raw ndjson file with an accurate byte size", async () => {
    const handle = await store.begin({ companyId: "co", agentId: "ag", runId: "run-1" });
    await store.append(handle, { stream: "stdout", chunk: "hello", ts: "2026-07-09T00:00:00.000Z" });
    await store.append(handle, { stream: "stderr", chunk: "world", ts: "2026-07-09T00:00:01.000Z" });

    const { stream, size } = await store.openReadStream(handle);
    const content = await drain(stream);

    // Byte size matches what the HTTP Content-Length header will report.
    expect(size).toBe(Buffer.byteLength(content, "utf8"));

    // Both appended events are present, one JSON object per line.
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ stream: "stdout", chunk: "hello" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ stream: "stderr", chunk: "world" });
  });

  it("rejects a handle whose backing file does not exist", async () => {
    await expect(
      store.openReadStream({ store: "local_file", logRef: "co/ag/missing.ndjson" }),
    ).rejects.toThrow(/not found/i);
  });
});
