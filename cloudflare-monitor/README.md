Cloudflare Monitor
==================

A proactive agent that watches the **relayfile-cloud** Cloudflare infrastructure
spend and usage — D1 rows read/written, R2 storage costs, queue throughput, and
Worker error rates — via the relayfile VFS usage feeds and posts a Slack alert
when thresholds are exceeded. Notification-only — it never mutates Cloudflare
resources.

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/cloudflare-monitor/persona.ts)

> Built as part of the relayfile → relayfile-cloud migration (Stream D): the
> extracted service runs on Cloudflare Workers with D1, R2, KV, Queues, and
> Durable Objects — and needs cost/usage monitoring that alerts on spend
> thresholds before costs surprise the team.

## How it watches

The agent reads **only** the Relayfile VFS mounts materialized by the
`nango-integrations/cloudflare-relay` syncs — no Cloudflare API token lives in
the agent:

- `/cloudflare/d1/usage/**` — D1 database usage (rows read/written, query count)
- `/cloudflare/r2/usage/**` — R2 bucket usage (storage, Class A/B ops, egress)
- `/cloudflare/queues/usage/**` — queue usage (messages unacked/retried)
- `/cloudflare/workers/usage/**` — Worker usage (requests, errors, CPU time)

### Full-state sweep (cron)

Every 2 hours (`cloudflare-scan`) the agent reads the full VFS usage state and
posts one concise alert if any threshold is exceeded, staying silent (and never
re-alerting an unchanged condition) otherwise.

## Signals (it alerts only when one fires — never spam)

1. **D1 usage spikes** — `rows_read` above `D1_ROWS_READ_THRESHOLD` or
   `rows_written` above `D1_ROWS_WRITTEN_THRESHOLD` in a 24h window.
2. **R2 usage spikes** — `storage_bytes` above `R2_STORAGE_GB_THRESHOLD`,
   `class_a_operations` above 1M, or `egress_bytes` above 100GB in the last
   24h window.
3. **Worker error rate spikes** — error rate >= 5% of total requests in the
   last 24h window.
4. **Queue backlogs** — `messages_unacked` above `QUEUE_UNACKED_THRESHOLD`.
5. **Queue retry rates** — `messages_retried` above 100 in the last 24h window.

## Chat path

Message the agent in its relay inbox and it answers questions about current
Cloudflare usage state ("which D1 databases are reading the most rows?", "any
queue backlogs?"). It loads the full VFS picture and replies via
`ctx.llm.complete()` using the deployer's connected subscription credential.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `SLACK_CHANNEL` | — | Slack channel id to post alerts to (required) |
| `D1_ROWS_READ_THRESHOLD` | `1000000` | Alert when D1 rows read exceeds this in a 24h window |
| `D1_ROWS_WRITTEN_THRESHOLD` | `100000` | Alert when D1 rows written exceeds this in a 24h window |
| `R2_STORAGE_GB_THRESHOLD` | `100` | Alert when R2 bucket exceeds this many GB of storage |
| `QUEUE_UNACKED_THRESHOLD` | `1000` | Alert when unacked messages exceed this count |

## Data sources (Nango syncs)

| Sync | Model | Frequency | Data |
|---|---|---|---|
| `fetch-account-topology` | Inventory | every 1h | D1/R2/KV/Queue resource listings |
| `fetch-workers-usage` | `CloudflareWorkerUsage` | every 1h | Worker request/error/CPU metrics (GraphQL) |
| `fetch-d1-usage` | `CloudflareD1Usage` | every 1h | D1 rows read/written, query count (GraphQL) |
| `fetch-r2-usage` | `CloudflareR2Usage` | every 1h | R2 storage, Class A/B ops, egress (REST) |
| `fetch-queues-usage` | `CloudflareQueueUsage` | every 1h | Queue messages published/acked/retried (GraphQL) |

## How it's wired

```
Cloudflare API ──▶ cloudflare-relay (Nango syncs) ──▶ /cloudflare/** VFS mounts
     │                                                     │
     │ (5 usage syncs)                                     │
     └──▶ D1/R2/Queue/Worker usage feeds                   ▼
                                                      cloudflare-monitor
                     2-hour cron sweep                    (agent.ts)
                           │                                │
                           └── read usage feeds ────────────┘
                                                      │
                                                      ▼
                                                    Slack alert
```

Built after the neon-monitor pattern — see `agents/neon-monitor/` for the
original. Usage syncs are in `cloud/nango-integrations/cloudflare-relay/syncs/`.
