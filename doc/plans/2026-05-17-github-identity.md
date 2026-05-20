# GitHub identity for agents — plan

**Status:** proposed · **Owner:** wallace.silva · **Date:** 2026-05-17

## Goal

Make "this agent acts as this GitHub user" a first-class concept, so a board
operator can configure clone / commit / push / PR / comment for an agent (or a
whole company) without manually `gh auth login`-ing inside the container or
hand-binding secret refs.

## TL;DR

What's wired today (and what isn't):

- ✅ `company_secrets` + `company_secret_versions` + `company_secret_bindings`
- ✅ `adapter_config.env.<KEY> = { type: "secret_ref", secretId }` resolves at
  runtime via `secrets.ts:633` (`normalizeEnvConfig`)
- ✅ Token redaction in logs (`adapter-utils/command-redaction.ts:9`)
- ✅ Instance Terminal for manual `gh auth login` (admin escape hatch)
- ❌ Git itself doesn't read `GH_TOKEN` → `git push` fails even with the env var set
- ❌ Workspace clone (`heartbeat.ts:705`) runs with `sanitizeRuntimeServiceBaseEnv`,
  which strips agent secrets → can't clone private repos
- ❌ No `git config user.email` / `user.name` set anywhere outside tests
- ❌ No first-class "GitHub identity" model on agent / company

End state: operator fills 4 fields on the agent (token, username, commit
email, commit name) and everything just works.

## Today's flow (the manual one that works)

```
1. Create a PAT in GitHub with: repo, read:org, workflow
2. POST /companies/:companyId/secrets
   { name: "github-pat-eng", key: "GH_TOKEN", value: "ghp_..." }
3. PUT /agents/:agentId
   adapterConfig.env = {
     GH_TOKEN:     { type: "secret_ref", secretId: <id> },
     GITHUB_TOKEN: { type: "secret_ref", secretId: <id> },
   }
4. SSH into the container OR open Instance Terminal:
   gh auth setup-git
   git config --global user.email "you@example.com"
   git config --global user.name  "Your Name"
```

Step 4 is the gap. It's also a footgun: step 4 sets **global** config inside
the container, so every agent sharing that container becomes the same git
author.

## What's broken vs. what just needs wiring

| Gap | Severity | Where to fix |
|---|---|---|
| Workspace clone strips secrets | Blocker for private repos | `heartbeat.ts:705` |
| `git push` ignores `GH_TOKEN` | Blocker for landing work | Run `gh auth setup-git` in workspace prep |
| Commit author wrong/empty | Audit/compliance | Run `git config user.email/name` in workspace prep |
| No per-agent identity model | UX / multi-tenant | `agents.metadata.github` + UI |
| No org-level default | Saves wiring N agents | `companies.metadata.defaultGithubIdentity` |
| No UI surface | Operators don't know the convention | Agent detail page section |

## Design

### Layer A — Workspace auto-config (MVP, no schema)

Add a `configureGitIdentity(cwd, env, identity)` helper, called from workspace
prep right after the clone / worktree creation succeeds:

```ts
// server/src/services/git-identity.ts (new)
export async function configureGitIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv,
  identity: { userEmail?: string; userName?: string } | null,
): Promise<void> {
  if (env.GH_TOKEN) {
    // idempotent — writes a credential.helper line for github.com
    await execFile("gh", ["auth", "setup-git"], { env, cwd }).catch(noop);
  }
  if (identity?.userEmail) {
    await execFile("git", ["config", "user.email", identity.userEmail], { cwd });
  }
  if (identity?.userName) {
    await execFile("git", ["config", "user.name", identity.userName], { cwd });
  }
}
```

Wire it at two call sites:

1. **Managed clone** (`heartbeat.ts:705`): stop using
   `sanitizeRuntimeServiceBaseEnv(process.env)` blindly. Replace with the
   resolved adapter env (which includes `GH_TOKEN` if bound). Right after
   clone succeeds, call `configureGitIdentity`.
2. **Worktree / execution workspace creation** (`workspace-runtime.ts` around
   the `runGit(["worktree", "add", ...])` paths): after the worktree exists,
   call `configureGitIdentity` against the worktree cwd.

