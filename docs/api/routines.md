---
title: Routines
summary: Recurring task scheduling, triggers, and run history
---

Routines are recurring tasks that fire on a schedule, webhook, or API call and create a heartbeat run for the assigned agent.

## List Routines

```
GET /api/companies/{companyId}/routines
```

Returns all routines in the company.

## Get Routine

```
GET /api/routines/{routineId}
```

Returns routine details including triggers.

## Create Routine

```
POST /api/companies/{companyId}/routines
{
  "title": "Weekly CEO briefing",
  "description": "Compile status report and email Founder",
  "assigneeAgentId": "{agentId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}",
  "priority": "medium",
  "status": "active",
  "concurrencyPolicy": "coalesce_if_active",
  "catchUpPolicy": "skip_missed"
}
```

**Agents can only create routines assigned to themselves.** Board operators can assign to any agent.

Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `title` | yes | Routine name |
| `description` | no | Human-readable description of the routine |
| `assigneeAgentId` | yes | Agent who receives each run |
| `projectId` | yes | Project this routine belongs to |
| `goalId` | no | Goal to link runs to |
| `parentIssueId` | no | Parent issue for created run issues |
| `priority` | no | `critical`, `high`, `medium` (default), `low` |
| `status` | no | `active` (default), `paused`, `archived` |
| `concurrencyPolicy` | no | Behaviour when a run fires while a previous one is still active |
| `catchUpPolicy` | no | Behaviour for missed scheduled runs |

**Concurrency policies:**

| Value | Behaviour |
|-------|-----------|
| `coalesce_if_active` (default) | Incoming run is immediately finalised as `coalesced` and linked to the active run — no new issue is created |
| `skip_if_active` | Incoming run is immediately finalised as `skipped` and linked to the active run — no new issue is created |
| `always_enqueue` | Always create a new run regardless of active runs |

**Catch-up policies:**

| Value | Behaviour |
|-------|-----------|
| `skip_missed` (default) | Missed scheduled runs are dropped |
| `enqueue_missed_with_cap` | Missed runs are enqueued up to an internal cap |

## Update Routine

```
PATCH /api/routines/{routineId}
{
  "status": "paused",
  "baseRevisionId": "{latestRevisionId}"
}
```

All fields from create are updatable. `baseRevisionId` is optional for backward compatibility; when provided, stale values return `409 Conflict` with the current revision id. **Agents can only update routines assigned to themselves and cannot reassign a routine to another agent.**

## List Revisions

```
GET /api/routines/{routineId}/revisions
```

Returns append-only routine definition revisions newest first. Snapshots include routine fields and safe trigger metadata only; webhook secret values and `secretId` are never returned.

## Restore Revision

```
POST /api/routines/{routineId}/revisions/{revisionId}/restore
```

Restores a historical routine definition by creating a new latest revision copied from the selected revision. Historical revision rows, routine run history, and activity history are preserved. If restoring a deleted webhook trigger requires recreating it, the response can include one-time replacement secret material for that trigger.

## Add Trigger

```
POST /api/routines/{routineId}/triggers
```

Three trigger kinds:

**Schedule** — fires on a cron expression:

```
{
  "kind": "schedule",
  "cronExpression": "0 9 * * 1",
  "timezone": "Europe/Amsterdam"
}
```

**Webhook** — fires on an inbound HTTP POST to a generated URL:

```
{
  "kind": "webhook",
  "signingMode": "hmac_sha256",
  "replayWindowSec": 300
}
```

Signing modes: `bearer` (default), `hmac_sha256`, `github_hmac`, `none`. Replay window range: 30–86400 seconds (default 300).

