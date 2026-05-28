import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentScriptsService } from "./agent-scripts.js";

describe("agentScriptsService", () => {
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-scripts-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = tmpHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function fakeAgent(overrides?: Partial<{ id: string; companyId: string; adapterConfig: unknown }>) {
    return {
      id: overrides?.id ?? randomUUID(),
      companyId: overrides?.companyId ?? randomUUID(),
      name: "test",
      adapterConfig: overrides?.adapterConfig ?? {},
    };
  }

  it("seeds an entry script when none exists", async () => {
    const svc = agentScriptsService();
    const agent = fakeAgent();
    const bundle = await svc.getBundle(agent);
    expect(bundle.entryFile).toBe("run.sh");
    expect(bundle.files.some((file) => file.path === "run.sh")).toBe(true);
    const detail = await svc.readFile(agent, "run.sh");
    expect(detail.content.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(detail.executable).toBe(true);
  });

  it("writes a new file and marks files with shebang as executable", async () => {
    const svc = agentScriptsService();
    const agent = fakeAgent();
    const { file } = await svc.writeFile(agent, "helper.sh", "#!/bin/bash\necho hi\n");
    expect(file.path).toBe("helper.sh");
    expect(file.executable).toBe(true);
    const notExecutable = await svc.writeFile(agent, "notes.txt", "just a note\n");
    expect(notExecutable.file.executable).toBe(false);
  });

  it("rejects deleting the entry script and accepts deleting others", async () => {
    const svc = agentScriptsService();
    const agent = fakeAgent();
    await svc.writeFile(agent, "helper.sh", "#!/bin/bash\necho hi\n");
    await expect(svc.deleteFile(agent, "run.sh")).rejects.toThrow(/entry/i);
    const after = await svc.deleteFile(agent, "helper.sh");
    expect(after.bundle.files.some((file) => file.path === "helper.sh")).toBe(false);
  });

  it("rejects paths that escape the bundle root", async () => {
    const svc = agentScriptsService();
    const agent = fakeAgent();
    await expect(svc.writeFile(agent, "../escape.sh", "noop")).rejects.toThrow(/bundle root/i);
  });

  it("materializeManagedBundle replaces files and keeps chmod +x semantics", async () => {
    const svc = agentScriptsService();
    const agent = fakeAgent();
    await svc.writeFile(agent, "stale.sh", "#!/bin/bash\nexit 0\n");
    const { bundle, adapterConfig } = await svc.materializeManagedBundle(
      agent,
      { "new.sh": "#!/bin/bash\necho new\n", "data.txt": "plain" },
      { replaceExisting: true },
    );
    const paths = bundle.files.map((file) => file.path).sort();
    // entry file is auto-created when not in the provided set
    expect(paths).toContain("run.sh");
    expect(paths).toContain("new.sh");
    expect(paths).toContain("data.txt");
    expect(paths).not.toContain("stale.sh");
    const newScript = bundle.files.find((file) => file.path === "new.sh");
    expect(newScript?.executable).toBe(true);
    const data = bundle.files.find((file) => file.path === "data.txt");
    expect(data?.executable).toBe(false);
    expect((adapterConfig as Record<string, unknown>).scriptBundleRoot).toBe(bundle.rootPath);
    expect(await fs.readdir(bundle.rootPath)).toContain("new.sh");
  });

  it("exportFiles returns every file in the bundle root", async () => {
    const svc = agentScriptsService();
    const agent = fakeAgent();
    await svc.writeFile(agent, "nested/inner.sh", "#!/bin/bash\necho inner\n");
    const exported = await svc.exportFiles(agent);
    expect(exported.entryFile).toBe("run.sh");
    expect(Object.keys(exported.files).sort()).toEqual(["nested/inner.sh", "run.sh"]);
  });
});
