/**
 * neon-monitor handler.
 *
 *   on each tick (every 15 min, aligned to the Nango operations sync)
 *     → read Neon state from the relayfile VFS mounts (no Neon token):
 *         /neon/operations/_index.json    recent DB operations (failed count)
 *         /neon/endpoints/_index.json     compute endpoints (waking/thrashing)
 *         /neon/advisors/_index.json      advisor issues (ERROR/WARN level)
 *         /neon/consumption/projects/_index.json  per-project CU consumption
 *         /neon/spending-limits/_index.json       org spending limit
 *     → evaluate signals (failed ops spike, endpoint thrash, advisor issues,
 *       CU spike, spending limit absent/exceeded)
 *     → post ONE concise Slack alert if any signal fires; stay silent otherwise
 *       and never re-alert an unchanged condition.
 *
 * Motivation: the ai-hist pooling incident (2026-06-16) — CF Worker WebSocket
 * Neon connections terminated unexpectedly. The repeated start_compute failures
 * in the operations feed would have surfaced this 30+ minutes before the
 * service degradation became user-visible.
 */
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  readJsonFile,
  resolveMountRoot,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

// VFS mount paths materialized by @relayfile/adapter-neon (via neon-relay).
// Paths match neonOperationsIndexPath(), neonEndpointsIndexPath(), etc.
const NEON_ROOT = '/neon';
const OPERATIONS_INDEX = `${NEON_ROOT}/operations/_index.json`;
const ENDPOINTS_INDEX = `${NEON_ROOT}/endpoints/_index.json`;
const ADVISORS_INDEX = `${NEON_ROOT}/advisors/_index.json`;
const PROJECT_CONSUMPTION_INDEX = `${NEON_ROOT}/consumption/projects/_index.json`;
const SPENDING_LIMITS_INDEX = `${NEON_ROOT}/spending-limits/_index.json`;
const PROJECTS_INDEX = `${NEON_ROOT}/projects/_index.json`;

// States that indicate an endpoint is in a problematic wake cycle.
// "waking" → start_compute was triggered; if it keeps appearing the
// endpoint is thrashing between suspended and waking.
const THRASH_STATES = new Set(['waking', 'init']);

// ── Types (subset of what the adapter materializes) ─────────────────────────

export interface NeonOperation {
  id?: string;
  project_id?: string;
  action?: string;
  status?: string;
  error?: string;
  failures_count?: number;
  created_at?: string;
  total_duration_ms?: number;
}