Both call sites already have the agent context — they just need to ask the
secrets service for `agent.adapterConfig.env` resolved, and the agent record
for the future `metadata.github`. Until layer B ships, identity falls back to
two env conventions: `GIT_AUTHOR_EMAIL` / `GIT_AUTHOR_NAME` (so an operator
can already set them as plain env entries today).

**This alone unblocks the typical flow.** Layer B is polish.

### Layer B — Agent.metadata.github (typed identity)

Schema addition (no migration needed if we stay inside the existing `metadata`
jsonb; opt for a typed sub-shape):

```ts
// packages/shared/src/agent-metadata.ts
export interface AgentGithubIdentity {
  username?: string;          // display only (e.g. "paperclip-bot-eng")
  userEmail?: string;         // → git config user.email
  userName?: string;          // → git config user.name
  tokenSecretId?: string;     // → resolved into env.GH_TOKEN at runtime
  signingKeySecretId?: string; // optional, future — commit signing
}
```

Resolution rule, in priority order, evaluated per run:

1. `agent.metadata.github.tokenSecretId` → `env.GH_TOKEN`, `env.GITHUB_TOKEN`
2. `agent.adapterConfig.env.GH_TOKEN` (explicit override, existing path)
3. `company.metadata.defaultGithubIdentity.tokenSecretId` (Layer C)

Same fallback chain for `userEmail` / `userName`.

REST surface (additive):

- `GET /agents/:id` returns `githubIdentity` (resolved + redacted)
- `PUT /agents/:id { githubIdentity: { tokenSecretId, userEmail, userName, username } }`
  — service writes `adapter_config.env.GH_TOKEN` as a secret_ref AND mirrors to
  `metadata.github`, keeping the two views consistent. Operators see one
  concept; the runtime keeps using the secret_ref it already understands.

UI: a "GitHub identity" card on the agent detail page (see UX section below).

### UX (implicit presence model)

**Decision:** an agent uses GitHub iff `metadata.github` exists. No separate
"enabled" boolean — the presence of the object IS the flag. Avoids the
"toggle off + data filled" ambiguity and keeps a single source of truth.

#### Agent detail — Integrations section

Empty state (no `metadata.github`):

```
┌─ Integrations ─────────────────────────────────┐
│  ⭕ GitHub                                     │
│  Not configured                                │
│  This agent won't clone, push or open PRs.     │
│                       [ Connect GitHub → ]     │
└────────────────────────────────────────────────┘
```

Connected state (`metadata.github` set):

```
┌─ Integrations ─────────────────────────────────┐
│  ✅ GitHub                                     │
│  @paperclip-bot-eng · eng@paperclip.local      │
│  Token: github-pat-eng (last used 2h ago)      │
│             [ Test ] [ Edit ] [ Disconnect ]   │
└────────────────────────────────────────────────┘
```

- **Connect** opens a sheet with the 4 fields (`username`, `userEmail`,
  `userName`, `tokenSecretId` via a dropdown of company secrets) + a
  **Test access** button that runs `gh auth status --hostname github.com`
  through the existing test-environment path.
- **Edit** reopens the same sheet, prefilled.
- **Disconnect** asks for confirmation and clears `metadata.github` →
  back to empty state. No data is retained.

#### Agent list — discoverability signal

In the agents grid, render a small GitHub mark next to the name when
`metadata.github` is set. Hover shows `@username`. Add a filter chip
"Has GitHub" to the sidebar.

```
🟢 Alice    engineer  ⌥  Reports to: CTO
🟢 Bob      engineer  ⌥  Reports to: CTO
🟢 Carol    qa            Reports to: CTO          ← no badge
                          ↑ "⌥" = GitHub configured
```

#### Inheritance display (with Layer C)

When the agent inherits the company default:

```
┌─ Integrations ─────────────────────────────────┐
│  ↳ GitHub (inherited from company)             │
│  @paperclip-bot-default                        │
│                            [ Override → ]      │
└────────────────────────────────────────────────┘
```

**Override** creates a per-agent `metadata.github`. Removing the override
deletes the agent's `metadata.github` and the card falls back to the
inherited state.

#### Activity-log surfaces

Three new event kinds, all carrying actor + agentId + a redacted snapshot:

- `agent.github.connected` — first time `metadata.github` becomes non-null
- `agent.github.updated`   — fields changed on an already-connected agent
- `agent.github.disconnected` — `metadata.github` cleared

