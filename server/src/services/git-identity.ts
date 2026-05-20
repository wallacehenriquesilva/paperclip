import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readAgentGithubIdentity } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const execFile = promisify(execFileCallback);

const GH_AUTH_SETUP_TIMEOUT_MS = 15_000;
const GIT_CONFIG_TIMEOUT_MS = 5_000;

export interface GitIdentity {
  userEmail?: string | null;
  userName?: string | null;
}

export interface ConfigureGitIdentityInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
  identity?: GitIdentity | null;
  /**
   * Optional context for log lines so operators can trace which agent/run a
   * configuration step belongs to.
   */
  logContext?: Record<string, unknown>;
}

export interface ConfigureGitIdentityResult {
  credentialHelperConfigured: boolean;
  authorEmailConfigured: boolean;
  authorNameConfigured: boolean;
  warnings: string[];
}

function hasGithubToken(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    (typeof env.GH_TOKEN === "string" && env.GH_TOKEN.trim().length > 0) ||
      (typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim().length > 0),
  );
}

function readableError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Configures git inside `cwd` so it can authenticate to GitHub and attribute
 * commits correctly. Idempotent and scoped to the given checkout — never
 * writes to --global config.
 *
 * - If GH_TOKEN or GITHUB_TOKEN is present in `env`, runs `gh auth setup-git`
 *   which installs a credential helper that delegates to the `gh` CLI. From
 *   that point, `git push https://github.com/...` works without further wiring.
 * - If `identity.userEmail` / `identity.userName` are provided, writes them as
 *   per-repo `user.email` / `user.name` — so two agents sharing a container
 *   can have distinct commit authors.
 *
 * Failures are downgraded to warnings; this helper never throws so workspace
 * preparation can still proceed when, e.g., the `gh` binary is missing.
 */
export async function configureGitIdentity(
  input: ConfigureGitIdentityInput,
): Promise<ConfigureGitIdentityResult> {
  const warnings: string[] = [];
  const result: ConfigureGitIdentityResult = {
    credentialHelperConfigured: false,
    authorEmailConfigured: false,
    authorNameConfigured: false,
    warnings,
  };

  if (hasGithubToken(input.env)) {
    try {
      await execFile("gh", ["auth", "setup-git"], {
        env: input.env,
        cwd: input.cwd,
        timeout: GH_AUTH_SETUP_TIMEOUT_MS,
      });
      result.credentialHelperConfigured = true;
    } catch (err) {
      const message = `gh auth setup-git failed: ${readableError(err)}`;
      warnings.push(message);
      logger.warn(
        { ...(input.logContext ?? {}), cwd: input.cwd, err: readableError(err) },
        "configureGitIdentity: gh auth setup-git failed",
      );
    }
  }

  const email = input.identity?.userEmail?.trim();
  if (email) {
    try {
      await execFile("git", ["config", "user.email", email], {
        cwd: input.cwd,
        timeout: GIT_CONFIG_TIMEOUT_MS,
      });
      result.authorEmailConfigured = true;
    } catch (err) {
      const message = `git config user.email failed: ${readableError(err)}`;
      warnings.push(message);
      logger.warn(
        { ...(input.logContext ?? {}), cwd: input.cwd, err: readableError(err) },
        "configureGitIdentity: git config user.email failed",
      );
    }
  }

  const name = input.identity?.userName?.trim();
  if (name) {
    try {
      await execFile("git", ["config", "user.name", name], {
        cwd: input.cwd,
        timeout: GIT_CONFIG_TIMEOUT_MS,
      });
      result.authorNameConfigured = true;
    } catch (err) {
      const message = `git config user.name failed: ${readableError(err)}`;
      warnings.push(message);
      logger.warn(
        { ...(input.logContext ?? {}), cwd: input.cwd, err: readableError(err) },
        "configureGitIdentity: git config user.name failed",
      );
    }
  }

  return result;
}

/**
 * Pulls a typed GitIdentity out of an agent's `metadata.github` jsonb blob if
 * it exists. Falls back to GIT_AUTHOR_EMAIL / GIT_AUTHOR_NAME env conventions
 * so an operator can already steer this today via plain env entries.
 */
export function resolveGitIdentityFromAgent(input: {
  agentMetadata?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
}): GitIdentity | null {
  const github = readAgentGithubIdentity(input.agentMetadata ?? null);
  const fromMetadataEmail = github?.userEmail ?? null;
  const fromMetadataName = github?.userName ?? null;

  const env = input.env ?? {};
  const fromEnvEmail = typeof env.GIT_AUTHOR_EMAIL === "string" ? env.GIT_AUTHOR_EMAIL : null;
  const fromEnvName = typeof env.GIT_AUTHOR_NAME === "string" ? env.GIT_AUTHOR_NAME : null;

  const userEmail = fromMetadataEmail ?? fromEnvEmail ?? null;
  const userName = fromMetadataName ?? fromEnvName ?? null;
  if (!userEmail && !userName) return null;
  return { userEmail, userName };
}
