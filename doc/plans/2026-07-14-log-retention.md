# Log retention in Instance Settings

**Date:** 2026-07-14
**Status:** Proposed
**Author:** Wallace (with Claude)

## Problem

Paperclip's process log (`<instance>/logs/server.log`, written by pino) and the
per-run transcripts (`<instance>/data/run-logs/**/*.ndjson`) have **no retention
or rotation** anywhere in the code. In a real deployment `server.log` grew to
**73 GB in ~5 days** (~15 GB/day), filling the data volume.

The only retention control in Instance Settings today is `backupRetention`, and
it applies **exclusively to database backup files** (`runDatabaseBackup`'s
prune step) — not to logs. In this deployment DB backups are also disabled
(`PAPERCLIP_DB_BACKUP_ENABLED=false`), so that knob is inert.

## Goal

Add a **`logRetention`** policy to Instance Settings → General, configurable
from the board UI, enforced by a background prune job — mirroring the existing
`backupRetention` pattern end to end. Cover both log kinds with the right
strategy for each:

| Log | Shape | Strategy |
|---|---|---|
| `server.log` | one append-only file, held open by pino | **size cap** → `fs.truncate(path, 0)` when it exceeds the limit |
| run-logs `*.ndjson` | many per-run files | **age cap** → delete files older than N days |

### Critical correctness constraint

`server.log` is held open by the running process. It MUST be reclaimed with
**`fs.truncate` (or `truncate -s 0`), never `unlink`/`rm`**: on Linux, deleting
a file with an open fd does not free the space (the inode stays alive behind the
process) and hides the log until restart. pino writes with `O_APPEND`, so after
truncation the next write lands at offset 0 — no sparse file. This is the whole
point of the feature and the primary thing tests must lock in.

## Non-goals

- Log-level tuning (pino is at `level: "debug"`; lowering it in prod is a
  separate change — see Follow-ups).
- Rotating/compressing archives (we truncate, not rotate). If archival is later
  wanted, that is an extension.
- Investigating *why* `server.log` grows 15 GB/day (separate task).

## Design

Follow the `backupRetention` shape exactly: fixed presets, a policy object on
`InstanceGeneralSettings`, read from the DB on each prune tick so UI changes
apply **without a restart** (same as backups read retention live at run time).

### Config shape (shared)

```ts
// packages/shared/src/types/instance.ts
export const SERVER_LOG_MAX_SIZE_MB_PRESETS = [256, 512, 1024, 2048] as const;
export const RUN_LOG_MAX_AGE_DAYS_PRESETS   = [7, 14, 30, 0]        as const; // 0 = keep forever

export interface LogRetentionPolicy {
  serverLogMaxSizeMb: (typeof SERVER_LOG_MAX_SIZE_MB_PRESETS)[number];
  runLogMaxAgeDays:   (typeof RUN_LOG_MAX_AGE_DAYS_PRESETS)[number];
}

export const DEFAULT_LOG_RETENTION: LogRetentionPolicy = {
  serverLogMaxSizeMb: 512,
  runLogMaxAgeDays: 14,
};
```

`logRetention` is added to `InstanceGeneralSettings` alongside `backupRetention`.

**No DB migration.** `instance_settings.general` is a JSON column; adding a field
is backward-compatible — `normalizeGeneralSettings` supplies the default for rows
written before this change (identical to how `backupRetention` was introduced).

## Changes by layer (db → shared → server → ui)

### 1. `packages/shared`
- `src/types/instance.ts`: add the two preset arrays, `LogRetentionPolicy`,
  `DEFAULT_LOG_RETENTION`; add `logRetention: LogRetentionPolicy` to
  `InstanceGeneralSettings`.
- `src/validators/instance.ts`: add `logRetentionPolicySchema` (reusing the
  existing `presetSchema` helper) and add `logRetention:
  logRetentionPolicySchema.default(DEFAULT_LOG_RETENTION)` to
  `instanceGeneralSettingsSchema` (still `.strict()`; `patch` inherits via
  `.partial()`).
- `src/index.ts` + `src/types/index.ts`: export the new symbols.

### 2. `server/src/services/instance-settings.ts`
- `normalizeGeneralSettings`: add `logRetention: parsed.data.logRetention ??
  DEFAULT_LOG_RETENTION` in **both** the success and fallback branches (mirrors
  `backupRetention`). No other service changes — `updateGeneral` already merges
  arbitrary general fields.

### 3. `server/src/services/log-retention.ts` (new)
A pure, testable service:

```ts
export interface LogPruneResult {
  serverLog: { path: string; existed: boolean; truncated: boolean; reclaimedBytes: number };
  runLogs:   { basePath: string; scanned: number; deleted: number; reclaimedBytes: number };
}

export function logRetentionService(deps?: { activeRunIds?: () => Promise<Set<string>> }) {
  return { pruneLogs: async (policy: LogRetentionPolicy): Promise<LogPruneResult> => { ... } };
}
```

- **server.log path** resolved with the **same precedence as `middleware/logger.ts`**
  (`PAPERCLIP_LOG_DIR` → config-file `logging.logDir` → `resolveDefaultLogsDir()`),
  then `/server.log`. Reusing the resolver is mandatory — truncating the wrong
  path would be a silent no-op.
- **server.log rule:** `stat`; if `size > serverLogMaxSizeMb * 1024 * 1024` →
  `fs.truncate(path, 0)`; record `reclaimedBytes`. (Truncate, never unlink.)
- **run-logs base** resolved as `RUN_LOG_BASE_PATH ?? <instanceRoot>/data/run-logs`
  (same as `run-log-store.ts`).
