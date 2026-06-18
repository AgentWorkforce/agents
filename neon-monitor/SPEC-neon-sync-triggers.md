# Spec: Neon sync-delta webhook triggers

**Status:** Ready for implementation  
**Depends on:** AgentWorkforce/cloud#2266 (neon-relay), AgentWorkforce/agents#71 (neon-monitor)  
**Repos touched:** `cloud`, `relayfile-adapters`, `agents`, `nightcto`  
**Effort:** ~3 days across all repos

---

## Two-tier context

This spec is **shared infrastructure** that unblocks two distinct personas at different product tiers. Implementers should understand both before starting — the trigger event shape is the contract between them.

### Free tier — `agents/neon-monitor` (AgentWorkforce/agents#71)

VFS snapshot reads on a 15-minute cron. Threshold-based alerting. Basic Slack post.
No LLM judgment, no cross-signal correlation. The gcp-watcher equivalent for Neon.
The cron drops to 2-hour once triggers are live (triggers cover the hot path).

### Paid tier — `nightcto/personas/watch` (NightCTO product)

Already declares `neon` triggers in `persona.ts` (`operation.failed`, `operation.cancelled`,
`endpoint.suspended`, `spending-limit.missing`, `consumption.threshold`, `advisor.issue`).
`fromNeonRecord()` in `personas/watch/lib/signals.ts` is fully implemented — maps every
neon VFS record type to a structured `IncidentSignal` with calibrated severity levels
(failed/cancelled ops → critical, endpoint suspended → high, no spending limit → medium).
Feeds into `@nightcto/skill-observability-triage` (multi-signal OTel correlation),
`@nightcto/skill-daily-recap`, `@nightcto/skill-hotfix` (can propose fixes),
Sage handoff, and founder DMs for critical incidents.

**Neither tier fires today** because Cloud does not route `sync.completed` webhooks for
`neon-relay` to trigger events. This spec builds that shared routing layer once.
After it ships, both personas activate automatically on their next deploy.

---

## Problem

`neon-monitor` currently runs on a 15-minute cron and reads a VFS snapshot.
This means a cluster of failed operations that appears and clears within one
sync window is invisible. The ai-hist pooling incident (2026-06-16) ran for
hours, so 15 minutes would have caught it — but a transient thrash that
resolves in under 10 minutes is silently dropped.

The root cause is that Neon has no native webhook API for operation or endpoint
state events. The provider is poll-only. The right fix is not to wait for Neon
to add webhooks — it is to treat Nango's own sync-delta mechanism as the event
source.

When `fetch-operations` runs and detects new records (ADDED) with
`status === 'failed'`, Nango sends a `sync.completed` webhook to Cloud. Cloud
already receives this but discards it for Neon because there are no registered
trigger events. This spec wires that signal all the way to the neon-monitor.

---

## Architecture

```
Neon API (polling)
     │ every 10 min
     ▼
neon-relay Nango sync (fetch-operations)
     │ sync.completed webhook
     ▼
Cloud nango-webhook-router
     │ extract delta: ADDED records where status=failed
     ▼
Relayfile event bus  ──── neon.operation.failed
     │                    neon.endpoint.state_changed
     │                    neon.advisor.issue_raised
     ▼
neon-monitor agent (triggered immediately, not 15-min wait)
     │
     ▼
Slack alert
```

---

## Changes required

### 1. `relayfile-adapters` — implement webhook-normalizer and register triggers

**File:** `packages/neon/src/webhook-normalizer.ts`

The current file is a stub (`return null`). Replace it with a real normalizer
that accepts Nango sync-delta records as input and emits normalized trigger
events. This is not a provider webhook normalizer — it normalizes Nango's own
`sync.completed` delta payload into the same event envelope shape that real
webhook normalizers produce.