export interface NeonEndpoint {
  id?: string;
  project_id?: string;
  branch_id?: string;
  host?: string;
  type?: string;
  current_state?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NeonAdvisorIssue {
  name?: string;
  title?: string;
  level?: string;
  facing?: string;
  description?: string;
  remediation?: string;
}

export interface NeonProjectConsumption {
  project_id?: string;
  compute_unit_seconds?: number;
  [key: string]: unknown;
}

export interface NeonSpendingLimit {
  org_id?: string;
  spending_limit_cents?: number | null;
  fetch_status?: string;
}

export interface IndexEntry {
  path?: string;
  [key: string]: unknown;
}

// ── Alert signal shape ───────────────────────────────────────────────────────

interface AlertSignals {
  failedOps: NeonOperation[];
  wakingEndpoints: NeonEndpoint[];
  advisorErrors: NeonAdvisorIssue[];
  advisorWarns: NeonAdvisorIssue[];
  spendingIssues: string[];
  /** False when NO neon index materialized into the VFS — data-plane gap, not "all clear". */
  vfsPresent: boolean;
}

// ── Memory shape ─────────────────────────────────────────────────────────────

interface MonitorMemory {
  lastAlertFingerprint?: string;
  lastScanAt?: string;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export default defineAgent({
  // Full-state sweep every 2 hours. Triggers (below) now cover the hot path —
  // failed ops / endpoint transitions / advisor issues fire in real time — so
  // the cron only needs to catch the FULL-STATE signals that have no per-record
  // delta event: CU-consumption spikes and absent/exceeded spending limits.
  schedules: [{ name: 'neon-scan', cron: '0 */2 * * *', tz: 'UTC' }],

  // Real-time: subscribe to the frozen sync-delta events the neon-relay
  // normalizer emits (relayfile-adapters `normalizeNeonSyncDelta()` →
  // cloud sync-hook → gateway). The runtime surfaces them as
  // `event.type === 'neon.<object>.<action>'`. Free-tier set = the three
  // immediately-actionable deltas; `operation.cancelled` and the full-state
  // `spending-limit.missing` / `consumption.threshold` signals stay on the
  // cron sweep (the paid `nightcto/watch` tier subscribes to the wider set).
  triggers: {
    neon: [
      { on: 'operation.failed' },
      { on: 'endpoint.state_changed' },
      { on: 'advisor.issue_raised' }
    ]
  },

  handler: async (ctx, event) => {
    // Chat path: a relay message arrived — answer questions about Neon state.
    if (isRelaycastMessageEvent(event)) {
      await handleInboxMessage(ctx, event);
      return;
    }
    // Real-time path: a Neon sync-delta event arrived — alert the moment the
    // operations sync detects a new failure instead of waiting for the sweep.
    if (isNeonDeltaEvent(event)) {
      await handleNeonEvent(ctx, event);
      return;
    }
    // Clock path: the full state sweep (every 2h).
    if (isCronTickEvent(event)) {
      await handleScan(ctx);
      return;
    }
  }
});

// ── Scan handler ─────────────────────────────────────────────────────────────

async function handleScan(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log?.('warn', 'neon-monitor.no-channel', { reason: 'SLACK_CHANNEL not set; skipping alert' });
    return;
  }

  const failedOpsThreshold = Number(input(ctx, 'FAILED_OPS_THRESHOLD') ?? '3');
  const wakingThreshold = Number(input(ctx, 'WAKING_ENDPOINTS_THRESHOLD') ?? '2');

  const root = resolveMountRoot({});
  const signals = await evaluateSignals(ctx, root, failedOpsThreshold, wakingThreshold);

  // Data-plane guard: if NONE of the neon indexes materialized into the VFS, the
  // agent is scanning an empty `/neon` mount — the Nango→relayfile data never
  // reached the agent — not a genuine all-clear. Surface it ONCE (deduped via the
  // existing fingerprint memory) instead of logging `scan-clean` and going silent
  // for days, which is exactly how this failure hid before. Tracked in cloud#2530.
  if (!signals.vfsPresent) {
    const fingerprint = 'neon:vfs-not-materialized';
    const mem = await loadMemory(ctx);
    if (mem.lastAlertFingerprint === fingerprint) {
      ctx.log?.('warn', 'neon-monitor.vfs-empty-unchanged', {
        reason: 'neon VFS still un-materialized since last scan; staying silent'
      });
      return;
    }
    const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(
      channel,
      ":warning: *Neon monitor* is scanning an empty `/neon` mount — no operations, "
        + "endpoint, or advisor data has reached the relayfile VFS from Nango "
        + "(data-plane gap, tracked in cloud#2530). Alerts are paused until sync data lands."
    );
    if (!result?.ts) {
      ctx.log?.('error', 'neon-monitor.post-failed', {
        reason: 'Slack writeback returned empty ts while reporting empty VFS'
      });
      throw new Error('Slack post returned no receipt ts; treating as delivery failure');
    }
    await saveMemory(ctx, { lastAlertFingerprint: fingerprint, lastScanAt: new Date().toISOString() });
    ctx.log?.('warn', 'neon-monitor.vfs-empty', { ts: result.ts });
    return;
  }

  const hasAlerts = signals.failedOps.length > 0
    || signals.wakingEndpoints.length > 0
    || signals.advisorErrors.length > 0
    || signals.advisorWarns.length > 0
    || signals.spendingIssues.length > 0;

