import { and, eq, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySecretBindings, companySecrets } from "@paperclipai/db";
import type {
  AgentClaudeFallbackConfig,
  AgentClaudeFallbackReason,
  AgentClaudeFallbackState,
} from "@paperclipai/shared";
import { parseSecretReference } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { secretService } from "./secrets.js";

type SecretService = ReturnType<typeof secretService>;

/**
 * Reads the runtime fallback state off agent.metadata. Returns null when no
 * fallback is active or when `untilIso` has already passed (the caller is
 * expected to also clear the metadata in the latter case).
 */
export function readActiveClaudeFallbackState(
  agent: { metadata: Record<string, unknown> | null | undefined },
  now: Date = new Date(),
): AgentClaudeFallbackState | null {
  const raw = agent.metadata?.claudeFallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const untilIso = typeof record.untilIso === "string" ? record.untilIso : null;
  if (!untilIso) return null;
  const until = new Date(untilIso);
  if (!Number.isFinite(until.getTime()) || until.getTime() <= now.getTime()) return null;
  return {
    untilIso,
    reason: (typeof record.reason === "string" ? record.reason : "session_limit") as AgentClaudeFallbackState["reason"],
    activatedAt: typeof record.activatedAt === "string" ? record.activatedAt : untilIso,
    triggerRunId: typeof record.triggerRunId === "string" ? record.triggerRunId : null,
  };
}

/**
 * Reads the operator-configured fallback policy off agent.adapterConfig.
 * Only meaningful when adapterType === "claude_local".
 */
export function readClaudeFallbackAdapterConfig(
  adapterConfig: Record<string, unknown> | null | undefined,
): AgentClaudeFallbackConfig | null {
  if (!adapterConfig) return null;
  const raw = adapterConfig.claudeFallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    apiKeySecretRef: typeof record.apiKeySecretRef === "string" ? record.apiKeySecretRef : undefined,
  };
}

/**
 * When the agent has an active fallback state AND has a configured
 * apiKeySecretRef, resolves the secret and returns the API key the heartbeat
 * should inject as `ANTHROPIC_API_KEY` in the run's runtime config.
 *
 * Returns null when fallback isn't active, isn't configured, or the secret
 * couldn't be resolved (logged as a warning; not a hard failure — the agent
 * will just run in subscription mode and likely hit the limit again, which
 * is the same outcome it would have had without this feature enabled).
 */
export async function resolveClaudeFallbackEnvInjection(args: {
  agent: {
    id: string;
    companyId: string;
    adapterType: string;
    adapterConfig: Record<string, unknown> | null | undefined;
    metadata: Record<string, unknown> | null | undefined;
  };
  secretsSvc: SecretService;
  db?: Db;
  now?: Date;
}): Promise<{ apiKey: string; state: AgentClaudeFallbackState } | null> {
  if (args.agent.adapterType !== "claude_local") return null;
  const state = readActiveClaudeFallbackState(args.agent, args.now);
  if (!state) return null;
  const config = readClaudeFallbackAdapterConfig(args.agent.adapterConfig);
  if (!config?.enabled || !config.apiKeySecretRef) {
    logger.warn(
      { agentId: args.agent.id, untilIso: state.untilIso },
      "Claude fallback state is active but adapterConfig.claudeFallback is missing/disabled — skipping API key injection",
    );
    return null;
  }
  const secretKey = parseSecretReference(config.apiKeySecretRef);
  if (!secretKey) {
    logger.warn(
      { agentId: args.agent.id, apiKeySecretRef: config.apiKeySecretRef },
      "Claude fallback apiKeySecretRef is not a valid ${secret:...} reference — skipping",
    );
    return null;
  }
  const db = args.db;
  if (!db) {
    logger.warn(
      { agentId: args.agent.id },
      "Claude fallback resolution requires a db handle (caller forgot to pass it)",
    );
    return null;
  }
  const secretRow = await db
    .select({ id: companySecrets.id, status: companySecrets.status })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, args.agent.companyId), eq(companySecrets.key, secretKey)))
    .then((rows) => rows[0] ?? null);
  if (!secretRow || secretRow.status === "deleted") {
    logger.warn(
      { agentId: args.agent.id, secretKey },
      "Claude fallback secret not found — falling back to subscription mode (which will likely fail again)",
    );
    return null;
  }
  try {
    // Self-healing: ensure the binding exists before resolution. Normally the
    // route handler (PATCH /agents/:id) syncs this when the operator saves
    // claudeFallback config, but agents created before that codepath shipped
    // — or agents whose save flow didn't trigger the sync — would otherwise
    // hit a permanent "Secret is not bound" error. Since the operator
    // explicitly authorized this secret ref via adapterConfig, recreating
    // the binding here is safe.
    await ensureClaudeFallbackBinding({
      db,
      companyId: args.agent.companyId,
      agentId: args.agent.id,
      secretId: secretRow.id,
    });
    const apiKey = await args.secretsSvc.resolveSecretValue(args.agent.companyId, secretRow.id, "latest", {
      consumerType: "agent",
      consumerId: args.agent.id,
      // configPath MUST match the path the route uses when syncing the
      // binding on agent update (server/src/routes/agents.ts after the
      // env/headers sync). See assertBindingContext in secrets.ts.
      configPath: "claudeFallback.apiKeySecretRef",
    });
    return { apiKey, state };
  } catch (err) {
    logger.warn(
      { err, agentId: args.agent.id, secretKey },
      "Claude fallback secret resolution failed — running in subscription mode",
    );
    return null;
  }
}