**API** — fires only when called explicitly via [Manual Run](#manual-run):

```
{
  "kind": "api"
}
```

**Slack event** — fires on inbound Slack Events API callbacks:

```
{
  "kind": "slack_event",
  "signingSecret": "<from Slack app config>",
  "allowedEventTypes": ["app_mention"],
  "botUserId": "U0LAN0Z89",
  "teamId": "T123ABC456",
  "replayWindowSec": 300
}
```

Slack triggers receive the operator-provided Signing Secret (Slack app → Basic Information → Signing Secret). The signing mode is forced to `slack_v0`; Paperclip verifies `X-Slack-Signature` v0 + `X-Slack-Request-Timestamp` against the secret. See [Slack Event Triggers](#slack-event-triggers).

A routine can have multiple triggers of different kinds.

## Update Trigger

```
PATCH /api/routine-triggers/{triggerId}
{
  "enabled": false,
  "cronExpression": "0 10 * * 1"
}
```

## Delete Trigger

```
DELETE /api/routine-triggers/{triggerId}
```

## Rotate Trigger Secret

```
POST /api/routine-triggers/{triggerId}/rotate-secret
```

Generates a new signing secret for webhook triggers. The previous secret is immediately invalidated.

## Manual Run

```
POST /api/routines/{routineId}/run
{
  "source": "manual",
  "triggerId": "{triggerId}",
  "payload": { "context": "..." },
  "idempotencyKey": "my-unique-key"
}
```

Fires a run immediately, bypassing the schedule. Concurrency policy still applies.

`triggerId` is optional. When supplied, the server validates the trigger belongs to this routine (`403`) and is enabled (`409`), then records the run against that trigger and updates its `lastFiredAt`. Omit it for a generic manual run with no trigger attribution.

## Fire Public Trigger

```
POST /api/routine-triggers/public/{publicId}/fire
```

Fires a webhook trigger from an external system. Requires a valid `Authorization` or `X-Paperclip-Signature` + `X-Paperclip-Timestamp` header pair matching the trigger's signing mode.

The full request body is stored on the resulting run as `triggerPayload` and is also exposed to the routine title/description as the built-in `{{payload}}` variable — see [Template Variables](#template-variables).

If the request body includes a top-level `variables` object, each key is merged into the run as a routine variable: `{"variables": {"repo": "paperclip"}}` makes `{{repo}}` available in templates.

`Idempotency-Key` header (optional, ≤ 255 chars) is honored — retries with the same key return the original run instead of dispatching a new one.

## Slack Event Triggers

The `slack_event` trigger turns a routine into the receiver for a Slack app's Events API subscription. Each event that survives signature verification and filtering creates a routine run for the assigned agent.

### Configuring the Slack app

1. Create a Slack app at [api.slack.com](https://api.slack.com/apps) and install it in the workspace.
2. Add the **Event Subscriptions** feature. For the V1 `app_mention` use case, add the `app_mentions:read` bot scope.
3. Copy the **Signing Secret** from **Basic Information → App Credentials**. Paste it into the `signingSecret` field when creating the trigger in Paperclip — Paperclip stores it via its secret provider and never displays it again.
4. Create the trigger via the API or the routine UI. Paperclip returns a Request URL of the form `https://<your-paperclip>/api/routine-triggers/public/<publicId>/fire`.
5. Paste that URL into Slack's **Event Subscriptions → Request URL** field. Slack immediately sends a signed `url_verification` request; Paperclip validates the signature and responds with `{"challenge": "..."}` so the URL turns green.
6. Subscribe to the bot events you want (e.g. `app_mention`) and reinstall the app if Slack prompts you.

### How a request is handled

For every inbound `POST /api/routine-triggers/public/{publicId}/fire`:

1. **Signature check** — Paperclip computes `HMAC-SHA256(secret, "v0:" + ts + ":" + rawBody)` and compares it to `X-Slack-Signature` in constant time.
2. **Replay window** — requests whose `X-Slack-Request-Timestamp` is older than `replayWindowSec` (default 300 s) are rejected with `401`.
3. **Envelope dispatch** —
   - `type: "url_verification"` → respond `200` with `{"challenge": "..."}`. No run is created.
   - `type: "event_callback"` → proceed to filtering.
   - Anything else → respond `200` with no body (`ignored`). No run is created.
4. **Filters** — applied in this order, each returning `200` and dropping the request when it matches:
   - `allowedEventTypes`: must include either the bare `event.type` (e.g. `"message"`) **or** the Slack subscription name in `event.type + "." + event.channel_type` form (e.g. `"message.im"`). Defaults to `["app_mention"]`. Use the dotted form when you want to scope to a channel kind (DM vs public channel vs MPIM), and the bare form to accept all subtypes.
   - `teamId`: when set, `team_id` on the envelope must match.
   - `botUserId`: when set, drop events where `event.user` equals the bot id — prevents the bot from responding to its own messages.
5. **Idempotency** — `event_id` from the envelope is used as the dispatch idempotency key, so Slack retries (`X-Slack-Retry-Num`) collapse onto the original run instead of duplicating issues.
6. **Variables** — the six `slack_*` builtins (see below) and `{{payload}}` are populated from the envelope before the title/description are interpolated.

The full envelope is also saved on the run as `triggerPayload`.

### Rotating the signing secret

When Slack rotates a Signing Secret, `PATCH /api/routine-triggers/{triggerId}` with `signingSecret: "<new value>"`. Paperclip creates a new secret version and switches the trigger to it atomically. There is no separate rotate-secret endpoint for Slack triggers — the value originates outside Paperclip.

### Out of scope (V1)

- **Outbound** (Paperclip → `chat.postMessage`). Agents reply via their own Slack tooling (MCP, bot token in agent secrets) using `{{slack_channel}}` and `{{slack_thread_ts}}`.
- **Slash commands and interactivity payloads.** Those use `application/x-www-form-urlencoded` and need a separate trigger kind.
- **OAuth install flow.** Operators install the Slack app and copy the Signing Secret manually.

## Template Variables

Routine `title` and `description` are templates. Placeholders use `{{name}}` and are interpolated at dispatch time. They are useful for embedding context that varies per run — the trigger payload, the current date, the routine's own configured variables, etc.

Placeholders also accept **dotted paths** that navigate the inbound payload object: `{{payload.event.user}}`, `{{payload.event.blocks}}`, etc. Each segment walks one level of the payload's JSON. If the resolved value is a string, number, or boolean, it is rendered verbatim; objects and arrays are stringified as JSON. If any segment is missing, the placeholder is left literal — exposing the failure rather than silently emitting an empty string.

### Built-in variables

These names are reserved and always available — you do not declare them on the routine:

| Name | Value | Notes |
|------|-------|-------|
| `{{date}}` | Current UTC date in `YYYY-MM-DD` | Resolved at dispatch time |
| `{{timestamp}}` | Human-readable UTC timestamp, e.g. `"April 28, 2026 at 12:17 PM UTC"` | Resolved at dispatch time |
| `{{payload}}` | Pretty-printed JSON of the inbound trigger body | Populated for `webhook` and `slack_event` sources. Empty string for `schedule`, `manual`, and `api`. Capped at 8 KB with a `... (truncated)` suffix when exceeded |
| `{{slack_user}}` | `event.user` from the Slack envelope | `slack_event` source only — empty otherwise |
| `{{slack_text}}` | `event.text` from the Slack envelope | `slack_event` source only |
| `{{slack_channel}}` | `event.channel` from the Slack envelope | `slack_event` source only |
| `{{slack_thread_ts}}` | `event.thread_ts`, falling back to `event.ts` so the agent can always reply in a thread | `slack_event` source only |
| `{{slack_team_id}}` | Top-level `team_id` on the envelope | `slack_event` source only |
| `{{slack_event_id}}` | Top-level `event_id` on the envelope | `slack_event` source only — also used as the dispatch idempotency key |

### User-defined variables

Any other `{{name}}` placeholder in the title or description is treated as a user-defined variable and must be declared in the routine's `variables` field with a name, type, and (optionally) default value and label. Values come from:

1. The `variables` object in the dispatch payload (manual run, webhook, or API).
2. The variable's `defaultValue`, if no payload value is provided.

Required variables without a value cause dispatch to fail with `422`.

### Example — surface a webhook payload on the created issue

Given a routine with this description:

```
Triggered with payload:

{{payload}}
```

…and a webhook trigger fired with body `{"context": "from slack", "user": "wallace"}`, the issue created for the run will render:

```
Triggered with payload:

{
  "context": "from slack",
  "user": "wallace"
}
```

Combine with user variables for richer templates — `{{date}}` in the title, `{{repo}}` from `payload.variables.repo`, and the full `{{payload}}` blob at the bottom of the description.

## List Runs

```
GET /api/routines/{routineId}/runs?limit=50
```

Returns recent run history for the routine. Defaults to 50 most recent runs.

## Agent Access Rules

Agents can read all routines in their company but can only create and manage routines assigned to themselves:

| Operation | Agent | Board |
|-----------|-------|-------|
| List / Get | ✅ any routine | ✅ |
| Create | ✅ own only | ✅ |
| Update / activate | ✅ own only | ✅ |
| Add / update / delete triggers | ✅ own only | ✅ |
| Rotate trigger secret | ✅ own only | ✅ |
| Manual run | ✅ own only | ✅ |
| Reassign to another agent | ❌ | ✅ |

## Routine Lifecycle

```
active -> paused -> active
       -> archived
```

Archived routines do not fire and cannot be reactivated.