  if (!hasAlerts) {
    ctx.log?.('info', 'neon-monitor.scan-clean', { at: new Date().toISOString() });
    return;
  }

  // De-duplicate: build a fingerprint of what's firing and compare to
  // the last alerted state. Only post when the fingerprint changes.
  const fingerprint = buildFingerprint(signals);
  const mem = await loadMemory(ctx);

  if (mem.lastAlertFingerprint === fingerprint) {
    ctx.log?.('info', 'neon-monitor.unchanged', {
      fingerprint,
      reason: 'signals unchanged since last alert; staying silent'
    });
    return;
  }

  const message = formatAlertMessage(signals);
  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, message);

  if (!result?.ts) {
    ctx.log?.('error', 'neon-monitor.post-failed', {
      reason: 'Slack writeback returned empty ts — path may not be mounted'
    });
    throw new Error('Slack post returned no receipt ts; treating as delivery failure');
  }

  await saveMemory(ctx, { lastAlertFingerprint: fingerprint, lastScanAt: new Date().toISOString() });
  ctx.log?.('info', 'neon-monitor.alerted', { ts: result.ts, fingerprint });
}

// ── Real-time sync-delta event handler ────────────────────────────────────────

// v4 runtime delivers provider triggers as a standard AgentEvent whose `type`
// is `provider.object.action`. Neon deltas are `neon.operation.failed`,
// `neon.endpoint.state_changed`, `neon.advisor.issue_raised`.
function isNeonDeltaEvent(event: AgentEvent): boolean {
  return typeof event.type === 'string' && event.type.startsWith('neon.');
}

/** Normalized view of a Neon sync-delta event, read from the v4 envelope. */
export interface ParsedNeonEvent {
  /** Unprefixed contract event type, e.g. `operation.failed`. */
  eventType: string;
  /** `operation` | `endpoint` | `advisor-issue`. */
  objectType: string;
  /** Stable object identity (advisor uses `cache_key`). */
  objectId: string;
  /** Provider/Nango time — never handler receipt time. */
  occurredAt: string;
  /** Endpoint current_state (only set for endpoint events). */
  currentState?: string;
  /** The normalized provider record (status, project_id, title, etc.). */
  record: Record<string, unknown>;
}

/**
 * Read a Neon sync-delta event into the dedup/format-ready shape.
 *
 * Envelope reality (verified against `@agentworkforce/runtime`'s
 * `envelopeToAgentEvent`): the normalized object Cloud dispatches in
 * `env.resource` is exposed to handlers ONLY through `await event.expand('full')`
 * (its `.data`). The inline `event.resource` is rebuilt as a thin handle
 * `{ path, kind, id, provider }` whose `id` is the DELIVERY id — NOT the
 * objectId — so we must never read identity off `event.resource`. `event.type`
 * (`neon.<object>.<action>`) and `event.occurredAt` are the reliable top-level
 * fields. Returns `undefined` when there is no stable `objectId` — matching the
 * normalizer's "no stable id → no event" rule.
 */
export async function parseNeonEvent(event: AgentEvent): Promise<ParsedNeonEvent | undefined> {
  const type = typeof event.type === 'string' ? event.type : '';
  if (!type.startsWith('neon.')) return undefined;

  // The full normalized object lives in expand('full').data.
  let data: Record<string, unknown> = {};
  try {
    const full = (await event.expand('full')) as { data?: unknown } | undefined;
    if (full?.data && typeof full.data === 'object') data = full.data as Record<string, unknown>;
  } catch {
    // expansion is best-effort; an unexpandable event yields no stable id below.
  }

  const str = (...vals: unknown[]): string | undefined =>
    vals.find((v): v is string => typeof v === 'string' && v.length > 0);

  const record = (data.payload && typeof data.payload === 'object'
    ? data.payload
    : {}) as Record<string, unknown>;

  // objectId precedence: explicit objectId → record id → advisor cache_key →
  // raw record id. (NOT event.resource.id — that is the delivery id.)
  const objectId = str(data.objectId, data.id, record.cache_key, record.id);
  if (!objectId) return undefined;

  // eventType: prefer the normalized unprefixed field; else strip `neon.`.
  const eventType = str(data.eventType) ?? type.slice('neon.'.length);
  const objectType = str(data.objectType) ?? inferObjectType(eventType);
  const occurredAt = str(event.occurredAt, data.occurredAt as string, record.created_at as string) ?? '';
  const currentState = str(data.current_state, record.current_state);

  return { eventType, objectType, objectId, occurredAt, currentState, record };
}

