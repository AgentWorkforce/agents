GCP Watcher
===========

<img src="./banner.png" alt="GCP Watcher">

A proactive agent that watches your GCP project's **Cloud Run services**,
**Monitoring alert policies**, and **billing/cost**, and posts a Slack alert only
when something needs attention. Notification-only — it never mutates GCP.

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/gcp-watcher/persona.ts)

## Tiering — this is the BASIC (free) tier

`gcp-watcher` reads **only the relayfile VFS mounts** that `@relayfile/adapter-gcp`
materializes (fed by the `gcp-relay` Nango integration on the
`google-service-account` provider). It is the commodity, current-state view.

It deliberately does **not** query BigQuery. Deeper OTel / historical analysis
lives in the **paid tier inside nightcto**, gated for paying customers. Keep this
persona VFS-only.

## What it watches

On an hourly cron tick (`gcp-scan`) — and in real time on Monitoring webhooks —
it reads three VFS mounts (no GCP token; auth lives in the Nango connection):

- `/gcp/run/services/**` — Cloud Run services + latest-revision readiness
- `/gcp/monitoring/alerts/**` — alert policies / firing incidents
- `/gcp/billing/current.json` — current-period spend (FinOps)

## Signals (alert-only-on-change — never spam)

1. **Cloud Run not ready** — a service whose latest revision isn't `Ready`.
2. **Alert firing** — a Monitoring alert policy with an open incident.
3. **Spend over threshold** — current spend `>= BILLING_ALERT_USD`.

It stores the alert signature in durable `workspace` memory and re-posts only
when the alert *set* changes. Slack delivery is checked for a writeback receipt —
an empty `ts` is treated as a failure, not a silent drop.

## Real-time path

GCP Monitoring alert policies → Pub/Sub → relay webhook, normalized by the
adapter into `monitoring.incident.open` / `monitoring.incident.closed`. The agent
alerts the moment a policy fires instead of waiting for the hourly tick.

## Inputs

| input | env | default | meaning |
|---|---|---|---|
| `SLACK_CHANNEL` | `SLACK_CHANNEL` | — (required) | channel id to post alerts to |
| `GCP_PROJECT_ID` | `GCP_PROJECT_ID` | `nightcto-production` | project to watch |
| `BILLING_ALERT_USD` | `BILLING_ALERT_USD` | `500` | spend (USD) that trips an alert |

## Shape

- `persona.ts` — `definePersona(...)`; `cloud: true`, gcp VFS scope + slack scoped
  at `/slack/channels/**`, memory `workspace`, relay inbox for chat. `persona.json`
  is the generated artifact.
- `agent.ts` — `defineAgent({ schedules, triggers })`; branches on cron tick /
  Monitoring webhook / relay message, evaluates the three signals, posts via
  `slackClient()`.

Pairs with `@relayfile/adapter-gcp` (relayfile-adapters) and the `gcp-relay` Nango
integration (../cloud). Until the latter is live, the VFS mounts are empty and the
agent stays silent (it degrades gracefully).