```typescript
export interface NeonSyncDeltaRecord {
  id: string;
  json: Record<string, unknown>;
  _nango_metadata: {
    action: 'ADDED' | 'UPDATED' | 'DELETED';
    first_seen_at: string;
    last_modified_at: string;
    cursor: string;
  };
}

export interface NormalizedNeonWebhook {
  provider: 'neon';
  eventType: NeonTriggerEvent;
  objectType: NeonWebhookObjectType;
  objectId: string;
  path: string;                              // VFS path for the affected record
  fileEventType: 'file.created' | 'file.updated' | 'file.deleted';
  shouldDelete: boolean;
  payload: Record<string, unknown>;
}

export type NeonWebhookObjectType = 'operation' | 'endpoint' | 'advisor-issue';
export type NeonTriggerEvent =
  | 'operation.failed'
  | 'operation.succeeded'
  | 'endpoint.state_changed'
  | 'advisor.issue_raised';

export function normalizeNeonSyncDelta(
  modelName: string,
  records: NeonSyncDeltaRecord[],
): NormalizedNeonWebhook[] {
  const results: NormalizedNeonWebhook[] = [];
  for (const record of records) {
    const normalized = normalizeRecord(modelName, record);
    if (normalized) results.push(normalized);
  }
  return results;
}
```

Normalization rules per model:

| Nango model | Condition | eventType |
|---|---|---|
| `NeonOperation` | `action === 'ADDED'`, `json.status === 'failed'` | `operation.failed` |
| `NeonOperation` | `action === 'UPDATED'`, `json.status` changed to `'finished'` | `operation.succeeded` |
| `NeonEndpoint` | `action === 'UPDATED'`, `json.current_state` changed | `endpoint.state_changed` |
| `NeonAdvisorIssue` | `action === 'ADDED'` | `advisor.issue_raised` |

For `operation.failed` and `endpoint.state_changed`, emit only when the
condition is present — do not emit for every ADDED/UPDATED record.

**File:** add trigger entry in `packages/neon/src/index.ts`:

```typescript
export function supportedTriggerEvents(): string[] {
  return [
    'operation.failed',
    'operation.succeeded',
    'endpoint.state_changed',
    'advisor.issue_raised',
  ];
}
```

**File:** regenerate `packages/core/src/triggers/catalog.generated.ts`:

```bash
cd relayfile-adapters && npm run triggers:generate
```

This adds the `"neon"` entry to `KNOWN_TRIGGER_CATALOG`.

---

### 2. `cloud` — route sync.completed to neon trigger events

**Context:** When Nango finishes a sync, it POSTs a `sync.completed` webhook
to Cloud's Nango webhook endpoint. Cloud's `nango-webhook-router` already
handles these for other providers. For Neon, we need to extract the delta
records and emit trigger events.

**File:** `services/agent-gateway/src/worker.ts` or the nango-webhook-router
handler (wherever `sync.completed` is currently processed for other providers).

Find the `sync.completed` handler branch. Add a Neon case:

```typescript
if (webhookPayload.type === 'sync.completed' && webhookPayload.providerConfigKey === 'neon-relay') {
  await handleNeonSyncDelta(webhookPayload, env, ctx);
}
```

**New file:** `services/agent-gateway/src/neon-sync-delta.ts`

```typescript
import { normalizeNeonSyncDelta } from '@relayfile/adapter-neon';

export async function handleNeonSyncDelta(
  payload: NangoSyncCompletedPayload,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const { connectionId, syncName, model, queryTimeStamp } = payload;

  // Only process the syncs that carry triggerable signal.
  const WATCHED_MODELS = new Set(['NeonOperation', 'NeonEndpoint', 'NeonAdvisorIssue']);
  if (!WATCHED_MODELS.has(model)) return;

  // Fetch the delta from Nango records API: records changed since last cursor.
  // The cursor from the previous sync.completed is stored in durable state.
  const cursor = await getDeltaCursor(connectionId, model);
  const deltaRecords = await fetchNangoRecordsDelta(connectionId, model, cursor, env);
  if (!deltaRecords.records.length) return;

  // Persist the new cursor before emitting — at-least-once; better to
  // double-alert than to lose the cursor on a crash and re-alert forever.
  await saveDeltaCursor(connectionId, model, deltaRecords.nextCursor);

  // Normalize to trigger events.
  const events = normalizeNeonSyncDelta(model, deltaRecords.records);
  if (!events.length) return;

  // Emit each event through the same Relayfile event bus the webhook handler uses.
  for (const event of events) {
    await emitRelayfileEvent(event, connectionId, env, ctx);
  }
}
```

**Nango records delta fetch** (`fetchNangoRecordsDelta`):