function inferObjectType(eventType: string): string {
  if (eventType.startsWith('endpoint.')) return 'endpoint';
  if (eventType.startsWith('advisor.')) return 'advisor-issue';
  return 'operation';
}

/**
 * Per-object-type dedup fingerprint (frozen contract, addendum). Stable
 * identity — NOT handler time — so a replayed/retried delivery maps to the same
 * key. The endpoint key folds in state + time so a legitimate later transition
 * on the same endpoint (`idle→active→idle`) is not suppressed.
 */
export function neonEventFingerprint(p: ParsedNeonEvent): string {
  if (p.objectType === 'endpoint' || p.eventType.startsWith('endpoint.')) {
    return `neon:endpoint.state_changed:${p.objectId}:${p.currentState ?? 'unknown'}:${p.occurredAt}`;
  }
  if (p.objectType === 'advisor-issue' || p.eventType.startsWith('advisor.')) {
    return `neon:advisor.issue_raised:${p.objectId}`;
  }
  return `neon:${p.eventType}:${p.objectId}`;
}

async function handleNeonEvent(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log?.('warn', 'neon-monitor.no-channel', { reason: 'SLACK_CHANNEL not set; skipping event alert' });
    return;
  }

  const parsed = await parseNeonEvent(event);
  if (!parsed) {
    ctx.log?.('info', 'neon-monitor.event-unparsed', {
      type: event.type,
      reason: 'no stable objectId or not a neon delta'
    });
    return;
  }

  // Replay/retry dedup: skip an event whose fingerprint we have already alerted.
  const fingerprint = neonEventFingerprint(parsed);
  const seen = await loadEventDedup(ctx);
  if (seen.includes(fingerprint)) {
    ctx.log?.('info', 'neon-monitor.event-duplicate', { fingerprint, eventType: parsed.eventType });
    return;
  }

  const message = formatEventAlert(parsed);
  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, message);
  if (!result?.ts) {
    ctx.log?.('error', 'neon-monitor.event-post-failed', {
      fingerprint,
      reason: 'Slack writeback returned empty ts — path may not be mounted'
    });
    throw new Error(`Slack post returned no receipt for neon event ${parsed.eventType}`);
  }

  // Bounded ring of recent fingerprints — dedup without unbounded growth.
  await saveEventDedup(ctx, [...seen, fingerprint].slice(-200));
  ctx.log?.('info', 'neon-monitor.event-alerted', {
    eventType: parsed.eventType,
    fingerprint,
    ts: result.ts
  });
}