Token secret IDs are logged, raw values never are (redaction already in
place via `command-redaction.ts:9`).

#### Why not a toggle / checkbox

A "Use GitHub: [ON/OFF]" switch creates an ambiguous state — toggle off
with fields still filled. The implicit-presence model keeps one source of
truth; the **Disconnect** action gives the same power as a kill-switch
without the intermediate state.

### Layer C — Company default

```ts
// company.metadata.defaultGithubIdentity: AgentGithubIdentity
```

Same shape. UI on the company settings page. Agents without their own
identity inherit it. Solves "I have 12 agents and want them all on the same
bot account" without binding 12 secrets.

### Layer D — Optional follow-ups (not in scope of MVP)

- Commit signing via SSH key in `signingKeySecretId` + `git config gpg.format ssh`.
- GitHub App installation tokens (short-lived, rotatable) instead of long-lived
  PATs. Requires a new secret provider in `company_secret_provider_configs`.
- Per-repo identity (different identity for different remote URLs) via
  `git config --conditional`. Probably overkill until someone asks.

## Why not just rely on the GitHub MCP server?

MCP covers the **API** (PR / issue / comments / search) but not the **git
protocol** — `git push`, `git clone --depth 1 https://github.com/private/...`,
`git fetch`. Those go through git's transport, which only understands credential
helpers and SSH agents. The MCP server is a great companion to this work but
doesn't replace it.

## Sequencing

| # | Step | Effort | Unblocks |
|---|---|---|---|
| 1 | Layer A: `configureGitIdentity` + wire into clone & worktree paths | ~2h | Push/clone work end-to-end with operator-set env vars |
| 2 | Fix `heartbeat.ts:705` so adapter env reaches `git clone` | ~30min | Private repo clones |
| 3 | Layer B: `agent.metadata.github` + REST + UI card | ~half day | Operator UX, audit trail |
| 4 | Layer C: company default inheritance | ~2h | Scale to many agents |
| 5 | Docs in `docs/guides/board-operator/github-identity.md` | ~1h | Operators discover the feature |

MVP = steps 1 + 2 + a one-paragraph doc. Ship those first, then iterate.

## Verification plan

- Unit: `git-identity.test.ts` covers each branch (token present/absent,
  identity present/absent, idempotency on rerun).
- Integration (server): spin a managed checkout against a fake git remote,
  bind a fake `GH_TOKEN`, assert `git config --get user.email` matches and
  `git remote -v` push URL is reachable via the credential helper.
- E2E (manual smoke): real PAT against `wallacehenriquesilva/paperclip-test`
  (private), confirm clone + commit + push + `gh pr create` all work from a
  fresh container with no manual `gh auth login`.

## Invariants & risk

- **No credential leakage.** `configureGitIdentity` must use `cwd` config, never
  `--global`, so two agents sharing a container don't cross-contaminate identity.
- **Token redaction.** Already covered by `command-redaction.ts:9`; add a
  matching test once Layer A lands so a `gh auth setup-git` invocation can't
  leak the token through stderr.
- **Audit.** Changes to `metadata.github` and to bound secrets already log
  through the activity log (mutation-with-actor pattern). Verify the new PUT
  endpoint inherits that.
- **Backward compat.** Existing agents with hand-bound `env.GH_TOKEN` keep
  working unchanged — Layer B's resolution rule explicitly falls through to
  `adapterConfig.env`.

## References

- `packages/db/src/schema/company_secrets.ts`
- `packages/db/src/schema/company_secret_bindings.ts` — `target_type` + `target_id` + `config_path`
- `server/src/services/secrets.ts:169` — `secret_ref` type
- `server/src/services/secrets.ts:581` — `normalizeEnvConfig`
- `server/src/services/secrets.ts:633` — env resolution in adapter config
- `server/src/services/secrets.ts:2150` — `resolveAdapterConfigForRuntime`
- `server/src/services/heartbeat.ts:705` — managed checkout clone
- `server/src/services/workspace-runtime.ts:515` — `runGit` helper, the natural
  spot to add `configureGitIdentity` after worktree creation
- `packages/adapter-utils/src/command-redaction.ts:9` — PAT redaction regex
- Existing manual workaround surface: Instance Terminal (`InstanceTerminal.tsx`),
  Instance AI Auth (`InstanceAIAuth.tsx`)
