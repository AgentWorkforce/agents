/**
 * gcp-watcher handler.
 *
 *   on each tick (or a Monitoring webhook)
 *     → read GCP state from the relayfile VFS mounts (no GCP token):
 *         /gcp/run/services/**        Cloud Run services
 *         /gcp/monitoring/alerts/**   Monitoring alert policies / incidents
 *         /gcp/billing/current.json   current-period spend
 *     → evaluate signals (service not Ready, firing alert, spend over threshold)
 *     → post ONE concise Slack alert if any signal fires; stay silent otherwise
 *       and never re-alert an unchanged condition.
 *
 * BASIC (free) tier: VFS only. Deep OTel/historical analysis from BigQuery is
 * the paid tier that lives inside nightcto and is gated for paying customers —
 * intentionally NOT done here.
 */
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  readJsonFile,
  resolveMountRoot,
  type AgentEvent,
  type IntegrationClientOptions,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

// VFS mount paths materialized by @relayfile/adapter-gcp (kept as string
// constants rather than importing adapter helpers so this stays decoupled).
const SERVICES_INDEX = '/gcp/run/services/_index.json';
const ALERTS_INDEX = '/gcp/monitoring/alerts/_index.json';
const BILLING_PATH = '/gcp/billing/current.json';

export interface GcpService {
  name?: string;
  region?: string;
  ready?: boolean;
  latestRevision?: string;
  url?: string;
  lastModified?: string;
}
export interface GcpAlert {
  policyId?: string;
  displayName?: string;
  firing?: boolean;
  conditionName?: string;
  startedAt?: string;
}
export interface GcpBilling {
  billingAccountId?: string;
  open?: boolean;
  currency?: string;
  /** Current-period spend, if the billing mount exposes it. */
  amount?: number;
}

const DEFAULT_PROJECT_ID = 'nightcto-production';

export default defineAgent({
  // Hourly — frequent enough to catch an unhealthy revision or cost spike,
  // cheap enough to ignore.
  schedules: [{ name: 'gcp-scan', cron: '0 * * * *', tz: 'America/New_York' }],
  // Real-time: GCP Monitoring alert notifications delivered via Pub/Sub and
  // normalized by @relayfile/adapter-gcp's webhook-normalizer into
  // `monitoring.incident.open` / `monitoring.incident.closed`. They surface to
  // the handler as `event.type === 'gcp.monitoring.incident.open'` etc.
  triggers: {
    gcp: [{ on: 'monitoring.incident.open' }, { on: 'monitoring.incident.closed' }]
  },
  handler: async (ctx, event) => {
    // Chat path: a relay message arrived — answer questions about GCP state.
    if (isRelaycastMessageEvent(event)) {
      await handleInboxMessage(ctx, event);
      return;
    }
    // Real-time path: a Monitoring incident webhook — alert the moment a policy
    // fires, instead of waiting for the next hourly tick.
    if (isGcpMonitoringEvent(event)) {
      await handleMonitoringWebhook(ctx, event);
      return;
    }
    // Clock path: the full hourly state scan.
    if (isCronTickEvent(event)) {
      await handleScan(ctx);
      return;
    }
  }
});

/**
 * Chat handler: when someone messages the agent via relay inbox, read current
 * GCP state from the VFS and use the LLM to answer conversationally.
 */
async function handleInboxMessage(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const project = input(ctx, 'GCP_PROJECT_ID') ?? DEFAULT_PROJECT_ID;

  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const question = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  if (!question.trim()) {
    ctx.log?.('info', 'relaycast message with no text; skipping');
    return;
  }

  const services = await readCollection<GcpService>(ctx, 'getServices', SERVICES_INDEX);
  const alerts = await readCollection<GcpAlert>(ctx, 'getAlerts', ALERTS_INDEX);
  const billing = await readBilling(ctx);

  const prompt = [
    "You are a GCP infrastructure monitor. Answer the user's question about the current GCP project state using the data below.",
    'Be concise and specific. Use Slack markdown formatting.',
    '',
    `## Cloud Run services (project ${project})`,
    JSON.stringify(services, null, 2),
    '',
    '## Monitoring alert policies',
    JSON.stringify(alerts, null, 2),
    '',
    '## Billing',
    JSON.stringify(billing ?? 'unavailable', null, 2),
    '',
    '## User Question',
    question
  ].join('\n');

  const answer = await ctx.llm.complete(prompt, { maxTokens: 1024 });

  const res = await slackClient().post(channel, answer);
  if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
}

