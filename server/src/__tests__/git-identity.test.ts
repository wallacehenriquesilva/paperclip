import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGitIdentity, resolveGitIdentityFromAgent } from "../services/git-identity.js";

const execFile = promisify(execFileCallback);

async function makeTmpRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-identity-"));
  await execFile("git", ["init", "--quiet"], { cwd: root });
  return root;
}

async function readGitConfig(cwd: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["config", "--get", key], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readLocalGitConfig(cwd: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execFile("git", ["config", "--local", "--get", key], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

describe("configureGitIdentity", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await makeTmpRepo();
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("is a no-op when neither token nor identity is provided", async () => {
    const result = await configureGitIdentity({ cwd, env: {} });

    expect(result.credentialHelperConfigured).toBe(false);
    expect(result.authorEmailConfigured).toBe(false);
    expect(result.authorNameConfigured).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(await readLocalGitConfig(cwd, "user.email")).toBeNull();
  });

  it("writes per-repo user.email and user.name when identity is provided", async () => {
    const result = await configureGitIdentity({
      cwd,
      env: {},
      identity: { userEmail: "bot@paperclip.local", userName: "Paperclip Bot" },
    });

    expect(result.authorEmailConfigured).toBe(true);
    expect(result.authorNameConfigured).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await readGitConfig(cwd, "user.email")).toBe("bot@paperclip.local");
    expect(await readGitConfig(cwd, "user.name")).toBe("Paperclip Bot");
  });

  it("only configures email when name is absent", async () => {
    const result = await configureGitIdentity({
      cwd,
      env: {},
      identity: { userEmail: "bot@paperclip.local" },
    });

    expect(result.authorEmailConfigured).toBe(true);
    expect(result.authorNameConfigured).toBe(false);
    expect(await readLocalGitConfig(cwd, "user.email")).toBe("bot@paperclip.local");
    expect(await readLocalGitConfig(cwd, "user.name")).toBeNull();
  });

  it("treats whitespace-only values as absent", async () => {
    const result = await configureGitIdentity({
      cwd,
      env: {},
      identity: { userEmail: "   ", userName: "" },
    });

    expect(result.authorEmailConfigured).toBe(false);
    expect(result.authorNameConfigured).toBe(false);
    expect(await readLocalGitConfig(cwd, "user.email")).toBeNull();
  });

  it("is idempotent when called twice with the same identity", async () => {
    const identity = { userEmail: "bot@paperclip.local", userName: "Paperclip Bot" };
    await configureGitIdentity({ cwd, env: {}, identity });
    const second = await configureGitIdentity({ cwd, env: {}, identity });

    expect(second.warnings).toEqual([]);
    expect(await readGitConfig(cwd, "user.email")).toBe("bot@paperclip.local");
    expect(await readGitConfig(cwd, "user.name")).toBe("Paperclip Bot");
  });

  it("writes only the per-repo local config, never --global", async () => {
    await configureGitIdentity({
      cwd,
      env: {},
      identity: { userEmail: "scoped@paperclip.local", userName: "Scoped" },
    });

    expect(await readLocalGitConfig(cwd, "user.email")).toBe("scoped@paperclip.local");
    expect(await readLocalGitConfig(cwd, "user.name")).toBe("Scoped");
  });

  it("records warnings instead of throwing when cwd is invalid", async () => {
    const missing = path.join(cwd, "does-not-exist");
    const result = await configureGitIdentity({
      cwd: missing,
      env: {},
      identity: { userEmail: "bot@paperclip.local", userName: "Bot" },
    });

    expect(result.authorEmailConfigured).toBe(false);
    expect(result.authorNameConfigured).toBe(false);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("records a warning instead of throwing when gh binary is missing for token path", async () => {
    const env = { GH_TOKEN: "ghp_fake_token", PATH: "/nonexistent-dir-for-tests" };
    const result = await configureGitIdentity({ cwd, env });

    expect(result.credentialHelperConfigured).toBe(false);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toMatch(/gh auth setup-git/);
  });

  it("only attempts the credential helper when a non-empty token is present", async () => {
    const result = await configureGitIdentity({
      cwd,
      env: { GH_TOKEN: "   ", GITHUB_TOKEN: "" },
    });
    expect(result.credentialHelperConfigured).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe("resolveGitIdentityFromAgent", () => {
  it("returns null when neither metadata nor env has identity info", () => {
    expect(resolveGitIdentityFromAgent({ agentMetadata: null })).toBeNull();
    expect(resolveGitIdentityFromAgent({ agentMetadata: {} })).toBeNull();
    expect(resolveGitIdentityFromAgent({ agentMetadata: { github: {} } })).toBeNull();
  });

  it("reads identity from agent.metadata.github when present", () => {
    const identity = resolveGitIdentityFromAgent({
      agentMetadata: { github: { userEmail: "bot@x.io", userName: "Bot" } },
    });
    expect(identity).toEqual({ userEmail: "bot@x.io", userName: "Bot" });
  });

  it("falls back to GIT_AUTHOR_EMAIL / GIT_AUTHOR_NAME env vars", () => {
    const identity = resolveGitIdentityFromAgent({
      agentMetadata: null,
      env: { GIT_AUTHOR_EMAIL: "env@x.io", GIT_AUTHOR_NAME: "Env Bot" },
    });
    expect(identity).toEqual({ userEmail: "env@x.io", userName: "Env Bot" });
  });

  it("prefers metadata over env when both are present", () => {
    const identity = resolveGitIdentityFromAgent({
      agentMetadata: { github: { userEmail: "meta@x.io", userName: "Meta" } },
      env: { GIT_AUTHOR_EMAIL: "env@x.io", GIT_AUTHOR_NAME: "Env" },
    });
    expect(identity).toEqual({ userEmail: "meta@x.io", userName: "Meta" });
  });

  it("mixes sources when each side has different fields filled", () => {
    const identity = resolveGitIdentityFromAgent({
      agentMetadata: { github: { userEmail: "meta@x.io" } },
      env: { GIT_AUTHOR_NAME: "Env Bot" },
    });
    expect(identity).toEqual({ userEmail: "meta@x.io", userName: "Env Bot" });
  });

  it("ignores non-string metadata values", () => {
    const identity = resolveGitIdentityFromAgent({
      agentMetadata: { github: { userEmail: 42, userName: null } },
    });
    expect(identity).toBeNull();
  });
});