Call `GET /records?model=<model>&delta=true&cursor=<prev>` on the Nango API.
Use the Nango secret key (`Resource.NangoSecretKey.value`). This is a
server-side call from the CF Worker — it does not go through the neon-relay
Nango proxy.

```
GET https://api.nango.dev/records
  ?connectionId=<connectionId>
  &providerConfigKey=neon-relay
  &model=NeonOperation
  &delta=true
  &cursor=<storedCursor>
Authorization: Bearer <NANGO_SECRET_KEY>
```

**Cursor storage:** Use a Durable Object or KV. The cursor key is
`neon-delta-cursor:<connectionId>:<model>`. If no cursor exists (first run),
omit `&delta=true` to get all current records and store the returned cursor
without emitting events — cold start baseline.

**SST secret already exists:** `Resource.NangoSecretKey.value` (the Nango
secret key is already registered for the existing Nango webhook path).

---

### 3. `cloud` — register neon trigger events in the webhook router

**File:** wherever `KNOWN_TRIGGER_CATALOG` is consumed to validate inbound
trigger events before dispatch to agent-gateway. After regenerating the catalog
in relayfile-adapters and bumping the adapter package version, bump
`@relayfile/adapter-core` in `packages/core/package.json` and regenerate the
Cloud-side trigger allowlist:

```bash
npm run nango-provider-parity:generate
```

Confirm `neon.operation.failed`, `neon.endpoint.state_changed`, and
`neon.advisor.issue_raised` appear in the Cloud trigger routing table.

---

### 4. `agents` — add triggers to neon-monitor and keep the cron

Update `neon-monitor/agent.ts`:

```typescript
export default defineAgent({
  // Keep the cron as a full-state sweep (catches consumption/spending signals
  // that don't produce per-record delta events).
  schedules: [{ name: 'neon-scan', cron: '0 */2 * * *', tz: 'UTC' }], // drop to 2h; triggers cover the hot path

  // Real-time: fire the moment the operations sync detects new failures.
  triggers: {
    neon: [
      { on: 'operation.failed' },
      { on: 'endpoint.state_changed' },
      { on: 'advisor.issue_raised' },
    ]
  },

  handler: async (ctx, event) => {
    if (isRelaycastMessageEvent(event)) {
      await handleInboxMessage(ctx, event);
      return;
    }
    // Real-time path: a sync-delta event arrived.
    if (event.source === 'neon') {
      await handleNeonEvent(ctx, event);
      return;
    }
    // Full-state sweep (every 2h).
    if (isCronTickEvent(event)) {
      await handleScan(ctx);
      return;
    }
  }
});
```

New `handleNeonEvent` function:

```typescript
async function handleNeonEvent(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) return;

  // The event payload carries the normalized record from the sync delta.
  // Extract what failed and post immediately — no need to read the full index.
  const payload = event.payload as Record<string, unknown>;
  const eventType = event.type; // 'operation.failed' | 'endpoint.state_changed' | 'advisor.issue_raised'

  const message = formatEventAlert(eventType, payload);

  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, message);
  if (!result?.ts) throw new Error(`Slack post returned no receipt for neon event ${eventType}`);

  ctx.log?.('info', 'neon-monitor.event-alerted', { eventType, ts: result.ts });
}

function formatEventAlert(eventType: string, payload: Record<string, unknown>): string {
  if (eventType === 'operation.failed') {
    const action = String(payload.action ?? 'unknown');
    const project = String(payload.project_id ?? 'unknown');
    const error = payload.error ? ` — ${String(payload.error).slice(0, 200)}` : '';
    return `:red_circle: *Neon operation failed*\n  \`${action}\` on project \`${project}\`${error}`;
  }
  if (eventType === 'endpoint.state_changed') {
    const host = String(payload.host ?? payload.id ?? 'unknown');
    const state = String(payload.current_state ?? 'unknown');
    return `:warning: *Neon endpoint state change*\n  \`${host}\` → \`${state}\``;
  }
  if (eventType === 'advisor.issue_raised') {
    const title = String(payload.title ?? payload.name ?? 'unknown');
    const level = String(payload.level ?? 'WARN');
    const emoji = level === 'ERROR' ? ':red_circle:' : ':warning:';
    return `${emoji} *Neon advisor issue*: ${title}`;
  }
  return `:warning: *Neon event*: \`${eventType}\``;
}
```

Also update `persona.ts` to declare the neon trigger scope (the scope already
covers `operations/**`, `endpoints/**`, `advisors/**` — no change needed).

---

## Sequencing

The repos must be done in this order. Steps 3a and 3b can run in parallel.

```
Step 1: relayfile-adapters
  └─ Implement webhook-normalizer + supportedTriggerEvents()
  └─ Regenerate catalog.generated.ts
  └─ Publish new @relayfile/adapter-neon version (bump minor)
  └─ Publish new @relayfile/adapter-core version (updated catalog)

Step 2: cloud (depends on step 1)
  └─ Bump @relayfile/adapter-neon and @relayfile/adapter-core
  └─ Implement neon-sync-delta.ts handler
  └─ Wire sync.completed → handleNeonSyncDelta in nango-webhook-router
  └─ Register neon triggers in routing table
  └─ Tests: mock a NeonOperation ADDED delta, assert neon.operation.failed emitted

Step 3a: agents — free tier (depends on step 2)
  └─ Add triggers to neon-monitor/agent.ts
  └─ Add handleNeonEvent function (see §agents below)
  └─ Reduce cron from */15 to 0 */2 (triggers cover hot path)
  └─ Deploy: agentworkforce deploy neon-monitor/persona.ts --mode cloud --on-exists update