/** True for a GCP Monitoring incident webhook event (`gcp.monitoring.incident.*`). */
function isGcpMonitoringEvent(event: AgentEvent): boolean {
  return typeof event.type === 'string' && event.type.startsWith('gcp.monitoring.');
}

/**
 * Real-time webhook handler. On a Monitoring incident we re-read the alert
 * mount (falling back to the webhook payload), run it through the same signal
 * formatting as the hourly scan, and post immediately only when an alert is
 * firing. A closed/resolved incident produces no alert — we stay silent.
 */
async function handleMonitoringWebhook(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const project = input(ctx, 'GCP_PROJECT_ID') ?? DEFAULT_PROJECT_ID;

  const fromPayload = await extractAlert(event);
  const alerts = fromPayload ? [fromPayload] : await readCollection<GcpAlert>(ctx, 'getAlerts', ALERTS_INDEX);

  const { alerts: lines } = evaluateSignals([], alerts, undefined, {
    billingAlertUsd: numInput(ctx, 'BILLING_ALERT_USD', 500)
  });
  if (lines.length === 0) {
    ctx.log?.('info', 'gcp monitoring webhook: no firing alert', { type: event.type });
    return;
  }

  const res = await slackClient().post(
    channel,
    `:satellite: *GCP watcher* (real-time) — project \`${project}\`\n${lines.join('\n')}`
  );
  if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
}

/** Pull the alert record carried in the webhook envelope (`expand('full')`). */
async function extractAlert(event: AgentEvent): Promise<GcpAlert | undefined> {
  try {
    const full = (await event.expand('full')) as { data?: unknown } | undefined;
    const data = full?.data;
    if (data && typeof data === 'object') return normalizeAlert(data as Record<string, unknown>);
  } catch {
    // expansion is best-effort; fall through to the VFS read.
  }
  return undefined;
}

/** Coerce a raw Monitoring incident webhook record into our canonical shape. */
function normalizeAlert(raw: Record<string, unknown>): GcpAlert {
  const str = (...vals: unknown[]): string | undefined =>
    vals.find((v): v is string => typeof v === 'string' && v.length > 0);
  const state = str(raw.state, raw.newState);
  return {
    policyId: str(raw.policyId, raw.policy_name, raw.policyName),
    displayName: str(raw.displayName, raw.display_name, raw.conditionName, raw.condition_name),
    firing: state ? state.toLowerCase() === 'open' : raw.firing === true,
    conditionName: str(raw.conditionName, raw.condition_name),
    startedAt: str(raw.startedAt, raw.started_at)
  };
}

/** The hourly full state scan. */
async function handleScan(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const project = input(ctx, 'GCP_PROJECT_ID') ?? DEFAULT_PROJECT_ID;
  const billingAlertUsd = numInput(ctx, 'BILLING_ALERT_USD', 500);

  const services = await readCollection<GcpService>(ctx, 'getServices', SERVICES_INDEX);
  const alerts = await readCollection<GcpAlert>(ctx, 'getAlerts', ALERTS_INDEX);
  const billing = await readBilling(ctx);

  const last = await loadSnapshot(ctx);
  const { alerts: lines } = evaluateSignals(services, alerts, billing, { billingAlertUsd });

  // Dedupe: only post when the alert *set* changed since we last alerted.
  const signature = lines.slice().sort().join('\n');
  if (lines.length > 0 && signature !== last?.signature) {
    const res = await slackClient().post(
      channel,
      `:satellite: *GCP watcher* — project \`${project}\`\n${lines.join('\n')}`
    );
    if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
  }

  await saveSnapshot(ctx, { signature: lines.length > 0 ? signature : '' });
}

