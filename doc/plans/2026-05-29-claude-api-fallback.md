# Claude API fallback when subscription session limit is hit

**Status:** Draft — pending approval
**Author:** Wallace Silva
**Created:** 2026-05-29
**Scope:** When the Claude subscription session limit fires (`claude_transient_upstream` with a session-limit reset time), automatically inject `ANTHROPIC_API_KEY` for that agent until the reset time passes, so the agent keeps working on metered API instead of sitting idle. After the reset, transparently revert to subscription mode.

**Related plan:** [`2026-05-25-adapter-fallback.md`](./2026-05-25-adapter-fallback.md) covers **cross-adapter** fallback (Claude → Codex/Cursor when the whole Claude adapter fails). This plan covers **within-Claude billing fallback** (subscription → API, same adapter). They are complementary and can both be enabled on the same agent: subscription → API (this plan) → Codex (the other plan) when even the API also fails.

---

## 1. Goals

- Agent stops sitting idle when the Claude Pro/Max subscription resets in 1-5 hours.
- Operator gets the cheapest billing available: subscription used first, API only as overflow.
- Zero manual intervention required after the initial setup (configure an API key secret once, then let Paperclip switch modes automatically).
- Audit trail so operators see when each agent is in fallback mode and how long it lasted.
- Per-agent opt-in: not every agent needs this (e.g. agents using Bedrock or already API-only).

## 2. Non-goals

- Other adapters (Codex, Cursor, Gemini) — the same pattern can extend later, but Claude is V1.
- Per-token cost optimization beyond mode switching (no choosing cheaper models).
- Anthropic-side outage handling beyond what `claude_transient_upstream` already covers — if both subscription AND API are rate-limited, we fail normally and surface the error to the operator.
- Detecting Claude weekly / hard quota limits that don't return a clear reset timestamp. Fallback only activates when we can parse a `retryNotBefore`.

## 3. User story

Wallace is using a Claude Pro subscription on a Paperclip agent (`Teste Process` adapter set to `claude_local`, no `ANTHROPIC_API_KEY` configured). Around 10:30 AM the agent hits:

```
Claude run failed: subtype=success: You've hit your session limit · resets 3:10pm (UTC) (claude_transient_upstream)
```

Without this feature: heartbeat schedules a retry at 3:10pm UTC; agent sits idle for ~4.5h.

With this feature:
- An ANTHROPIC_API_KEY secret is already configured on the agent (one-time setup) with the toggle "Fall back to Anthropic API when subscription limits hit" turned ON.
- The adapter detects the limit + reset time.
- Sets `agent.metadata.claudeFallback = { untilIso: "2026-05-29T15:10:00Z", reason: "session_limit", since: "2026-05-29T13:30:00Z" }`.
- Heartbeat re-queues the run immediately (not waiting for 3:10pm).
- Next run's `claude-local` adapter sees fallback is active → injects `ANTHROPIC_API_KEY` env from the configured secret → spawns `claude` in API mode → run succeeds.
- All subsequent runs use API mode until 3:10pm.
- After 3:10pm, the next adapter execute() sees `untilIso <= now()` → clears the metadata → runs in subscription mode again.
- UI shows a yellow "Using Anthropic API · subscription resets 3:10pm UTC" banner on the agent detail while fallback is active.