interface AdapterResultLike {
  errorMeta?: Record<string, unknown> | undefined;
}

type WakeupSource = "on_demand" | "timer" | "assignment" | "automation";
type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";

interface PostRunActions {
  enqueueWakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      reason?: string;
      triggerDetail?: WakeupTriggerDetail;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

/**
 * Run after the adapter finishes. Handles two transitions:
 *
 *   - Activation: adapter detected the Claude subscription session limit and
 *     emitted `errorMeta.claudeFallbackActivation` → persist
 *     `agent.metadata.claudeFallback`, log activity, and enqueue an immediate
 *     wakeup so the agent retries with ANTHROPIC_API_KEY instead of sitting
 *     idle until reset.
 *
 *   - Deactivation: the run completed (success or fail) while
 *     `agent.metadata.claudeFallback.untilIso` is already in the past →
 *     clear the metadata and log deactivation. The next run reverts to
 *     subscription billing naturally.
 */
export interface ClaudeFallbackPostRunResult {
  /**
   * True when the adapter signaled fallback activation AND we successfully
   * persisted metadata + queued an immediate wakeup. Callers should SKIP any
   * downstream `retryNotBefore`-honoring retry scheduling — the agent is now
   * running on the API key and the existing bounded retry would just stall
   * the next run until the subscription reset time.
   */
  fallbackActivated: boolean;
  /** True when we cleared a previously-stored fallback state that had expired. */
  fallbackDeactivated: boolean;
}

export async function applyClaudeFallbackPostRun(args: {
  db: Db;
  agent: {
    id: string;
    companyId: string;
    adapterType: string;
    metadata: Record<string, unknown> | null | undefined;
  };
  adapterResult: AdapterResultLike;
  triggerRunId: string;
  actions: PostRunActions;
  now?: Date;
}): Promise<ClaudeFallbackPostRunResult> {
  if (args.agent.adapterType !== "claude_local") {
    return { fallbackActivated: false, fallbackDeactivated: false };
  }
  const now = args.now ?? new Date();

  const activation = readActivationSignal(args.adapterResult.errorMeta);

  if (activation) {
    const state: AgentClaudeFallbackState = {
      untilIso: activation.untilIso,
      reason: activation.reason,
      activatedAt: now.toISOString(),
      triggerRunId: activation.triggerRunId ?? args.triggerRunId,
    };
    const currentMetadata =
      typeof args.agent.metadata === "object" && args.agent.metadata !== null
        ? (args.agent.metadata as Record<string, unknown>)
        : {};
    await args.db
      .update(agents)
      .set({
        metadata: { ...currentMetadata, claudeFallback: state },
        updatedAt: now,
      })
      .where(eq(agents.id, args.agent.id));
    logger.info(
      {
        agentId: args.agent.id,
        untilIso: state.untilIso,
        reason: state.reason,
        triggerRunId: state.triggerRunId,
      },
      "Claude subscription fallback ACTIVATED — persisting metadata and queueing immediate wakeup",
    );
    await logActivity(args.db, {
      companyId: args.agent.companyId,
      actorType: "user",
      actorId: "system:claude-fallback",
      agentId: args.agent.id,
      action: "claude.fallback_activated",
      entityType: "agent",
      entityId: args.agent.id,
      details: {
        untilIso: state.untilIso,
        reason: state.reason,
        triggerRunId: state.triggerRunId,
      },
    });
    try {
      await args.actions.enqueueWakeup(args.agent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "claude_fallback_activated",
        contextSnapshot: {
          source: "claude.fallback_activated",
          fallbackUntilIso: state.untilIso,
        },
      });
    } catch (err) {
      logger.warn(
        { err, agentId: args.agent.id },
        "Failed to enqueue immediate wakeup after Claude fallback activation — the agent will retry on its next scheduled heartbeat",
      );
    }
    return { fallbackActivated: true, fallbackDeactivated: false };
  }