Step 3b: nightcto — paid tier (depends on step 2, parallel with 3a)
  └─ persona.ts already declares neon triggers — no change expected
  └─ fromNeonRecord() in lib/signals.ts already implemented — no change expected
  └─ Verify watchListenerSpec.triggers.neon event names match the catalog from step 1:
     catalog emits:  operation.failed, endpoint.state_changed, advisor.issue_raised
     persona.ts has: operation.failed, operation.cancelled, endpoint.suspended,
                     spending-limit.missing, consumption.threshold, advisor.issue
     → Align the names; the normalizer (step 1) is the source of truth
  └─ Deploy: agentworkforce deploy nightcto/personas/watch/persona.ts --mode cloud --on-exists update
  └─ Smoke test: trigger a failed op → confirm neon.operation.failed fires
     handleSignal → triage → Slack alert in the nightcto channel
```

### Event name alignment (critical)

The nightcto persona.ts uses human-readable names (`endpoint.suspended`,
`spending-limit.missing`) that differ from the names the normalizer will emit.
One of these must be the canonical form — the normalizer in relayfile-adapters
is the right place to define it since it's the source. Recommend keeping the
normalizer's names and updating nightcto's `watchListenerSpec` to match, so the
catalog is always the single source of truth.

Suggested canonical names (normalizer outputs, both tiers subscribe):

| Event | nightcto current | Recommended canonical |
|---|---|---|
| Operation fails | `operation.failed` | `operation.failed` ✓ same |
| Operation cancelled | `operation.cancelled` | `operation.cancelled` ✓ same |
| Endpoint waking/suspended | `endpoint.suspended` | `endpoint.state_changed` (broader) |
| Spending limit absent | `spending-limit.missing` | `spending-limit.missing` ✓ same |
| Consumption spike | `consumption.threshold` | `consumption.threshold` ✓ same |
| Advisor issue | `advisor.issue` | `advisor.issue_raised` |

The free-tier neon-monitor subscribes to a subset: `operation.failed`,
`endpoint.state_changed`, `advisor.issue_raised`. The paid tier subscribes to all.

---

## Testing checkpoints

### relayfile-adapters
- Unit test `normalizeNeonSyncDelta` with a fixture `NeonOperation` ADDED record where `status=failed` → asserts `eventType === 'operation.failed'` returned
- Unit test with a non-failed operation ADDED record → asserts empty array returned (no false positive)
- Unit test `supportedTriggerEvents()` matches `KNOWN_TRIGGER_CATALOG['neon']` after regeneration

### cloud
- Integration test: POST a synthetic `sync.completed` webhook for `neon-relay` model `NeonOperation` with a delta containing one failed op — assert `handleNeonSyncDelta` calls `emitRelayfileEvent` once with `eventType === 'operation.failed'`
- Test cursor cold-start: first call with no stored cursor fetches full records, stores cursor, emits nothing
- Test cursor advance: second call with stored cursor fetches only delta, emits events for new failures

### agents (free tier)
- Unit test `handleNeonEvent` with a mock `operation.failed` event payload → assert `slackClient().post()` called with message containing the action and project id
- Unit test `handleNeonEvent` with `endpoint.state_changed` and `waking` state → assert Slack post fires
- `agentworkforce deploy neon-monitor/persona.ts --mode cloud --dry-run` → asserts 2 integrations, 1 schedule, 3 triggers

### nightcto (paid tier)
- Existing `fromNeonRecord` unit tests in `personas/watch/lib/signals.test.ts` should all pass unchanged
- Add a test: fire a synthetic `neon.operation.failed` event through `watchListenerSpec` → assert `handleSignal` is called with `source: 'neon'` and `level: 'critical'`
- `agentworkforce deploy nightcto/personas/watch/persona.ts --mode cloud --dry-run` → asserts neon triggers present

---

## Files changed (summary)

### relayfile-adapters
| File | Change |
|---|---|
| `packages/neon/src/webhook-normalizer.ts` | Full implementation replacing stub |
| `packages/neon/src/index.ts` | Export `supportedTriggerEvents()` |
| `packages/core/src/triggers/catalog.generated.ts` | Add `neon` entry (regenerated) |
| `packages/core/src/triggers/catalog.generated.json` | Same (regenerated) |

### cloud
| File | Change |
|---|---|
| `services/agent-gateway/src/neon-sync-delta.ts` | New file |
| `services/agent-gateway/src/worker.ts` | Add sync.completed neon branch |
| `packages/core/package.json` | Bump @relayfile/adapter-neon, @relayfile/adapter-core |
| Tests | New sync-delta integration test |

### agents (free tier)
| File | Change |
|---|---|
| `neon-monitor/agent.ts` | Add `triggers`, `handleNeonEvent`, reduce cron to 2h |
| `neon-monitor/persona.ts` | No change expected |

### nightcto (paid tier)
| File | Change |
|---|---|
| `personas/watch/persona.ts` | Align trigger event names to catalog (see event name table above) |
| `personas/watch/agent.ts` → `watchListenerSpec` | Same alignment |
| `personas/watch/lib/signals.ts` | No change expected (`fromNeonRecord` is already complete) |

---

## Open questions for implementers

1. **Cursor storage backend**: The CF Worker has access to KV via `Resource.RelayKv` (if linked) or a Durable Object. Confirm which is the right cursor storage before implementing `getDeltaCursor`/`saveDeltaCursor`. KV is simpler; DO gives stronger consistency.

2. **Cold-start baseline behavior**: On first deploy, should the monitor fire for all currently-failed operations (potentially noisy) or only for new failures after baseline? Recommend: store cursor on first run without emitting — agent will catch existing state on the next 2-hour cron sweep.

3. **`endpoint.state_changed` noise threshold**: Every suspend/wake cycle emits this event. Consider filtering to only `waking` or `init` states in the normalizer, not every state transition, to avoid alerting on normal suspend cycles.

4. **`advisor.issue_raised` rate**: Advisor issues are re-evaluated on each sync. A persistent advisor issue (e.g. missing index) will appear as ADDED on every sync if Nango doesn't deduplicate by `cache_key`. Verify how Nango tracks advisor issue identity — the `cache_key` field in `RawNeonAdvisorIssue` is likely the stable dedup key. If Nango treats each sync as a fresh ADDED, the normalizer must suppress issues whose `cache_key` the monitor has already seen (durable memory, same fingerprint mechanism as the cron scan).

---

## Prior art to read

- `services/agent-gateway/src/watch-subscriber.ts` — how other sync events are routed
- `packages/daytona/src/webhook-normalizer.ts` in relayfile-adapters — the canonical normalizer shape to follow
- `agents/daytona-monitor/agent.ts` — the trigger handler pattern in the monitor this one mirrors
- `nango-integrations/neon-relay/syncs/fetch-operations.ts` — confirms `NeonOperation` is the model name; `status` and `action` are the fields to filter on

---

## Implementation addendum (team validation, 2026-06-18)

The body above is the original design. The points below were validated against the
**actual** `relayfile-adapters` and `cloud` checkouts by the per-repo agents and
**supersede the body where they conflict.** Read this section before implementing.

### Frozen event contract — 5 delta events

The normalizer is the single source of truth. Legal subscription set (a persona may
subscribe to a subset; nothing outside it):

| eventType | model | condition |
|---|---|---|
| `operation.failed` | `NeonOperation` | `action === 'ADDED'` + `status === 'failed'` |
| `operation.cancelled` | `NeonOperation` | `action === 'ADDED'` + `status === 'cancelled'` |
| `operation.succeeded` | `NeonOperation` | `action === 'UPDATED'` + transition evidence `status → 'finished'` |
| `endpoint.state_changed` | `NeonEndpoint` | `action === 'UPDATED'` + `current_state` changed |
| `advisor.issue_raised` | `NeonAdvisorIssue` | `action === 'ADDED'` |

`spending-limit.missing` and `consumption.threshold` are **full-state signals**, NOT
delta events — they have no per-record ADDED/UPDATED. They stay `fromNeonRecord`
outputs on the **cron sweep only** and must **not** be declared as `triggers.neon`
(see strict preflight below). Subscriptions: free-tier `neon-monitor` takes
failed/cancelled? (its choice) — the spec's §4 lists failed/endpoint/advisor; paid-tier
`nightcto/watch` takes failed/cancelled/endpoint/advisor (not succeeded).

### Normalizer event shape + downstream dedup

`normalizeNeonSyncDelta(modelName, records)` returns, per emitted event:

```ts
{ provider: 'neon', eventType, objectType: 'operation' | 'endpoint' | 'advisor-issue',
  objectId, path, occurredAt, payload,
  metadata: { action, firstSeenAt, lastModifiedAt, cursor? } }