## 4. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│ Agent run (claude-local adapter)                                     │
│                                                                       │
│ buildClaudeRuntimeConfig()                                            │
│   ├─ reads agent.metadata.claudeFallback                              │
│   ├─ if fallback.untilIso > now() AND apiKeySecretRef is set:         │
│   │    resolve secret → set env.ANTHROPIC_API_KEY                     │
│   │    log: "claude.fallback_using_api"                               │
│   ├─ else:                                                            │
│   │    leave env unset → subscription mode                            │
│   │    if fallback.untilIso <= now(): clear metadata + log            │
│   └─ spawn claude CLI                                                 │
│                                                                       │
│ On result:                                                            │
│   ├─ if errorCode === "claude_transient_upstream"                     │
│   │    AND extractClaudeRetryNotBefore returned a session-limit time  │
│   │    AND we were in subscription mode (no ANTHROPIC_API_KEY)        │
│   │    AND fallback config is enabled on the agent:                   │
│   │       update agent.metadata.claudeFallback = { untilIso, reason } │
│   │       emit activity log: "claude.fallback_activated"              │
│   │       heartbeat re-queues without honoring retryNotBefore         │
│   └─ otherwise: normal result handling                                │
└─────────────────────────────────────────────────────────────────────┘
```

The flow uses the **existing** `extractClaudeRetryNotBefore` helper (already lives in claude-local) and the existing `claude_transient_upstream` error code. Nothing new in detection logic — we just react to it differently when fallback is enabled.

## 5. Data model

**No new tables.** Two pieces of state live in existing structures:

### 5.1 Agent configuration (input)

Lives in `agent.adapterConfig.claudeFallback` (new field, only meaningful for `claude_local` adapter type):

```ts
{
  claudeFallback?: {
    enabled: boolean;
    apiKeySecretRef: string;  // "${secret:anthropic-api-key}"
  }
}
```

- `enabled`: opt-in toggle. Default false.
- `apiKeySecretRef`: required when `enabled === true`. Must resolve to a valid Anthropic API key at runtime.

### 5.2 Agent runtime state (output of fallback activation)

Lives in `agent.metadata.claudeFallback`:

```ts
{
  claudeFallback?: {
    untilIso: string;         // ISO-8601 timestamp when fallback expires
    reason: "session_limit" | "rate_limit" | "other";
    activatedAt: string;      // ISO-8601 when fallback first activated
    triggerRunId: string;     // the run that caused the activation (for audit)
  }
}
```

Cleared automatically when:
- Next adapter execute() runs and `untilIso <= now()`, OR
- A run completes successfully in subscription mode after `untilIso` (defensive — should already be cleared by the first condition).

## 6. Backend changes

### 6.1 `packages/adapters/claude-local/src/server/execute.ts`

Two surgical changes:

**A) Apply fallback during runtime config build** (`buildClaudeRuntimeConfig`, ~line 137):

```ts
const fallback = readClaudeFallbackState(agent);
const fallbackConfig = readClaudeFallbackConfig(config);
const now = new Date();
let fallbackActive = false;

if (fallback && new Date(fallback.untilIso) > now && fallbackConfig?.enabled && fallbackConfig.apiKeySecretRef) {
  const apiKey = await resolveSecretRef(companyId, fallbackConfig.apiKeySecretRef);
  if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
    fallbackActive = true;
    await onLog("stdout", `[paperclip] Claude subscription limited until ${fallback.untilIso} — using Anthropic API key fallback for this run.\n`);
  }
}
```

**B) React to limit hit in the result handler** (~line 920, where `transientUpstream` is detected):

```ts
const transientUpstream = ...;
const billingMode = resolveClaudeBillingType(env);

if (transientUpstream && billingMode === "subscription") {
  const retryNotBefore = extractClaudeRetryNotBefore({ ... });
  if (retryNotBefore && fallbackConfig?.enabled) {
    // Signal back to heartbeat that fallback should activate.
    // We do NOT mutate agent.metadata here because the adapter doesn't
    // own the DB. Instead, return a structured signal in errorMeta.
    errorMeta.claudeFallbackActivation = {
      untilIso: retryNotBefore.toISOString(),
      reason: "session_limit",
      triggerRunId: runId,
    };
  }
}
```

### 6.2 `server/src/services/heartbeat.ts`

After a run completes, inspect `errorMeta.claudeFallbackActivation`:

```ts
if (run.errorMeta?.claudeFallbackActivation) {
  const activation = run.errorMeta.claudeFallbackActivation;
  await agentsSvc.update(agent.id, {
    metadata: {
      ...agent.metadata,
      claudeFallback: {
        untilIso: activation.untilIso,
        reason: activation.reason,
        activatedAt: new Date().toISOString(),
        triggerRunId: activation.triggerRunId,
      },
    },
  });
  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "system",
    actorId: "system:claude-fallback",
    agentId: agent.id,
    action: "claude.fallback_activated",
    entityType: "agent",
    entityId: agent.id,
    details: { untilIso: activation.untilIso, reason: activation.reason },
  });
  // Re-queue immediately instead of honoring retryNotBefore
  // (the next run will use the API key).
  queueImmediateWake(agent.id, "claude_fallback_activated");
}
```

When a normal run completes (no fallback activation) and `agent.metadata.claudeFallback?.untilIso <= now()`:

```ts
if (agent.metadata?.claudeFallback) {
  const untilDate = new Date(agent.metadata.claudeFallback.untilIso);
  if (untilDate <= new Date()) {
    await agentsSvc.update(agent.id, {
      metadata: { ...agent.metadata, claudeFallback: undefined },
    });
    await logActivity(db, {
      action: "claude.fallback_deactivated",
      // ...
    });
  }
}
```

### 6.3 Shared types

`packages/shared/src/types/agent.ts`:

```ts
export interface AgentClaudeFallbackConfig {
  enabled: boolean;
  apiKeySecretRef: string;
}

