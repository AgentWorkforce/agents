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
}

// ── Memory shape ─────────────────────────────────────────────────────────────

interface MonitorMemory {
  lastAlertFingerprint?: string;
  lastScanAt?: string;
}

// ── Exports ──────────────────────────────────────────────────────────────────

export default defineAgent({
  // Every 15 minutes — frequent enough to surface a connection thrash before
  // it cascades (operations sync is every 10 minutes; 15 min gives one full
  // sync window of buffer before the next alert check).
  schedules: [{ name: 'neon-scan', cron: '*/15 * * * *', tz: 'UTC' }],

  handler: async (ctx, event) => {
    // Chat path: a relay message arrived — answer questions about Neon state.
    if (isRelaycastMessageEvent(event)) {
      await handleInboxMessage(ctx, event);
      return;
    }
    // Clock path: the full 15-minute state scan.
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
  const spendingAlertPct = Number(input(ctx, 'SPENDING_ALERT_PCT') ?? '80');

  const root = resolveMountRoot({});
  const signals = await evaluateSignals(ctx, root, failedOpsThreshold, wakingThreshold, spendingAlertPct);
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

// ── Signal evaluation ─────────────────────────────────────────────────────────

async function evaluateSignals(
  ctx: WorkforceCtx,
  mountRoot: string,
  failedOpsThreshold: number,
  wakingThreshold: number,
  spendingAlertPct: number,
): Promise<AlertSignals> {
  const [operations, endpoints, advisors, consumption, spendingLimits] = await Promise.all([
    readCollection<NeonOperation>(ctx, mountRoot, 'getOperations', OPERATIONS_INDEX),
    readCollection<NeonEndpoint>(ctx, mountRoot, 'getEndpoints', ENDPOINTS_INDEX),
    readCollection<NeonAdvisorIssue>(ctx, mountRoot, 'getAdvisors', ADVISORS_INDEX),
    readCollection<NeonProjectConsumption>(ctx, mountRoot, 'getConsumption', PROJECT_CONSUMPTION_INDEX),
    readCollection<NeonSpendingLimit>(ctx, mountRoot, 'getSpendingLimits', SPENDING_LIMITS_INDEX),
  ]);

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

  // Spending limit issues.
  const spendingIssues: string[] = [];
  for (const limit of spendingLimits) {
    if (limit.fetch_status === 'forbidden') continue; // plan doesn't expose it
    if (limit.spending_limit_cents == null || limit.spending_limit_cents === 0) {
      spendingIssues.push(`org ${limit.org_id ?? 'unknown'}: no spending limit set`);
    }
    // CU consumption check against spending limit would require cross-join
    // with consumption data — deferred; covered by advisor issues instead.
  }

  // CU spike detection: flag projects whose compute_unit_seconds is unusually
  // high. The adapter includes current-period totals in the consumption record.
  // We surface any project above 1 million CU-seconds (~278 compute hours) as
  // a potential runaway — agents running continuous queries or pooling issues
  // typically appear here.
  const CU_SPIKE_THRESHOLD = 1_000_000;
  for (const project of consumption) {
    const cu = project.compute_unit_seconds;
    if (typeof cu === 'number' && cu > CU_SPIKE_THRESHOLD) {
      spendingIssues.push(
        `project ${project.project_id ?? 'unknown'}: high CU-seconds (${cu.toLocaleString()})`
      );
    }
  }

  return {
    failedOps: alertFailedOps,
    wakingEndpoints: alertWakingEndpoints,
    advisorErrors,
    advisorWarns,
    spendingIssues,
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
  const [operations, endpoints, advisors, projects, consumption, spendingLimits] = await Promise.all([
    readCollection<NeonOperation>(ctx, root, 'getOperations', OPERATIONS_INDEX),
    readCollection<NeonEndpoint>(ctx, root, 'getEndpoints', ENDPOINTS_INDEX),
    readCollection<NeonAdvisorIssue>(ctx, root, 'getAdvisors', ADVISORS_INDEX),
    readCollection<Record<string, unknown>>(ctx, root, 'getProjects', PROJECTS_INDEX),
    readCollection<NeonProjectConsumption>(ctx, root, 'getConsumption', PROJECT_CONSUMPTION_INDEX),
    readCollection<NeonSpendingLimit>(ctx, root, 'getSpendingLimits', SPENDING_LIMITS_INDEX),
  ]);

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
  const reply = await ctx.llm.complete(userMessage, { system: CHAT_SYSTEM_PROMPT });

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
): Promise<T[]> {
  try {
    const index = await readJsonFile({ relayfileMountRoot: mountRoot }, 'neon', tag, indexPath) as { items?: T[] } | T[] | null;
    if (!index) return [];
    if (Array.isArray(index)) return index;
    if (Array.isArray((index as { items?: T[] }).items)) return (index as { items: T[] }).items;
    return [];
  } catch {
    // VFS path not yet synced — return empty rather than crashing the scan.
    return [];
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
  const v = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  return typeof v === 'string' && v.trim() ? v : undefined;
}

async function loadMemory(ctx: WorkforceCtx): Promise<MonitorMemory> {
  try {
    const raw = await ctx.memory.recall('neon-monitor-state');
    return (raw as MonitorMemory | null) ?? {};
  } catch {
    return {};
  }
}

async function saveMemory(ctx: WorkforceCtx, state: MonitorMemory): Promise<void> {
  await ctx.memory.save('neon-monitor-state', state);
}