```

- `objectId`: `operation.id` / `endpoint.id` / advisor `cache_key` (raw record id kept in `payload.id`).
- `occurredAt`: provider/Nango timestamp — **never** `new Date()`. A Cloud receipt time, if any, is a separate `receivedAt` diagnostic only.

Per-object-type dedup fingerprints (both tiers use these — stable identity, not handler time):

```
operation.* :  neon:${eventType}:${objectId}
advisor     :  neon:advisor.issue_raised:${cache_key || objectId}
endpoint    :  neon:endpoint.state_changed:${objectId}:${current_state}:${occurredAt}
```

Endpoint includes state+time so legitimate later transitions on the same endpoint
(`idle→active→idle`) are not suppressed.

### Normalizer hardening (relayfile-adapters tests)

Record returns **no event** when: missing `_nango_metadata.action`; missing stable
`objectId`; or (for `operation.succeeded`/`endpoint.state_changed`) no previous/current
or trustworthy `changedFields` evidence. **Negative test required:** plain final
snapshots (`status:'finished'`, `current_state:'active'`) with no transition metadata
must produce `[]`. If Nango can't expose previous values but exposes `changedFields:
['status']`/`['current_state']`, that is sufficient — Cloud adapts at the call boundary.

### Corrections to the body

1. **§1 method:** the catalog generator reads adapter `supportedEvents()` (or
   `neon.mapping.yaml` `webhooks:` keys), **NOT** `supportedTriggerEvents()`. An extra
   `supportedTriggerEvents()` export won't update `KNOWN_TRIGGER_CATALOG`.
2. **§1 regen command:** `npx turbo build` then `npx adapter-core triggers generate`
   (+ `npx adapter-core triggers check`) — **NOT** `npm run triggers:generate`.
3. **§1/§2 versioning:** do **NOT** bump package versions in the feature PR; the
   publish workflow owns bumps (repo AGENTS.md). Open the source/catalog PR first;
   canary/publish is a separate downstream step.
4. **§2 architecture (rewritten):** do **NOT** add `agent-gateway/src/neon-sync-delta.ts`
   nor a `sync.completed` webhook branch nor a new KV/DO cursor. Cloud's inbound webhook
   is `type:"sync"` → `handleSyncEvent()` → `packages/core/src/sync/nango-sync-workflow.ts`.
   Add a narrow post-page/post-write hook for watched Neon models in
   `nango-sync-runtime.ts`/`nango-sync-workflow.ts`, call `normalizeNeonSyncDelta()`, and
   dispatch to the **existing proactive VFS-watch ingress**. Reuse the workflow's existing
   `cursor`/`checkpoints`; first-run suppression keys off `syncType === 'INITIAL'` /
   `checkpoints.from === null` (no separate cursor store).
5. **§3 routing:** wire the frozen 5 into `packages/core/src/relayfile/provider-contracts.ts`
   `triggerEvents` (from the adapter-core catalog). `npm run nango-provider-parity:generate`
   is for sync-model parity, **not** trigger routing — wrong command for this step.

### Strict preflight (important)

Deploy preflight is **strict**: `translatePersonaTriggersToWatchGlobs()` →
`relayfilePathsForTrigger()` throws `unsupported_trigger` for any provider+event it can't
map. Cloud's Neon `provider-contracts.ts` currently has resources but no `triggerEvents`,
so the 5 must be wired in (correction #5) **before** any agents/nightcto `--dry-run` is
expected to pass. Unknown trigger names are hard failures, not silent no-ops.

### Mandatory spike (gates Step 2)

Before coding Step 2: prove whether the existing Nango `listRecords` path returns
`_nango_metadata.action` **and** enough prior/changed-field metadata for the two
transition events. If not, extend the records request / add a delta fetch at the
workflow boundary — do **not** weaken the 5-event contract or alert off snapshots.

### Blocker #0 — `packages/neon` does not exist

Confirmed from both checkouts: relayfile-adapters has no `packages/neon`, and cloud
imports `@relayfile/adapter-neon` but it's absent from package-lock/node_modules.
**Nothing starts until this is resolved** — either an existing Neon adapter branch is
shared, or `packages/neon` is scaffolded net-new (which changes the ~3-day estimate).
Owner decision required.

### Revised critical path

`#0 packages/neon decision → delta-metadata spike → Step 1 normalizer+catalog →
Step 2 cloud sync-hook+provider-contracts → Steps 3a/3b deploy (parallel)`.

---

## Live-build corrections (team build, 2026-06-18 — supersede everything above)

`#0` is **cleared**: `relayfile-adapters` PR #212 merged (commit `4d4f33c`),
`@relayfile/adapter-neon` published `@0.1.1`. Spike done; Step 1 landed; Steps
3a/3b staged. The items below were found while actually building each side and
**supersede the body AND the first addendum where they conflict.**

