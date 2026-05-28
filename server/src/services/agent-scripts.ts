import fs from "node:fs/promises";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * Script bundle service.
 *
 * Manages a per-agent directory of user-authored scripts under
 * `<instance>/companies/<companyId>/agents/<agentId>/scripts/`.
 *
 * Designed for the `process`/`http` adapters that execute user-supplied
 * commands rather than running an LLM session. The bundle is "managed"
 * only — Paperclip owns the directory. Unlike instructions, there is no
 * external mode and no legacy migration path.
 *
 * Files with a shebang line (`#!`) are chmod +x'd at write time so the
 * adapter can invoke them directly.
 */

const DEFAULT_ENTRY_FILE = "run.sh";
const DEFAULT_ENTRY_BODY = `#!/usr/bin/env bash
set -euo pipefail

# Paperclip exposes these in the env at runtime:
#   PAPERCLIP_API_URL      — base URL for the control plane
#   PAPERCLIP_API_KEY      — bearer token scoped to this agent
#   PAPERCLIP_TASK_ID      — UUID of the assigned issue (when present)
#   PAPERCLIP_RUN_ID       — UUID of the current heartbeat run
#   PAPERCLIP_SCRIPTS_ROOT — absolute path to this script bundle

echo "Hello from \${PAPERCLIP_AGENT_ID:-unknown}"
`;

const ROOT_KEY = "scriptBundleRoot";
const ENTRY_KEY = "scriptEntryFile";

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_DIR_NAMES = new Set([".git", "node_modules", "__pycache__"]);

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

export type AgentScriptFileSummary = {
  path: string;
  size: number;
  language: string;
  executable: boolean;
  isEntryFile: boolean;
};

export type AgentScriptFileDetail = AgentScriptFileSummary & {
  content: string;
};

export type AgentScriptBundle = {
  agentId: string;
  companyId: string;
  rootPath: string;
  entryFile: string;
  entryFilePath: string;
  files: AgentScriptFileSummary[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".sh") || lower.endsWith(".bash")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".md")) return "markdown";
  return "text";
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Script file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Script file path must stay within the bundle root");
  }
  return absolutePath;
}

export function resolveManagedScriptsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "scripts",
  );
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

function shouldIgnoreEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) return IGNORED_DIR_NAMES.has(entry.name);
  if (!entry.isFile()) return false;
  return IGNORED_FILE_NAMES.has(entry.name) || entry.name.startsWith("._");
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }
  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

function hasShebang(content: string): boolean {
  return content.startsWith("#!");
}

async function isExecutable(absolutePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absolutePath);
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function applyExecutableMode(absolutePath: string, content: string): Promise<void> {
  if (!hasShebang(content)) return;
  try {
    await fs.chmod(absolutePath, 0o755);
  } catch {
    // best-effort; chmod can fail on platforms without unix perms (Windows)
  }
}

async function readSummary(
  rootPath: string,
  relativePath: string,
  entryFile: string,
): Promise<AgentScriptFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    executable: (stat.mode & 0o111) !== 0,
    isEntryFile: relativePath === entryFile,
  };
}

