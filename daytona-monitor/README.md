<img src="./banner.png" alt="Daytona Monitor">

Daytona Monitor
==================

A proactive agent that watches your Daytona organization's **usage quotas** and
**sandbox allocations** and posts a Slack alert only when something needs
attention. Notification-only — it never starts, stops, or deletes anything.

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/daytona-monitor/persona.ts)

## What it watches

On an hourly cron tick (`usage-scan`) the handler pulls two Daytona endpoints:

- `GET /organizations/{DAYTONA_ORG_ID}/usage` — CPU / memory / disk quota vs current
- `GET /sandboxes` — each sandbox's state + timestamps

Both calls carry `Authorization: Bearer <token>` and
`X-Daytona-Organization-ID: <org>`. The token comes from
`getDaytonaAccessToken(orgId)` (the shared `./lib/daytona-auth.ts` module that
auto-refreshes the Auth0 token).

## Signals (it alerts only when one fires — never spam)

1. **Quota nearing limit** — CPU/memory/disk usage `>= QUOTA_ALERT_PCT` of quota.
2. **Sandbox ERROR** — any sandbox in `ERROR` state.
3. **Stale running** — a `STARTED` sandbox older than `STALE_HOURS` (cost guard).
4. **Allocation jump** — running-sandbox count jumped vs the last snapshot.

It stores a snapshot (running count + the alert signature) in durable
`workspace` memory and re-posts only when the alert *set* changes, so an
unchanged condition is never re-alerted. Slack delivery is checked for a
writeback receipt — an empty `ts` is treated as a failure, not a silent drop.

## Inputs

| input | env | default | meaning |
|---|---|---|---|
| `SLACK_CHANNEL` | `SLACK_CHANNEL` | — (required) | channel id to post alerts to |
| `DAYTONA_ORG_ID` | `DAYTONA_ORG_ID` | `d9efb08e-7f53-4fe0-b37e-d1a281622bc0` | org to monitor |
| `QUOTA_ALERT_PCT` | `QUOTA_ALERT_PCT` | `80` | quota % that trips an alert |
| `STALE_HOURS` | `STALE_HOURS` | `12` | hours before a running sandbox is "stale" |

## Shape

- `persona.ts` — `definePersona(...)`; `cloud: true`, slack scoped at
  `/slack/channels/**` so writes actually mount, memory `workspace`. The
  `persona.json` artifact is **generated** from this via `npm run compile`.
- `agent.ts` — `defineAgent({ schedules: [...] })`; cron-only handler that
  branches on the tick, evaluates the four signals, and posts via
  `slackClient()` from `@relayfile/relay-helpers`.
- `lib/daytona-auth.ts` — `getDaytonaAccessToken(orgId?)` (owned separately);
  until it lands, `agent.ts` reads the daytona CLI's cached token as a fallback.
