---
title: Slack Event Triggers
summary: Connect a Slack app's Events API to a Paperclip routine
---

A Slack event trigger lets a Paperclip routine fire whenever a Slack event the app subscribes to arrives — typically `app_mention`. Each event creates a routine run for the assigned agent.

## What you'll need

- A Paperclip routine assigned to an agent. The agent receives a heartbeat for each Slack event.
- A Slack workspace where you can install a custom app.
- A Paperclip server reachable over HTTPS from Slack. For local development, use [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or `ngrok`; Slack will not deliver to localhost.

## Step 1 — Create the routine and Slack trigger in Paperclip

1. Open the routine, go to the **Triggers** tab, click **Add trigger**.
2. Set **Kind** to **Slack event**.
3. Paste the Slack **Signing Secret** (you'll grab it in step 2). The field is masked and Paperclip stores it via the configured secret provider — it is never displayed again.
4. Set **Allowed event types**. The default `app_mention` is right for "trigger when the bot is mentioned." Comma-separate to allow multiple, e.g. `app_mention, message.channels`. For `message.*` subscriptions you can use either the dotted Slack subscription name (`message.im`, `message.channels`, `message.groups`, `message.mpim`) to scope to one channel kind, or the bare `message` to accept all of them.
5. Optional: paste the bot's user id into **Bot user id** (you'll get this from Slack after installing the app). This drops events where the bot itself is the author and prevents response loops.
6. Optional: paste your Slack workspace id into **Team id** if you want to reject events from any other workspace.
7. Click **Add trigger**. Paperclip shows a banner with the **Request URL** — copy it.

## Step 2 — Configure the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app from scratch.
2. **Basic Information → App Credentials → Signing Secret** — copy this and paste back into Paperclip's trigger (step 1.3) if you skipped that earlier.
3. **OAuth & Permissions → Scopes → Bot Token Scopes** — add `app_mentions:read`. Add more scopes for any extra event types you allowed.
4. **Install to Workspace** and authorize. After install, copy the **Bot User ID** from **App Home → App Display Information** (or via `auth.test`) and paste into Paperclip's trigger Bot user id field.
5. **Event Subscriptions → Enable Events: On**. Paste the **Request URL** Paperclip gave you.
   - Slack immediately sends a signed `url_verification` request. Paperclip responds with the challenge value; the field turns green within a second or two.
   - If it stays red, check that the secret you pasted in Paperclip matches the Signing Secret in this app, and that your Paperclip server is reachable over HTTPS from the public internet.
6. **Subscribe to bot events** — add `app_mention` (and any others you allowed in Paperclip).
7. **Save Changes**. Slack will prompt to reinstall the app if scopes changed.

## Step 3 — Test it

In a channel where the bot is invited, mention the bot:

```
@my-bot what's up?
```

Within a few seconds you should see:

- A new run on the routine, source `slack_event`.
- A new issue assigned to the routine's agent.
- The agent picks up the heartbeat and starts working.

If you templated the routine description with `{{slack_user}}`, `{{slack_text}}`, `{{slack_channel}}`, or `{{slack_thread_ts}}`, those values are interpolated from the event envelope. `{{payload}}` contains the full JSON.

## Replying to the user

V1 does not post back to Slack on the agent's behalf. Equip the agent with its own Slack tooling — for example, a `chat.postMessage`-capable MCP server with a bot token in the agent's secrets — and have it use:

- `{{slack_channel}}` as the channel.
- `{{slack_thread_ts}}` as the `thread_ts` (this falls back to `event.ts` so the agent can always start a thread).

## Operations

- **Rotate the Signing Secret.** When Slack rotates the secret, `PATCH /api/routine-triggers/{triggerId}` with a new `signingSecret`, or paste it into the trigger editor and save. Paperclip swaps to the new version atomically; in-flight events signed with the old secret return `401` after the swap.
- **Disable temporarily.** Toggle the trigger off in the UI, or set `enabled: false` via PATCH. Slack will keep retrying; pause the routine instead (`status: "paused"`) to drop events without retries.
- **Retries.** Slack retries up to 3 times with `X-Slack-Retry-Num`. Paperclip dedupes by `event_id`, so retries collapse onto the original run.
- **Loops.** Always set Bot user id once you have it. Without it, the bot can mention itself and produce an event that creates another run.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack URL verification stays red | Signing Secret in Paperclip does not match the Slack app, or the Request URL is unreachable from Slack |
| Events arrive but no run is created | Event type not in `allowedEventTypes`; or `teamId`/`botUserId` filters are dropping them. The trigger's recent activity log shows the `filtered` reason |
| Two runs for one mention | `botUserId` is not configured and the bot's own response is generating a second event |
| `401` on every event | Replay window too tight; clock skew between Slack and the Paperclip host |