### C1 — Nango metadata field is `last_action`, not `action`

The delta action is `record._nango_metadata.last_action` (Nango lowercase
`added`/`updated`/`deleted`), **not** `_nango_metadata.action`. The normalizer
case-normalizes it and emits it as `metadata.action` (`ADDED`/`UPDATED`) on the
output event. `normalizeNeonSyncDelta()` keys on `last_action`; the negative
tests assert a record with `last_action:'updated'` and no transition evidence
emits `[]`.

### C2 — transition evidence is carried in `_relayfile_transition`

`listRecords` does **not** expose prior values or changed-field lists (spike
result). Cloud enriches watched UPDATED records at the workflow boundary, before
`writeBatch`, by reading the prior canonical Relayfile record and attaching:

```ts
_relayfile_transition: {
  previous: { status?: string; current_state?: string };
  current:  { status?: string; current_state?: string };
  changedFields: Array<'status' | 'current_state'>;  // [] when no change
}
```

`operation.succeeded` emits only when prior `status` differs and current is
`finished`; `endpoint.state_changed` only when `current_state` actually changed.
First run is suppressed via `syncType === 'INITIAL'` / `checkpoints.from === null`.
The normalizer strips `_nango_metadata` and `_relayfile_transition` from the
emitted `payload`, exposing only the normalized `metadata` object alongside it.