export interface SignalOptions {
  /** Alert when current-period spend reaches this many USD. */
  billingAlertUsd: number;
}

/**
 * Pure signal evaluation — given the Cloud Run services, alert policies, and
 * billing record, return the Slack alert lines. No IO, no clock access, so it
 * is fully unit-testable.
 */
export function evaluateSignals(
  services: GcpService[],
  alerts: GcpAlert[],
  billing: GcpBilling | undefined,
  opts: SignalOptions
): { alerts: string[] } {
  const lines: string[] = [];

  // (a) Cloud Run service whose latest revision is not Ready.
  for (const s of services) {
    if (s.ready === false) {
      const where = [s.name, s.region].filter(Boolean).join(' @ ') || 'unknown';
      lines.push(`:rotating_light: *Cloud Run not ready* \`${where}\`${s.latestRevision ? ` (rev ${s.latestRevision})` : ''}`);
    }
  }

  // (b) firing Monitoring alert policy.
  for (const a of alerts) {
    if (a.firing) {
      const name = a.displayName ?? a.policyId ?? 'unknown policy';
      lines.push(`:warning: *Alert firing* \`${name}\`${a.conditionName ? ` — ${a.conditionName}` : ''}`);
    }
  }

  // (c) spend over threshold (FinOps mount).
  if (billing?.amount != null && billing.amount >= opts.billingAlertUsd) {
    const cur = billing.currency ?? 'USD';
    lines.push(`:moneybag: *Spend* ${cur} *${billing.amount}* (>= ${opts.billingAlertUsd})`);
  }

  return { alerts: lines };
}

/**
 * Read a VFS collection's index (e.g. /gcp/run/services/_index.json) into an
 * array. Degrades to [] when the mount isn't populated yet (the gcp-relay sync
 * not live, empty tree, or path drift) — logged so a real fault is
 * distinguishable from the expected pre-rollout miss.
 */
async function readCollection<T>(ctx: WorkforceCtx, op: string, path: string): Promise<T[]> {
  try {
    const body = await readJsonFile<unknown>(vfsClient(), 'gcp', op, path);
    if (Array.isArray(body)) return body as T[];
    if (body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)) {
      return (body as { items: T[] }).items;
    }
    return [];
  } catch (err) {
    ctx.log?.('info', `gcp VFS read failed for ${path}; treating as empty`, {
      error: err instanceof Error ? err.message : String(err)
    });
    return [];
  }
}

async function readBilling(ctx: WorkforceCtx): Promise<GcpBilling | undefined> {
  try {
    return await readJsonFile<GcpBilling>(vfsClient(), 'gcp', 'getBilling', BILLING_PATH);
  } catch (err) {
    ctx.log?.('info', 'gcp billing VFS read failed; treating as unavailable', {
      error: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
}

/** Anchor relayfile reads to the mount root (never the runner CWD). */
function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}
function numInput(ctx: WorkforceCtx, name: string, fallback: number): number {
  const n = Number(input(ctx, name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface Snapshot {
  signature: string;
}
async function loadSnapshot(ctx: WorkforceCtx): Promise<Snapshot | undefined> {
  const [item] = await ctx.memory.recall('gcp snapshot', { tags: ['gcp-watcher:snapshot'], limit: 1 });
  if (!item) return undefined;
  try {
    return JSON.parse(item.content) as Snapshot;
  } catch {
    return undefined;
  }
}
async function saveSnapshot(ctx: WorkforceCtx, snap: Snapshot): Promise<void> {
  await ctx.memory.save(JSON.stringify(snap), { tags: ['gcp-watcher:snapshot'], scope: 'workspace' });
}
