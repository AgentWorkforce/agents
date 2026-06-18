# Spec: Neon sync-delta webhook triggers

**Status:** Ready for implementation  
**Depends on:** AgentWorkforce/cloud#2266 (neon-relay), AgentWorkforce/agents#71 (neon-monitor)  
**Repos touched:** `cloud`, `relayfile-adapters`, `agents`  
**Effort:** ~3 days across all repos

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

The repos must be done in this order. Each step is a merge gate for the next:

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

Step 3: agents (depends on step 2)
  └─ Add triggers to neon-monitor/agent.ts
  └─ Add handleNeonEvent function
  └─ Reduce cron from */15 to 0 */2 (triggers cover hot path)
  └─ Update persona.ts if trigger scope needs widening
  └─ Deploy: agentworkforce deploy neon-monitor/persona.ts --mode cloud --on-exists update
```

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

### agents
- Unit test `handleNeonEvent` with a mock `operation.failed` event payload → assert `slackClient().post()` called with message containing the action and project id
- Unit test `handleNeonEvent` with `endpoint.state_changed` and `waking` state → assert Slack post fires
- `agentworkforce deploy neon-monitor/persona.ts --mode cloud --dry-run` → asserts 2 integrations, 1 schedule, 3 triggers

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

### agents
| File | Change |
|---|---|
| `neon-monitor/agent.ts` | Add `triggers`, `handleNeonEvent`, reduce cron to 2h |
| `neon-monitor/persona.ts` | No change expected |

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