### C3 — the v4 consumer envelope (this replaces §4's handler entirely)

§4's handler is **pre-v4 and will not run** (`event.source`/`event.payload` were
removed). The runtime decodes Cloud's gateway envelope via
`@agentworkforce/runtime`'s `envelopeToAgentEvent`, which delivers a standard
`@agent-relay/events` `AgentEvent`. **Verified behavior** (not assumed):

- `event.type` = `neon.<object>.<action>` (e.g. `neon.operation.failed`). Trigger
  decls stay `{ on: 'operation.failed' }`; the runtime adds the `neon.` prefix.
- `event.occurredAt` = provider time (top-level, reliable).
- **`event.resource` is a thin handle** `{ path, kind:'neon.<object>', id, provider }`
  where **`id` is the DELIVERY id, not the objectId.** Do **not** read identity
  from `event.resource`.
- The full normalized object is reachable **only** via
  **`(await event.expand('full')).data`** = `{ provider, eventType, objectType,
  objectId, path, payload, metadata, current_state? }`.

Producer note for Cloud: keep putting the whole normalized object in
`env.resource` — the runtime's `loadFull` loader is what surfaces it as
`expand('full').data`. Consumers read from `expand('full').data`, period.

**Reference consumer (both `neon-monitor` and `nightcto/watch` mirror this):**