- **run-logs rule:** when `runLogMaxAgeDays > 0`, walk `*.ndjson`, delete those
  with `mtime` older than the cutoff. Active runs are naturally protected (they
  are being appended to → recent mtime). Optional hardening: cross-check against
  `activeRunIds` (queried from `heartbeat_runs`) and skip any active run's file
  regardless of mtime. `runLogMaxAgeDays === 0` → skip run-log pruning entirely.
- Returns structured counts; logs a summary line via pino.

### 4. `server/src/config.ts`
Add prune scheduler knobs (mirror `databaseBackup*`):
- `logPruneEnabled` (env `PAPERCLIP_LOG_PRUNE_ENABLED`, default `true`)
- `logPruneIntervalMinutes` (env `PAPERCLIP_LOG_PRUNE_INTERVAL_MINUTES`, default `15`)

15 min matters: at ~15 GB/day, a daily cadence would let `server.log` blow past
the cap between runs. A short interval keeps the cap meaningful.

### 5. `server/src/index.ts`
- Instantiate `logRetentionService`.
- If `config.logPruneEnabled`, add a `setInterval` (period
  `logPruneIntervalMinutes`) that reads `instanceSettingsService.getGeneral()`
  each tick (→ `logRetention`) and calls `pruneLogs(policy)`, logging reclaimed
  bytes when > 0. Same live-from-DB approach as the backup scheduler at
  `index.ts:794-808`.
- Run one prune on startup (best-effort, non-blocking) so a full disk is
  relieved immediately on boot.
- Include `logPrune` state in the startup banner (optional, mirrors
  `databaseBackup*`).

### 6. `server/src/routes/instance-settings.ts` (optional but recommended)
- `POST /instance/settings/logs/prune` → runs `pruneLogs` now, returns
  `LogPruneResult`; behind `assertCanManageInstanceSettings`; writes an activity
  log entry (`instance.logs.pruned`). Mirrors the manual DB-backup endpoint and
  lets the UI offer a "Prune now" button with live reclaimed-bytes feedback.

### 7. `ui/src/pages/InstanceGeneralSettings.tsx`
- Add a **"Log retention"** section beside "Backup retention", reusing the same
  preset-button styling:
  - "Server log size cap" → `SERVER_LOG_MAX_SIZE_MB_PRESETS`
  - "Run-log max age" → `RUN_LOG_MAX_AGE_DAYS_PRESETS` (render `0` as "Keep
    forever")
  - each button → `updateGeneralMutation.mutate({ logRetention: { ...current, <field> } })`
- Optional: show current `server.log` size and a "Prune now" button hitting the
  route from step 6.
- `ui/src/api/instance-settings.ts`: add `pruneLogs` if step 6 is included.

## Tests

- **shared** (`packages/shared`): `logRetentionPolicySchema` accepts presets,
  rejects off-preset values, applies defaults; `instanceGeneralSettingsSchema`
  round-trips `logRetention` and stays `.strict()`.
- **instance-settings service**: `getGeneral` returns `DEFAULT_LOG_RETENTION`
  for a legacy row without the field; `updateGeneral({ logRetention })`
  persists and merges without dropping `backupRetention`.
- **log-retention service** (temp dirs, the core):
  1. `server.log` over cap → truncated to size 0, **same inode preserved**
     (assert file still exists with size 0 — proves truncate, not unlink),
     `reclaimedBytes` correct.
  2. `server.log` under cap → untouched.
  3. run-logs: files with old mtime deleted, recent ones kept; `reclaimedBytes`
     and counts correct.
  4. `runLogMaxAgeDays === 0` → no run-log deletion.
  5. (if hardening added) active-run file skipped despite old mtime.
- **route** (if included): `POST .../logs/prune` requires manage permission,
  returns the result, writes the activity log entry.

## Verification

```sh
pnpm --filter @paperclipai/shared --filter @paperclipai/db --filter @paperclipai/server --filter @paperclipai/ui typecheck
pnpm test:run
```
Manual: set a low `serverLogMaxSizeMb`, grow `server.log` past it, confirm the
scheduler truncates it (size drops, process keeps logging), and the UI reflects
the setting.

## Risks / edge cases

- **Truncate vs unlink** — the one correctness invariant; locked by test #1.
- **Path mismatch** — must reuse `logger.ts`'s resolver precedence or it silently
  truncates nothing.
- **Active long-running run with no output** could be age-deleted mid-run
  (mtime old). Mitigation: the optional `activeRunIds` cross-check. Document the
  caveat if we ship without it.
- **O_APPEND / sparse file** — pino appends, so post-truncate writes go to
  offset 0; no sparse file. Safe, but note it.
- **Interval cost** — prune is a `stat` + a directory walk every 15 min; cheap.

## Rollout

- **Standalone PR from `master`** — this touches instance-settings, a new
  service, config, and the settings UI. It does **not** touch the migration chain
  and is independent of the `feat/company-quiet-hours` stack, so it can be its
  own clean branch/PR to the fork (`base: master`).
- Until this ships, keep the interim **logrotate** stopgap on the instance
  (`copytruncate`, hourly, `maxsize 2G`) so the disk is protected in the
  meantime.

## Follow-ups (separate)

- Lower pino log level in production (`info` instead of `debug`) — likely the
  real driver of the 15 GB/day volume.
- Investigate the log content for an error loop
  (`tail -n 100000 server.log | sed -E 's/[0-9]+//g' | sort | uniq -c | sort -rn`).
- Consider the same retention hook for the `logs/` rotated archives if logrotate
  is later removed in favor of in-app rotation.