export function formatEventAlert(p: ParsedNeonEvent): string {
  const r = p.record;
  if (p.eventType === 'operation.failed' || p.eventType === 'operation.cancelled') {
    const verb = p.eventType === 'operation.cancelled' ? 'cancelled' : 'failed';
    const action = String(r.action ?? 'unknown');
    const project = String(r.project_id ?? 'unknown');
    const error = r.error ? ` — ${String(r.error).slice(0, 200)}` : '';
    const emoji = verb === 'failed' ? ':red_circle:' : ':warning:';
    return `${emoji} *Neon operation ${verb}*\n  \`${action}\` on project \`${project}\`${error}`;
  }
  if (p.eventType === 'endpoint.state_changed') {
    const host = String(r.host ?? p.objectId);
    const state = String(p.currentState ?? r.current_state ?? 'unknown');
    const project = r.project_id ? ` (project \`${String(r.project_id)}\`)` : '';
    return `:warning: *Neon endpoint state change*\n  \`${host}\`${project} → \`${state}\``;
  }
  if (p.eventType === 'advisor.issue_raised') {
    const title = String(r.title ?? r.name ?? 'unknown');
    const level = String(r.level ?? 'WARN');
    const emoji = level === 'ERROR' ? ':red_circle:' : ':warning:';
    const remediation = r.remediation ? `\n  ${String(r.remediation).slice(0, 200)}` : '';
    return `${emoji} *Neon advisor issue* (${level}): ${title}${remediation}`;
  }
  return `:warning: *Neon event*: \`${p.eventType}\` on \`${p.objectId}\``;
}

// ── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateSignals(
  ctx: WorkforceCtx,
  mountRoot: string,
  failedOpsThreshold: number,
  wakingThreshold: number,
): Promise<AlertSignals> {
  const [ops, eps, advs, cons, spend] = await Promise.all([
    readCollection<NeonOperation>(ctx, mountRoot, 'getOperations', OPERATIONS_INDEX),
    readCollection<NeonEndpoint>(ctx, mountRoot, 'getEndpoints', ENDPOINTS_INDEX),
    readCollection<NeonAdvisorIssue>(ctx, mountRoot, 'getAdvisors', ADVISORS_INDEX),
    readCollection<NeonProjectConsumption>(ctx, mountRoot, 'getConsumption', PROJECT_CONSUMPTION_INDEX),
    readCollection<NeonSpendingLimit>(ctx, mountRoot, 'getSpendingLimits', SPENDING_LIMITS_INDEX),
  ]);
  const operations = ops.items;
  const endpoints = eps.items;
  const advisors = advs.items;
  const consumption = cons.items;
  const spendingLimits = spend.items;
  // The `/neon` mount is "present" if the adapter has materialized at least one
  // index. All-absent means the Nango→relayfile materialization never landed and
  // the agent is scanning an empty mount — a data-plane failure, NOT "all clear"
  // (tracked in cloud#2266). handleScan surfaces this instead of going silent.
  const vfsPresent = ops.materialized || eps.materialized || advs.materialized
    || cons.materialized || spend.materialized;

  // Failed operations: status === 'failed' OR failures_count > 0 with error.
  const failedOps = operations.filter((op) =>
    op.status === 'failed' || (op.failures_count != null && op.failures_count > 0 && op.error)
  );

  // Surface only when the count exceeds the configured threshold — avoids
  // alerting on a single transient failed op during normal Neon suspend/wake.
  const alertFailedOps = failedOps.length >= failedOpsThreshold ? failedOps : [];

  // Waking/thrashing endpoints: current_state in { waking, init }
  const wakingEndpoints = endpoints.filter((ep) =>
    ep.current_state && THRASH_STATES.has(ep.current_state)
  );
  const alertWakingEndpoints = wakingEndpoints.length >= wakingThreshold ? wakingEndpoints : [];

  // Advisor issues at ERROR or WARN level.
  const advisorErrors = advisors.filter((issue) => issue.level === 'ERROR');
  const advisorWarns = advisors.filter((issue) => issue.level === 'WARN');

  // CU spike: projects above 1M CU-seconds (~278 compute hours) are flagged
  // as potential runaways. Only alert when no spending limit is set AND
  // consumption is high — avoids permanent noise for orgs that simply haven't
  // configured a cap but are well within normal usage.
  const CU_SPIKE_THRESHOLD = 1_000_000;
  const highCuProjects = consumption.filter((p) =>
    typeof p.compute_unit_seconds === 'number' && p.compute_unit_seconds > CU_SPIKE_THRESHOLD
  );

  const spendingIssues: string[] = [];
  for (const limit of spendingLimits) {
    if (limit.fetch_status === 'forbidden') continue; // plan doesn't expose it
    const noLimit = limit.spending_limit_cents == null || limit.spending_limit_cents === 0;
    if (noLimit && highCuProjects.length > 0) {
      // Only alert when there is active high consumption to go with the missing cap.
      spendingIssues.push(
        `org ${limit.org_id ?? 'unknown'}: no spending limit set with ${highCuProjects.length} high-consumption project(s)`
      );
    }
  }

  for (const project of highCuProjects) {
    spendingIssues.push(
      `project ${project.project_id ?? 'unknown'}: high CU-seconds (${(project.compute_unit_seconds as number).toLocaleString()})`
    );
  }

  return {
    failedOps: alertFailedOps,
    wakingEndpoints: alertWakingEndpoints,
    advisorErrors,
    advisorWarns,
    spendingIssues,
    vfsPresent,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatAlertMessage(signals: AlertSignals): string {
  const lines: string[] = [':warning: *Neon infrastructure alert*'];

  if (signals.failedOps.length > 0) {
    lines.push('');
    lines.push(`*Failed operations* (${signals.failedOps.length})`);
    for (const op of signals.failedOps.slice(0, 5)) {
      const action = op.action ?? 'unknown';
      const project = op.project_id ?? 'unknown';
      const err = op.error ? ` — ${op.error.slice(0, 120)}` : '';
      lines.push(`  • \`${action}\` on project \`${project}\`${err}`);
    }
    if (signals.failedOps.length > 5) {
      lines.push(`  • … and ${signals.failedOps.length - 5} more`);
    }
  }

  if (signals.wakingEndpoints.length > 0) {
    lines.push('');
    lines.push(`*Endpoints stuck waking/init* (${signals.wakingEndpoints.length})`);
    for (const ep of signals.wakingEndpoints.slice(0, 5)) {
      const host = ep.host ?? ep.id ?? 'unknown';
      const project = ep.project_id ?? 'unknown';
      lines.push(`  • \`${host}\` (project \`${project}\`, state: \`${ep.current_state}\`)`);
    }
  }

  if (signals.advisorErrors.length > 0) {
    lines.push('');
    lines.push(`*Advisor errors* (${signals.advisorErrors.length})`);
    for (const issue of signals.advisorErrors.slice(0, 5)) {
      lines.push(`  • *${issue.title ?? issue.name ?? 'unknown'}* — ${issue.description?.slice(0, 100) ?? ''}`);
    }
  }

  if (signals.advisorWarns.length > 0) {
    lines.push('');
    lines.push(`*Advisor warnings* (${signals.advisorWarns.length})`);
    for (const issue of signals.advisorWarns.slice(0, 3)) {
      lines.push(`  • ${issue.title ?? issue.name ?? 'unknown'}`);
    }
    if (signals.advisorWarns.length > 3) {
      lines.push(`  • … and ${signals.advisorWarns.length - 3} more`);
    }
  }

  if (signals.spendingIssues.length > 0) {
    lines.push('');
    lines.push('*Spending / consumption issues*');
    for (const issue of signals.spendingIssues) {
      lines.push(`  • ${issue}`);
    }
  }

  return lines.join('\n');
}

function buildFingerprint(signals: AlertSignals): string {
  // Sort each list so the fingerprint is stable regardless of API return order.
  const parts = [
    signals.failedOps.map((op) => `f:${op.id ?? op.action}`).sort().join(','),
    signals.wakingEndpoints.map((ep) => `e:${ep.id}`).sort().join(','),
    signals.advisorErrors.map((a) => `ae:${a.name}`).sort().join(','),
    signals.advisorWarns.map((a) => `aw:${a.name}`).sort().join(','),
    signals.spendingIssues.sort().join(','),
  ];
  return parts.filter(Boolean).join('|');
}

// ── Chat handler ──────────────────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `You are a knowledgeable Neon database assistant with access to live infrastructure data for this organization. You can answer questions about:

- **Projects** — names, regions, creation dates, org membership
- **Branches** — which branches exist per project, their state, parent/child relationships
- **Endpoints** — compute endpoint state (active, suspended, waking), host addresses, type (read_write / read_only)
- **Operations** — recent database operations, their status (running, finished, failed), duration, error details
- **Advisor issues** — performance/security recommendations at ERROR, WARN, or INFO level, with remediation steps
- **Consumption** — compute-unit-seconds consumed per project, storage, network transfer
- **Spending limits** — whether a spending cap is set on the organization

When answering:
- Use Slack mrkdwn formatting (*bold*, \`code\`, bullet lists).
- Be specific — quote project IDs, operation IDs, or host names when they are relevant.
- If the data doesn't contain enough detail to answer, say so and suggest what the user should check in the Neon console.
- If there are active alerts (failed ops, waking endpoints, advisor errors), proactively surface them even if the user didn't ask.
- Keep responses concise — prefer a tight bullet list over a long paragraph.`;

async function handleInboxMessage(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');

  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const question = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  if (!question.trim()) {
    ctx.log?.('info', 'neon-monitor.relaycast-empty', { reason: 'no text in message; skipping' });
    return;
  }

  const root = resolveMountRoot({});

  // Load all data in parallel — the LLM gets the full picture so it can
  // answer cross-cutting questions (e.g. "which projects are consuming the
  // most compute?" requires both projects + consumption).
  const [opsRes, epsRes, advsRes, projRes, consRes, spendRes] = await Promise.all([
    readCollection<NeonOperation>(ctx, root, 'getOperations', OPERATIONS_INDEX),
    readCollection<NeonEndpoint>(ctx, root, 'getEndpoints', ENDPOINTS_INDEX),
    readCollection<NeonAdvisorIssue>(ctx, root, 'getAdvisors', ADVISORS_INDEX),
    readCollection<Record<string, unknown>>(ctx, root, 'getProjects', PROJECTS_INDEX),
    readCollection<NeonProjectConsumption>(ctx, root, 'getConsumption', PROJECT_CONSUMPTION_INDEX),
    readCollection<NeonSpendingLimit>(ctx, root, 'getSpendingLimits', SPENDING_LIMITS_INDEX),
  ]);
  const operations = opsRes.items;
  const endpoints = epsRes.items;
  const advisors = advsRes.items;
  const projects = projRes.items;
  const consumption = consRes.items;
  const spendingLimits = spendRes.items;

  // Surface the active alert state so the LLM can reference it even if the
  // user's question isn't about alerts.
  const failedOps = operations.filter((op) => op.status === 'failed' || (op.failures_count != null && op.failures_count > 0));
  const wakingEndpoints = endpoints.filter((ep) => ep.current_state && THRASH_STATES.has(ep.current_state));
  const activeAdvisorErrors = advisors.filter((a) => a.level === 'ERROR');

  const activeAlertsSummary = [
    failedOps.length > 0 ? `${failedOps.length} failed operation(s)` : null,
    wakingEndpoints.length > 0 ? `${wakingEndpoints.length} endpoint(s) in waking/init state` : null,
    activeAdvisorErrors.length > 0 ? `${activeAdvisorErrors.length} advisor error(s)` : null,
  ].filter(Boolean);

  const userMessage = [
    activeAlertsSummary.length > 0
      ? `[Active alerts: ${activeAlertsSummary.join(', ')}]\n`
      : '[No active alerts at this time]\n',
    '## Projects',
    JSON.stringify(projects.slice(0, 30), null, 2),
    '',
    `## Operations (${operations.length} total — showing most recent 50)`,
    JSON.stringify(operations.slice(0, 50).map(compactOp), null, 2),
    '',
    `## Endpoints (${endpoints.length})`,
    JSON.stringify(endpoints.map(compactEndpoint), null, 2),
    '',
    `## Advisor issues (${advisors.length})`,
    JSON.stringify(advisors, null, 2),
    '',
    `## Consumption (${consumption.length} projects)`,
    JSON.stringify(consumption.slice(0, 20), null, 2),
    '',
    `## Spending limits`,
    JSON.stringify(spendingLimits, null, 2),
    '',
    `## User question\n${question}`,
  ].join('\n');

  // ctx.llm.complete() is a direct LLM completion — no harness subprocess,
  // no coding environment. It uses the deployer's subscription credential
  // (useSubscription: true on persona). This is the right tool for Q&A
  // over structured data; ctx.harness.run() is for agentic coding tasks.
  // The runtime's LlmContext.complete() takes only { maxTokens } — there is no
  // `system` option — so the system guidance rides as a preamble on the prompt.
  const reply = await ctx.llm.complete(`${CHAT_SYSTEM_PROMPT}\n\n${userMessage}`);

  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, reply);
  if (!result?.ts) {
    ctx.log?.('error', 'neon-monitor.chat-post-failed', { reason: 'Slack post returned no receipt' });
    throw new Error('Slack post returned no receipt ts after chat reply');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readCollection<T>(
  ctx: WorkforceCtx,
  mountRoot: string,
  tag: string,
  indexPath: string,
): Promise<{ items: T[]; materialized: boolean }> {
  try {
    const index = await readJsonFile({ relayfileMountRoot: mountRoot }, 'neon', tag, indexPath) as { items?: T[] } | T[] | null;
    // `null` = the adapter hasn't materialized this index into the VFS yet.
    // An empty array = index present but no records; that DOES count as
    // materialized (real "all clear"), which is why we track it separately.
    if (index == null) return { items: [], materialized: false };
    if (Array.isArray(index)) return { items: index, materialized: true };
    if (Array.isArray((index as { items?: T[] }).items)) return { items: (index as { items: T[] }).items, materialized: true };
    return { items: [], materialized: true };
  } catch {
    // VFS path not yet synced / unreadable — treat as un-materialized rather
    // than crashing the scan.
    return { items: [], materialized: false };
  }
}

function compactOp(op: NeonOperation) {
  return {
    id: op.id, action: op.action, status: op.status,
    error: op.error, failures_count: op.failures_count,
    created_at: op.created_at, total_duration_ms: op.total_duration_ms
  };
}

function compactEndpoint(ep: NeonEndpoint) {
  return {
    id: ep.id, host: ep.host, type: ep.type,
    current_state: ep.current_state, project_id: ep.project_id
  };
}

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}

async function loadMemory(ctx: WorkforceCtx): Promise<MonitorMemory> {
  try {
    const [item] = await ctx.memory.recall('neon monitor state', { tags: ['neon-monitor:state'], limit: 1 });
    return item ? (JSON.parse(item.content) as MonitorMemory) : {};
  } catch {
    return {};
  }
}

async function saveMemory(ctx: WorkforceCtx, state: MonitorMemory): Promise<void> {
  await ctx.memory.save(JSON.stringify(state), { tags: ['neon-monitor:state'], scope: 'workspace' });
}

// Real-time event dedup is kept in its own memory record so the cron sweep's
// state (lastAlertFingerprint) and the trigger path never clobber each other.
async function loadEventDedup(ctx: WorkforceCtx): Promise<string[]> {
  try {
    const [item] = await ctx.memory.recall('neon event dedup', { tags: ['neon-monitor:event-dedup'], limit: 1 });
    if (!item) return [];
    const parsed = JSON.parse(item.content) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

async function saveEventDedup(ctx: WorkforceCtx, fingerprints: string[]): Promise<void> {
  await ctx.memory.save(JSON.stringify(fingerprints), { tags: ['neon-monitor:event-dedup'], scope: 'workspace' });
}
