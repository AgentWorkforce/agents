Neon Monitor
==============

<img src="./banner.png" alt="Neon Monitor">

A proactive agent that watches your **Neon** database organization's
infrastructure health — failed operations, endpoints stuck waking/thrashing,
advisor issues, and runaway compute/spend — and posts a Slack alert only when
something needs attention. It can also answer questions about your live Neon
state from the relay inbox. Notification-only — it never mutates Neon.

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/neon-monitor/persona.ts)

> Built after the ai-hist connection-pooling incident (2026-06-16): a CF Worker's
> WebSocket Neon connections terminated unexpectedly, and the repeated
> `start_compute` failures in the operations feed would have surfaced the
> degradation 30+ minutes before it became user-visible.

## How it watches

The agent reads **only** the Relayfile VFS mounts materialized by
`@relayfile/adapter-neon` (fed by the `neon-relay` Nango connection) — no Neon
token lives in the agent:

- `/neon/operations/**` — recent DB operations (failures)
- `/neon/endpoints/**` — compute endpoint state (waking / thrashing)
- `/neon/advisors/**` — advisor issues (ERROR / WARN)
- `/neon/consumption/**` — per-project compute-unit-seconds
- `/neon/spending-limits/**` — org spending cap
- `/neon/projects/**` — project list

It runs on two paths:

### Real-time sync-delta triggers

The moment the operations sync detects a change, the agent fires on the
normalized Neon delta events (`event.type === 'neon.<object>.<action>'`):

| Trigger | Fires when |
|---|---|
| `operation.failed` | a DB operation fails (on first sync **or** a `running → failed` transition) |
| `endpoint.state_changed` | a compute endpoint transitions state (e.g. `idle → active`) |
| `advisor.issue_raised` | a new advisor issue is raised |

Each event is read from `(await event.expand('full')).data` and de-duplicated by
a stable per-object fingerprint so a replayed/retried delivery never double-alerts.

### Full-state sweep (cron)

Every 2 hours (`neon-scan`) the agent re-reads the full VFS state to catch the
signals that have no per-record delta event — compute spikes and absent/exceeded
spending limits — and posts one concise alert if anything is firing, staying
silent (and never re-alerting an unchanged condition) otherwise.

## Signals (it alerts only when one fires — never spam)

1. **Failed operations** — `status: 'failed'` (or `failures_count > 0` with an
   error), above `FAILED_OPS_THRESHOLD`.
2. **Endpoints stuck waking/init** — `current_state` in `{ waking, init }`,
   above `WAKING_ENDPOINTS_THRESHOLD`.
3. **Advisor issues** — at `ERROR` or `WARN` level.
4. **Compute / spend** — projects above ~1M CU-seconds when no spending limit is
   set (only alerts when both are true, to avoid permanent noise).

## Chat path

Message the agent in its relay inbox and it answers questions about current Neon
state ("which projects burn the most compute?", "any failed ops today?"). It
loads the full VFS picture and replies via `ctx.llm.complete()` using the
deployer's connected subscription credential.

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `SLACK_CHANNEL` | — | Slack channel id to post alerts to (required) |
| `NEON_ORG_ID` | `org-royal-sea-32807234` | Neon org id for spending-limit lookups |
| `FAILED_OPS_THRESHOLD` | `3` | Alert when failed-op count meets/exceeds this |
| `WAKING_ENDPOINTS_THRESHOLD` | `2` | Alert when waking/init endpoints meet/exceed this |

## How it's wired

```
Neon API ──▶ neon-relay (Nango sync) ──▶ @relayfile/adapter-neon
   │                                          │
   │ (sync deltas)                            ▼
   └──▶ cloud normalizeNeonSyncDelta() ──▶ /neon/** VFS mounts
                     │                         │
        neon.<obj>.<action> trigger      cron full-state read
                     └──────────┬────────────┘
                                ▼
                          neon-monitor → Slack
```

The frozen sync-delta event contract and cross-repo wiring are documented in
[`SPEC-neon-sync-triggers.md`](./SPEC-neon-sync-triggers.md).