function deriveBundleState(agent: AgentLike): { rootPath: string; entryFile: string } {
  const config = asRecord(agent.adapterConfig);
  const rootRaw = asString(config[ROOT_KEY]);
  const entryRaw = asString(config[ENTRY_KEY]);
  let entryFile = DEFAULT_ENTRY_FILE;
  if (entryRaw) {
    try {
      entryFile = normalizeRelativeFilePath(entryRaw);
    } catch {
      entryFile = DEFAULT_ENTRY_FILE;
    }
  }
  return {
    rootPath: rootRaw ?? resolveManagedScriptsRoot(agent),
    entryFile,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: { rootPath: string; entryFile: string },
): Record<string, unknown> {
  return {
    ...config,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
  };
}

async function ensureBundleSeed(rootPath: string, entryFile: string): Promise<void> {
  await fs.mkdir(rootPath, { recursive: true });
  const entryAbsolute = resolvePathWithinRoot(rootPath, entryFile);
  const existing = await statIfExists(entryAbsolute);
  if (existing?.isFile()) return;
  await fs.mkdir(path.dirname(entryAbsolute), { recursive: true });
  await fs.writeFile(entryAbsolute, DEFAULT_ENTRY_BODY, "utf8");
  await applyExecutableMode(entryAbsolute, DEFAULT_ENTRY_BODY);
}

export function agentScriptsService() {
  async function getBundle(agent: AgentLike): Promise<AgentScriptBundle> {
    const state = deriveBundleState(agent);
    await ensureBundleSeed(state.rootPath, state.entryFile);
    const relativePaths = await listFilesRecursive(state.rootPath);
    const files = await Promise.all(
      relativePaths.map((relativePath) => readSummary(state.rootPath, relativePath, state.entryFile)),
    );
    return {
      agentId: agent.id,
      companyId: agent.companyId,
      rootPath: state.rootPath,
      entryFile: state.entryFile,
      entryFilePath: path.resolve(state.rootPath, state.entryFile),
      files,
    };
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentScriptFileDetail> {
    const state = deriveBundleState(agent);
    const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) throw notFound("Script file not found");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      executable: await isExecutable(absolutePath),
      isEntryFile: normalizedPath === state.entryFile,
      content,
    };
  }

  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
  ): Promise<{
    bundle: AgentScriptBundle;
    file: AgentScriptFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    const state = deriveBundleState(agent);
    await fs.mkdir(state.rootPath, { recursive: true });
    const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    await applyExecutableMode(absolutePath, content);

    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), state);
    const nextAgent = { ...agent, adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig };
  }

  async function deleteFile(
    agent: AgentLike,
    relativePath: string,
  ): Promise<{ bundle: AgentScriptBundle; adapterConfig: Record<string, unknown> }> {
    const state = deriveBundleState(agent);
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the script bundle entry file");
    }
    const absolutePath = resolvePathWithinRoot(state.rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), state);
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function updateBundle(
    agent: AgentLike,
    input: { entryFile?: string },
  ): Promise<{ bundle: AgentScriptBundle; adapterConfig: Record<string, unknown> }> {
    const state = deriveBundleState(agent);
    const nextEntry = input.entryFile
      ? normalizeRelativeFilePath(input.entryFile)
      : state.entryFile;
    await ensureBundleSeed(state.rootPath, nextEntry);
    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), {
      rootPath: state.rootPath,
      entryFile: nextEntry,
    });
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  /**
   * Replace the on-disk bundle with a provided set of files. Used by the
   * company-portability importer to rehydrate scripts captured in an export.
   * Always chmod +x's files that start with a shebang.
   */
  async function materializeManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: { replaceExisting?: boolean; entryFile?: string },
  ): Promise<{ bundle: AgentScriptBundle; adapterConfig: Record<string, unknown> }> {
    const rootPath = resolveManagedScriptsRoot(agent);
    const entryFile = options?.entryFile
      ? normalizeRelativeFilePath(options.entryFile)
      : DEFAULT_ENTRY_FILE;
    if (options?.replaceExisting) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
    await fs.mkdir(rootPath, { recursive: true });
    const entries = Object.entries(files);
    for (const [relativePath, content] of entries) {
      const normalized = normalizeRelativeFilePath(relativePath);
      const absolutePath = resolvePathWithinRoot(rootPath, normalized);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
      await applyExecutableMode(absolutePath, content);
    }
    // Always make sure the entry file exists.
    if (!entries.some(([relativePath]) => normalizeRelativeFilePath(relativePath) === entryFile)) {
      await ensureBundleSeed(rootPath, entryFile);
    }
    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), { rootPath, entryFile });
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  /**
   * Read the on-disk bundle and return a `{path: content}` map suitable for
   * inclusion in a portability export.
   */
  async function exportFiles(agent: AgentLike): Promise<{
    files: Record<string, string>;
    entryFile: string;
    rootPath: string;
  }> {
    const state = deriveBundleState(agent);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return { files: {}, entryFile: state.entryFile, rootPath: state.rootPath };
    }
    const relativePaths = await listFilesRecursive(state.rootPath);
    const files = Object.fromEntries(
      await Promise.all(
        relativePaths.map(async (relativePath) => {
          const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
          const content = await fs.readFile(absolutePath, "utf8");
          return [relativePath, content] as const;
        }),
      ),
    );
    return { files, entryFile: state.entryFile, rootPath: state.rootPath };
  }

  /**
   * Ensure the on-disk bundle exists and the adapterConfig reflects the
   * managed root/entry. Called from the run hot path before the adapter
   * executes, so a freshly-edited script is ready and chmod +x'd.
   */
  async function materializeBundle(
    agent: AgentLike,
  ): Promise<{ rootPath: string; entryFile: string; entryFilePath: string }> {
    const state = deriveBundleState(agent);
    await ensureBundleSeed(state.rootPath, state.entryFile);
    // Re-apply chmod +x on every file with a shebang — covers the case
    // where the volume lost the executable bit (e.g. after a restore).
    const relativePaths = await listFilesRecursive(state.rootPath);
    for (const relativePath of relativePaths) {
      const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
      const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
      await applyExecutableMode(absolutePath, content);
    }
    return {
      rootPath: state.rootPath,
      entryFile: state.entryFile,
      entryFilePath: path.resolve(state.rootPath, state.entryFile),
    };
  }

  return {
    getBundle,
    readFile,
    writeFile,
    deleteFile,
    updateBundle,
    materializeBundle,
    materializeManagedBundle,
    exportFiles,
    resolveManagedRoot: resolveManagedScriptsRoot,
  };
}