  // No activation signal: see if a previously-active fallback has expired and
  // can be cleared.
  const existing = readStoredFallbackState(args.agent.metadata);
  if (!existing) {
    return { fallbackActivated: false, fallbackDeactivated: false };
  }
  const expiry = new Date(existing.untilIso);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() > now.getTime()) {
    return { fallbackActivated: false, fallbackDeactivated: false };
  }

  const currentMetadata =
    typeof args.agent.metadata === "object" && args.agent.metadata !== null
      ? (args.agent.metadata as Record<string, unknown>)
      : {};
  const { claudeFallback: _claudeFallback, ...rest } = currentMetadata;
  await args.db
    .update(agents)
    .set({
      metadata: Object.keys(rest).length > 0 ? rest : null,
      updatedAt: now,
    })
    .where(eq(agents.id, args.agent.id));
  await logActivity(args.db, {
    companyId: args.agent.companyId,
    actorType: "user",
    actorId: "system:claude-fallback",
    agentId: args.agent.id,
    action: "claude.fallback_deactivated",
    entityType: "agent",
    entityId: args.agent.id,
    details: {
      untilIso: existing.untilIso,
      activatedAt: existing.activatedAt,
      triggerRunId: existing.triggerRunId,
    },
  });
  return { fallbackActivated: false, fallbackDeactivated: true };
}

function readActivationSignal(
  errorMeta: Record<string, unknown> | undefined,
): { untilIso: string; reason: AgentClaudeFallbackReason; triggerRunId: string | null } | null {
  if (!errorMeta) return null;
  const raw = errorMeta.claudeFallbackActivation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const untilIso = typeof record.untilIso === "string" ? record.untilIso : null;
  if (!untilIso) return null;
  const reasonRaw = typeof record.reason === "string" ? record.reason : "session_limit";
  const reason: AgentClaudeFallbackReason =
    reasonRaw === "rate_limit" || reasonRaw === "other" || reasonRaw === "session_limit"
      ? reasonRaw
      : "session_limit";
  return {
    untilIso,
    reason,
    triggerRunId: typeof record.triggerRunId === "string" ? record.triggerRunId : null,
  };
}

function readStoredFallbackState(
  metadata: Record<string, unknown> | null | undefined,
): AgentClaudeFallbackState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).claudeFallback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const untilIso = typeof record.untilIso === "string" ? record.untilIso : null;
  if (!untilIso) return null;
  return {
    untilIso,
    reason: (typeof record.reason === "string" ? record.reason : "session_limit") as AgentClaudeFallbackState["reason"],
    activatedAt: typeof record.activatedAt === "string" ? record.activatedAt : untilIso,
    triggerRunId: typeof record.triggerRunId === "string" ? record.triggerRunId : null,
  };
}

/**
 * Idempotently ensures a companySecretBindings row exists for the agent +
 * claudeFallback.apiKeySecretRef config path. Safe to call repeatedly — uses
 * a check-then-insert pattern with conflict tolerance.
 */
async function ensureClaudeFallbackBinding(args: {
  db: Db;
  companyId: string;
  agentId: string;
  secretId: string;
}): Promise<void> {
  const configPath = "claudeFallback.apiKeySecretRef";
  const existing = await args.db
    .select({ id: companySecretBindings.id })
    .from(companySecretBindings)
    .where(
      and(
        eq(companySecretBindings.companyId, args.companyId),
        eq(companySecretBindings.secretId, args.secretId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, args.agentId),
        eq(companySecretBindings.configPath, configPath),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (existing) return;

  // Clear any stale bindings under claudeFallback.* that point at a different
  // secret (operator changed the ref) before inserting the new one.
  await args.db.transaction(async (tx) => {
    await tx
      .delete(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, args.companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, args.agentId),
          like(companySecretBindings.configPath, "claudeFallback.%"),
        ),
      );
    await tx.insert(companySecretBindings).values({
      companyId: args.companyId,
      secretId: args.secretId,
      targetType: "agent",
      targetId: args.agentId,
      configPath,
      versionSelector: "latest",
      required: true,
    });
  });
  logger.info(
    { agentId: args.agentId, secretId: args.secretId, configPath },
    "Claude fallback: auto-created secret binding on-demand",
  );
}
