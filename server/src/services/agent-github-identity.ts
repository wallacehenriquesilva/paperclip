import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import {
  type AgentGithubIdentity,
  type AgentGithubIdentityInput,
  type AgentGithubIdentityView,
  deriveAgentGithubIdentityStatus,
  mergeAgentGithubIdentityIntoMetadata,
  normalizeAgentGithubIdentityInput,
  readAgentGithubIdentity,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { secretService } from "./secrets.js";

const execFile = promisify(execFileCallback);
const GH_AUTH_STATUS_TIMEOUT_MS = 10_000;

const GH_TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

export interface AgentGithubIdentityServiceActor {
  userId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}

export interface SetAgentGithubIdentityResult {
  view: AgentGithubIdentityView;
  /** True when transition was new connection, updated, or disconnection. */
  changeKind: "connected" | "updated" | "disconnected" | "noop";
}

export interface TestAgentGithubIdentityResult {
  ok: boolean;
  status: "no_token" | "no_gh_binary" | "unauthenticated" | "authenticated";
  detail: string | null;
  hostname: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function agentGithubIdentityService(db: Db) {
  const agents = agentService(db);
  const secrets = secretService(db);

  async function buildView(input: {
    identity: AgentGithubIdentity | null;
    adapterConfig: Record<string, unknown> | null;
    companyId: string;
  }): Promise<AgentGithubIdentityView> {
    const envBlock = asRecord(input.adapterConfig?.env) ?? {};
    const boundAtAdapterConfig = GH_TOKEN_ENV_KEYS.some((key) => {
      const value = envBlock[key];
      if (!value) return false;
      if (typeof value === "string") return value.length > 0;
      if (typeof value === "object") {
        const ref = value as Record<string, unknown>;
        return ref.type === "secret_ref" && typeof ref.secretId === "string";
      }
      return false;
    });

    let tokenSecretName: string | null = null;
    if (input.identity?.tokenSecretId) {
      const secret = await secrets.getById(input.identity.tokenSecretId);
      if (secret && secret.companyId === input.companyId) {
        tokenSecretName = secret.name;
      }
    }

    return {
      status: deriveAgentGithubIdentityStatus(input.identity, boundAtAdapterConfig),
      username: input.identity?.username ?? null,
      userEmail: input.identity?.userEmail ?? null,
      userName: input.identity?.userName ?? null,
      tokenSecretId: input.identity?.tokenSecretId ?? null,
      tokenSecretName,
      boundAtAdapterConfig,
    };
  }

  async function read(agentId: string): Promise<AgentGithubIdentityView | null> {
    const agent = await agents.getById(agentId);
    if (!agent) return null;
    const identity = readAgentGithubIdentity(agent.metadata ?? null);
    return await buildView({
      identity,
      adapterConfig: asRecord(agent.adapterConfig),
      companyId: agent.companyId,
    });
  }

  async function set(
    agentId: string,
    rawInput: AgentGithubIdentityInput,
    actor?: AgentGithubIdentityServiceActor,
  ): Promise<SetAgentGithubIdentityResult> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");

    const next = normalizeAgentGithubIdentityInput(rawInput);
    if (!next) throw unprocessable("github identity payload is empty");

    if (next.tokenSecretId) {
      const secret = await secrets.getById(next.tokenSecretId);
      if (!secret || secret.companyId !== agent.companyId) {
        throw unprocessable("tokenSecretId does not reference a company secret");
      }
      if (secret.status === "deleted") {
        throw conflict("tokenSecretId references a deleted secret");
      }
    }

    const previousIdentity = readAgentGithubIdentity(agent.metadata ?? null);
    const previousAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const previousEnv = asRecord(previousAdapterConfig.env) ?? {};

    const nextMetadata = mergeAgentGithubIdentityIntoMetadata(
      asRecord(agent.metadata),
      next,
    );

    const nextEnv: Record<string, unknown> = { ...previousEnv };
    if (next.tokenSecretId) {
      const ref = { type: "secret_ref" as const, secretId: next.tokenSecretId, version: "latest" as const };
      for (const key of GH_TOKEN_ENV_KEYS) {
        nextEnv[key] = ref;
      }
    } else {
      for (const key of GH_TOKEN_ENV_KEYS) {
        const current = nextEnv[key];
        if (isManagedGithubSecretRef(current)) delete nextEnv[key];
      }
    }
    const nextAdapterConfig: Record<string, unknown> = { ...previousAdapterConfig, env: nextEnv };

    const updated = await agents.update(agentId, {
      metadata: nextMetadata,
      adapterConfig: nextAdapterConfig,
    });
    if (!updated) throw notFound("Agent not found");

    await secrets.syncEnvBindingsForTarget?.(
      agent.companyId,
      { targetType: "agent", targetId: agent.id },
      nextEnv,
    );

    const view = await buildView({
      identity: next,
      adapterConfig: nextAdapterConfig,
      companyId: agent.companyId,
    });

    const changeKind = previousIdentity ? "updated" : "connected";
    logger.info(
      {
        ...redactActor(actor),
        agentId,
        companyId: agent.companyId,
        changeKind,
        tokenSecretBound: Boolean(next.tokenSecretId),
      },
      "agent github identity set",
    );

    return { view, changeKind };
  }

  async function clear(
    agentId: string,
    actor?: AgentGithubIdentityServiceActor,
  ): Promise<SetAgentGithubIdentityResult> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");

    const previousIdentity = readAgentGithubIdentity(agent.metadata ?? null);
    const previousAdapterConfig = asRecord(agent.adapterConfig) ?? {};
    const previousEnv = asRecord(previousAdapterConfig.env) ?? {};

    const nextMetadata = mergeAgentGithubIdentityIntoMetadata(
      asRecord(agent.metadata),
      null,
    );

    const nextEnv: Record<string, unknown> = { ...previousEnv };
    for (const key of GH_TOKEN_ENV_KEYS) {
      const current = nextEnv[key];
      if (isManagedGithubSecretRef(current)) delete nextEnv[key];
    }
    const nextAdapterConfig: Record<string, unknown> = { ...previousAdapterConfig, env: nextEnv };

    await agents.update(agentId, {
      metadata: nextMetadata,
      adapterConfig: nextAdapterConfig,
    });

    await secrets.syncEnvBindingsForTarget?.(
      agent.companyId,
      { targetType: "agent", targetId: agent.id },
      nextEnv,
    );

    const view = await buildView({
      identity: null,
      adapterConfig: nextAdapterConfig,
      companyId: agent.companyId,
    });

    logger.info(
      {
        ...redactActor(actor),
        agentId,
        companyId: agent.companyId,
        changeKind: previousIdentity ? "disconnected" : "noop",
      },
      "agent github identity cleared",
    );

    return { view, changeKind: previousIdentity ? "disconnected" : "noop" };
  }

  async function test(agentId: string): Promise<TestAgentGithubIdentityResult> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");

    const identity = readAgentGithubIdentity(agent.metadata ?? null);
    if (!identity?.tokenSecretId) {
      return { ok: false, status: "no_token", detail: "No GitHub token configured.", hostname: "github.com" };
    }
    let token: string;
    try {
      token = await secrets.resolveSecretValue(agent.companyId, identity.tokenSecretId, "latest", {
        consumerType: "agent",
        consumerId: agent.id,
        actorType: "agent",
        actorId: agent.id,
        configPath: "env.GH_TOKEN",
      });
    } catch (err) {
      return {
        ok: false,
        status: "no_token",
        detail: `Failed to resolve token secret: ${err instanceof Error ? err.message : String(err)}`,
        hostname: "github.com",
      };
    }
    if (!token) {
      return { ok: false, status: "no_token", detail: "Resolved token is empty.", hostname: "github.com" };
    }

    try {
      const { stdout, stderr } = await execFile(
        "gh",
        ["auth", "status", "--hostname", "github.com"],
        { env: { ...process.env, GH_TOKEN: token }, timeout: GH_AUTH_STATUS_TIMEOUT_MS },
      );
      return { ok: true, status: "authenticated", detail: (stdout || stderr).trim() || null, hostname: "github.com" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (reason.toLowerCase().includes("enoent")) {
        return {
          ok: false,
          status: "no_gh_binary",
          detail: "gh CLI is not installed in this Paperclip container.",
          hostname: "github.com",
        };
      }
      return { ok: false, status: "unauthenticated", detail: reason, hostname: "github.com" };
    }
  }

  return {
    read,
    set,
    clear,
    test,
  };
}

function isManagedGithubSecretRef(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "secret_ref" && typeof record.secretId === "string";
}

function redactActor(actor?: AgentGithubIdentityServiceActor): Record<string, unknown> {
  if (!actor) return {};
  return {
    actorUserId: actor.userId ?? null,
    actorAgentId: actor.agentId ?? null,
    actorRunId: actor.runId ?? null,
  };
}