export interface AgentClaudeFallbackState {
  untilIso: string;
  reason: "session_limit" | "rate_limit" | "other";
  activatedAt: string;
  triggerRunId: string;
}

export interface AgentMetadata {
  // existing fields...
  claudeFallback?: AgentClaudeFallbackState;
}
```

### 6.4 Validators

`packages/shared/src/validators/agent.ts` — extend the agent's `adapterConfig` schema to accept the `claudeFallback` field (validation runs only when adapterType=`claude_local`).

## 7. Frontend changes

### 7.1 Agent configuration form (`ui/src/components/AgentConfigForm.tsx` or claude-specific config UI)

Add a section under Claude-specific config:

```
┌─ Subscription fallback ─────────────────────────────────────────┐
│ ☐ Fall back to Anthropic API when subscription limits hit        │
│   When ON, hitting a session limit (e.g. Claude Pro 5h cap)      │
│   switches this agent to metered API billing for the duration    │
│   of the cooldown — instead of sitting idle until reset.         │
│                                                                  │
│ API key secret  [ ${secret:anthropic-api-key}              ]    │
└─────────────────────────────────────────────────────────────────┘
```

Only visible for `claude_local` adapter.

### 7.2 Agent detail page

When `agent.metadata.claudeFallback` exists, show a status banner near the top:

```
┌────────────────────────────────────────────────────────────┐
│ ⚡ Subscription limited — using Anthropic API until 3:10 PM UTC │
│ Auto-revert in 4h 32m · activated by run 7f3a9b1c              │
└────────────────────────────────────────────────────────────┘
```

Color: warning/amber (not destructive — the agent is still working).

### 7.3 Activity log + cost dashboard

- Activity log entries `claude.fallback_activated` and `claude.fallback_deactivated` show up in the existing activity feed.
- Cost dashboard already breaks down per provider; no changes needed — API usage during fallback windows automatically attributes to "Anthropic API" line.

## 8. Phases & estimates

| Phase | Scope | Estimate | Independently shippable? |
|---|---|---|---|
| **P1** | Shared types + adapterConfig validator extension | 0.5d | ✅ (no behavioral change, just contract) |
| **P2** | Adapter detection: emit `errorMeta.claudeFallbackActivation` when limit hit + billing mode is subscription + config enabled | 0.5d | ✅ (no consumer yet, harmless extra field) |
| **P3** | Adapter runtime config: inject `ANTHROPIC_API_KEY` from secret when fallback state is active | 0.5d | ✅ (only fires if both P1 config + P5 state set) |
| **P4** | Heartbeat: consume `errorMeta.claudeFallbackActivation`, persist metadata, log activity, queue immediate retry | 1d | ✅ (e2e behavior works) |
| **P5** | Heartbeat: auto-clear expired metadata on next run + log deactivation | 0.5d | ✅ |
| **P6** | UI: toggle in agent config form + banner on agent detail when active | 1d | ✅ |
| **P7** | Tests: unit (detection, runtime injection) + integration (full activation → fallback → expiry → revert) | 1d | ✅ |

**Total: 5 dev days.** Phases independent — can pause between any and ship.

## 9. Testing strategy

### Unit
- `claude-local`: detection emits `claudeFallbackActivation` only when (transient_upstream + retryNotBefore + subscription mode + config enabled).
- `claude-local`: runtime config injects `ANTHROPIC_API_KEY` when state is active and not expired; does NOT inject when state expired (cleanup path).
- Heartbeat: persists metadata correctly on activation; clears it on next run after expiry; doesn't activate when config disabled.

### Integration (vitest with mocked process spawn)
- Full cycle: spawn → limit error → fallback activated → next spawn has API key env → simulated success.
- Expiry: advance clock past `untilIso` → next spawn omits API key env.
- Disabled config: limit error → no fallback, normal `retryNotBefore` honored as today.
- Missing API key secret: limit error → fallback state set but next run can't resolve secret → log warning, fall back to subscription mode (and probably fail again until reset).

### Manual smoke
- Configure agent with real Claude Pro session + an ANTHROPIC_API_KEY in a test workspace.
- Run agent until limit hits (or mock the limit response).
- Observe banner + activity log + successful subsequent runs on API.
- Wait past reset → confirm next run uses subscription again.

## 10. Edge cases & decisions

1. **API key invalid at fallback activation time.** The runtime config resolution fails → we log a warning and leave the env unset → agent runs in subscription mode → likely fails again. Operator sees error in activity log. **Acceptable** — opt-in feature, user is expected to have configured a working key.

2. **API key ALSO rate-limited.** Adapter detects → `errorMeta` records both — we DO NOT activate fallback when billing mode is already API (only when subscription). So the run fails normally with rate limit message and heartbeat schedules retry via existing `retryNotBefore`. No new behavior.

3. **Multiple concurrent runs hit limit simultaneously.** Last write wins on `metadata.claudeFallback`. No corruption — all share the same `untilIso`. Both runs re-queue and second one sees the metadata + uses API.

4. **Bedrock-authenticated agents.** `resolveClaudeBillingType` returns `metered_api` (not `subscription`), so fallback never activates. Correct — Bedrock has its own quota system.

5. **Operator turns off `enabled` while fallback is active.** Next run reads disabled → does NOT inject the API key → runs in subscription mode → likely fails until reset. Metadata stays around but is ignored. Cleared naturally on next successful subscription run after expiry.

6. **`retryNotBefore` parsing fails (Claude CLI changed message format).** No `untilIso` to persist → fallback not activated → falls back to existing behavior (wait for full reset time). Detect this in logs and patch the regex if Claude changes the format.

7. **Long downtime (Claude API down for hours).** Both subscription and API fail → agent eventually pauses on its own via existing retry-quota logic. Not our concern.

8. **Weekly limit (some Claude Pro tiers).** The reset timestamp Claude emits may be days out. We persist `untilIso` correctly; fallback runs on API for those days. Operator should monitor cost — same model as today, just for longer.

## 11. Open questions

1. **Should `apiKeySecretRef` reuse the company-wide secrets, or live in a separate "API keys" pool?** → Recommend: reuse `companySecrets` with `${secret:...}` references. Consistent with existing patterns.
2. **Should the UI offer a way to manually trigger or clear fallback?** → No for V1 — adds complexity. Operator can edit metadata via DB if truly needed.
3. **Should activated cost be capped?** → No for V1 — the operator's existing budget hard-stop on the agent will pause the agent if cost runs away. Reuse existing safety.

## 12. Files to create or change

**Modify:**
- `packages/adapters/claude-local/src/server/execute.ts` — read fallback state + inject env; signal activation in errorMeta
- `packages/shared/src/types/agent.ts` — add types
- `packages/shared/src/validators/agent.ts` — extend adapterConfig schema (or claude-specific schema)
- `server/src/services/heartbeat.ts` — consume `claudeFallbackActivation`, persist metadata, log activity, immediate re-queue, auto-clear on expiry
- `ui/src/components/AgentConfigForm.tsx` (or claude config UI) — toggle + secret picker
- `ui/src/pages/AgentDetail.tsx` — banner when fallback active

**New:**
- `packages/adapters/claude-local/src/server/__tests__/fallback.test.ts` — detection + runtime injection unit tests
- `server/src/__tests__/heartbeat-claude-fallback.test.ts` — full integration

## 13. Definition of done

- [ ] Operator can opt-in per agent via UI toggle
- [ ] When agent hits Claude session limit AND fallback is enabled AND secret is set, agent automatically switches to API mode within 1 heartbeat tick (no operator action)
- [ ] When the `untilIso` passes, agent reverts to subscription mode on the next run
- [ ] UI banner clearly shows when fallback is active
- [ ] Activity log entries surface activation + deactivation
- [ ] Operators with fallback disabled see unchanged behavior (today's retry-after-reset)
- [ ] All tests green; `pnpm build` clean