```ts
async function parseNeonEvent(event) {
  const type = event.type ?? '';
  if (!type.startsWith('neon.')) return undefined;
  let data = {};
  try { const full = await event.expand('full'); if (full?.data) data = full.data; } catch {}
  const record = (data.payload && typeof data.payload === 'object') ? data.payload : {};
  const objectId = data.objectId ?? data.id ?? record.cache_key ?? record.id;  // NOT event.resource.id
  if (!objectId) return undefined;
  return {
    eventType: data.eventType ?? type.slice('neon.'.length),
    objectType: data.objectType ?? inferObjectType(eventType),
    objectId,
    occurredAt: event.occurredAt ?? data.occurredAt ?? '',
    currentState: data.current_state ?? record.current_state,
    record,
  };
}
```

Dedup fingerprints are unchanged from the first addendum (operations/advisor
`neon:${eventType}:${objectId}`; endpoint
`neon:endpoint.state_changed:${objectId}:${current_state}:${occurredAt}`).

### C4 — `ctx.llm.complete()` has no `system` option

`@agentworkforce/runtime@4.1.4` types `LlmContext.complete(prompt, { maxTokens? })`
— there is no `system` field. The chat path folds its system guidance into the
prompt as a preamble (`complete(`${SYSTEM}\n\n${userMessage}`)`). The earlier
`{ system }` call was a typecheck failure (part of PR #71's open CI feedback).

### Status at this checkpoint

- **Step 1 (adapters):** ✅ done — `normalizeNeonSyncDelta()` + `_relayfile_transition`
  + negative tests + catalog regen; no version bumps.
- **Step 2 (cloud):** in progress — VFS-watch dispatch reshaped to the standard
  AgentEvent, sync-boundary transition enrichment, `provider-contracts.ts`
  `triggerEvents` wiring (gates `--dry-run` via strict preflight).
- **Step 3a (agents / this repo):** ✅ staged — `triggers.neon` = failed /
  endpoint / advisor (3, matches the deploy `--dry-run` checkpoint), cron dropped
  to `0 */2 * * *`, `handleNeonEvent` + `parseNeonEvent` + per-object-type
  fingerprint dedup, 7 unit tests (full suite 109/109 green). Persona unchanged.
  Deploy `--dry-run` gated on Step 2's provider-contracts wiring.
- **Step 3b (nightcto):** ✅ staged — `handleNeonTriggerV4`/`buildNeonTriggerSignal`
  re-pointed to `expand('full').data` per C3 (no `event.resource.id` shortcut).
  Gated on Step 2 for `--dry-run`.

### C5 — adapter publish gate (the real critical-path blocker now)

Step 1's normalizer + regenerated catalog are **merged-locally only**; npm still
serves the pre-Step-1 `@relayfile/adapter-core@0.3.58` / `@relayfile/adapter-neon@0.1.1`
(both published from PR #212, the *initial* adapter). So Cloud's installed packages
expose neither `KNOWN_TRIGGER_CATALOG.neon` nor `normalizeNeonSyncDelta`.

- **Cloud Step 2 dev (now):** consume local built tarballs — `@relayfile/adapter-core@0.3.58`
  and `@relayfile/adapter-neon@0.1.1` (.tgz from the adapters checkout) — and import
  `KNOWN_TRIGGER_CATALOG` from **`@relayfile/adapter-core/triggers`** and
  `normalizeNeonSyncDelta` from **`@relayfile/adapter-neon/webhook`** (declared subpaths).
  Do **not** hand-copy the 5 events into `provider-contracts.ts`.
- **Release gate (owner decision — human):** land the adapters Step 1 PR → run the
  repo publish workflow (it owns the version bump; no feature-PR bumps) → Cloud
  re-pins to the published version and drops the tarball dep. The deploy `--dry-run`
  / CI for 3a + 3b must run against the **published** version, not the file: dep.
