/**
 * daytona-monitor handler.
 *
 *   on each tick
 *     → get a fresh Daytona access token
 *     → GET /organizations/{org}/usage   (CPU / memory / disk quota vs current)
 *     → GET /sandbox (paginated)          (state + timestamps)
 *     → evaluate signals (quota nearing limit, ERROR sandbox, stale running,
 *       allocation jump vs the last snapshot we stored in durable memory)
 *     → post ONE concise Slack alert if any signal fires; stay silent otherwise
 *       and never re-alert an unchanged condition.
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
// Adapter-published path for the org usage record (/daytona/usage/<orgId>.json).
import { daytonaUsagePath } from '@relayfile/adapter-daytona';
// Fresh, auto-refreshed Daytona Auth0 access token (auth once → refreshed
// forever). Owned by ./lib/daytona-auth.ts; persists rotated refresh tokens.
import { getDaytonaAccessToken } from './lib/daytona-auth.js';

// ── Daytona REST ─────────────────────────────────────────────────────────────
const DAYTONA_API = 'https://app.daytona.io/api';
const ORG_HEADER = 'X-Daytona-Organization-ID';
// Daytona surfaces two terminal failure states; we alert on both.
const ERROR_STATES = new Set(['ERROR', 'BUILD_FAILED']);

export interface RegionUsage {
  regionId?: string;
  sandboxClass?: string;
  totalCpuQuota?: number;
  currentCpuUsage?: number;
  totalMemoryQuota?: number;
  currentMemoryUsage?: number;
  totalDiskQuota?: number;
  currentDiskUsage?: number;
}
export interface UsageResponse {
  regionUsage?: RegionUsage[];
}
export interface Sandbox {
  id?: string;
  name?: string;
  // Daytona returns lowercase states (started/stopped/error/archived); we
  // normalize with toUpperCase() before comparing.
  state?: string;
  errorReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

const DEFAULT_ORG_ID = 'd9efb08e-7f53-4fe0-b37e-d1a281622bc0';

export default defineAgent({
  // Hourly — frequent enough to catch a runaway sandbox, cheap enough to ignore.
  schedules: [{ name: 'usage-scan', cron: '0 * * * *', tz: 'America/New_York' }],
  // Real-time: Daytona sandbox-lifecycle webhooks. Cloud's nango-webhook-router
  // routes daytona events → /daytona/sandboxes/{id}; the event-name literals
  // below are registered in the trigger catalog (relayfile-adapters#155). They
  // surface to the handler as `event.type === 'daytona.sandbox.state.updated'`
  // etc. We subscribe only to the sandbox lifecycle (the things that error or
  // run stale); snapshot.*/volume.* stay on the hourly scan since they carry no
  // immediate-alert signal here.
  triggers: {
    daytona: [{ on: 'sandbox.created' }, { on: 'sandbox.state.updated' }]
  },
  handler: async (ctx, event) => {
    // Chat path: a relay message arrived — answer questions about Daytona data.
    if (isRelaycastMessageEvent(event)) {
      await handleInboxMessage(ctx, event);
      return;
    }
    // Real-time path: a Daytona webhook arrived — alert the MOMENT a sandbox
    // turns ERROR/BUILD_FAILED, instead of waiting for the next hourly tick.
    if (isDaytonaSandboxEvent(event)) {
      await handleSandboxWebhook(ctx, event);
      return;
    }
    // Clock path: the full hourly usage + allocation scan (unchanged).
    if (isCronTickEvent(event)) {
      await handleUsageScan(ctx);
      return;
    }
  }
});

/**
 * Chat handler: when someone messages the agent via relay inbox, fetch current
 * Daytona data and use the LLM to answer their question conversationally.
 */
async function handleInboxMessage(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const orgId = input(ctx, 'DAYTONA_ORG_ID') ?? DEFAULT_ORG_ID;

  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const question = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  if (!question.trim()) {
    ctx.log?.('info', 'relaycast message with no text; skipping');
    return;
  }

  let usageText = 'Usage data unavailable.';
  let sandboxText = 'Sandbox data unavailable.';
  try {
    const token = await getDaytonaAccessToken(orgId);
    const auth = { Authorization: `Bearer ${token}`, [ORG_HEADER]: orgId, Accept: 'application/json' };

    const usage = await readUsage(ctx, orgId, auth);
    usageText = JSON.stringify(usage, null, 2);

    const sandboxes = await getAllSandboxes(auth);
    sandboxText = JSON.stringify(
      sandboxes.map(s => ({
        id: s.id, name: s.name, state: s.state,
        errorReason: s.errorReason, createdAt: s.createdAt, updatedAt: s.updatedAt
      })),
      null, 2
    );
  } catch (err) {
    ctx.log?.('warn', 'failed to fetch Daytona data for chat response', {
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const prompt = [
    'You are a Daytona infrastructure monitor. Answer the user\'s question about the current Daytona organization state using the data below.',
    'Be concise and specific. Use Slack markdown formatting.',
    '',
    `## Current Usage/Quota Data (org ${orgId})`,
    usageText,
    '',
    '## Current Sandboxes',
    sandboxText,
    '',
    `## User Question`,
    question
  ].join('\n');

  const answer = await ctx.llm.complete(prompt, { maxTokens: 1024 });

  const res = await slackClient().post(channel, answer);
  if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
}

/** True for a Daytona sandbox-lifecycle webhook event (`daytona.sandbox.*`). */
function isDaytonaSandboxEvent(event: AgentEvent): boolean {
  return typeof event.type === 'string' && event.type.startsWith('daytona.sandbox.');
}

/**
 * Real-time webhook handler. On a sandbox lifecycle event we re-fetch the
 * freshest sandbox record (falling back to the webhook payload), run it through
 * the same `evaluateSignals` formatting as the hourly scan, and post an
 * immediate Slack alert only when the sandbox is in an error state. A healthy
 * state change (started/stopped) produces no alert — we stay silent.
 */
async function handleSandboxWebhook(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const orgId = input(ctx, 'DAYTONA_ORG_ID') ?? DEFAULT_ORG_ID;
  const quotaPct = numInput(ctx, 'QUOTA_ALERT_PCT', 80);
  const staleHours = numInput(ctx, 'STALE_HOURS', 12);

  const payload = await extractSandbox(event);
  const id = payload?.id ?? event.resource?.id;
  if (!id) {
    ctx.log?.('info', 'daytona webhook without a sandbox id; skipping', { type: event.type });
    return;
  }

  // Honor "fetch that sandbox": pull the freshest record, but never let a
  // transient API/auth failure swallow the alert — fall back to the payload.
  const sandbox = await fetchSandboxFresh(orgId, id, payload ?? { id });

  // Reuse the hourly scan's signal evaluation. With no usage payload only the
  // ERROR/BUILD_FAILED (and stale) sandbox signals can fire — exactly what a
  // single lifecycle event should surface.
  const { alerts } = evaluateSignals({}, [sandbox], { quotaPct, staleHours, now: Date.now() });
  if (alerts.length === 0) {
    ctx.log?.('info', 'daytona webhook: no actionable signal', {
      id,
      state: sandbox.state,
      type: event.type
    });
    return;
  }

  // Make delivery loud: post() resolves with ts:'' (no throw) when the
  // writeback gets no receipt, so an empty ts is a silent drop, not success.
  const res = await slackClient().post(
    channel,
    `:satellite: *Daytona monitor* (real-time) — org \`${orgId}\`\n${alerts.join('\n')}`
  );
  if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
}

/** Pull the sandbox record carried in the webhook envelope (`expand('full')`). */
async function extractSandbox(event: AgentEvent): Promise<Sandbox | undefined> {
  try {
    const full = (await event.expand('full')) as { data?: unknown } | undefined;
    const data = full?.data;
    if (data && typeof data === 'object') return normalizeSandbox(data as Record<string, unknown>);
  } catch {
    // expansion is best-effort; fall through to the resource id / refetch.
  }
  return undefined;
}

/**
 * Coerce a raw Daytona webhook record into our canonical `Sandbox` shape.
 *
 * The adapter's normalizer promotes `state` from any of `newState` / `new_state`
 * / `state` / `sandbox.state`, but does NOT guarantee a promoted `errorReason`
 * (per Daytona-Catalog / relayfile-adapters#155) — the raw body just rides along
 * — so we read the failure reason defensively from every shape it has shown up
 * in. The refetch path (`fetchSandboxFresh`) overlays the authoritative API
 * fields when it succeeds.
 */
function normalizeSandbox(raw: Record<string, unknown>): Sandbox {
  const nested = (raw.sandbox && typeof raw.sandbox === 'object' ? raw.sandbox : {}) as Record<string, unknown>;
  const str = (...vals: unknown[]): string | undefined =>
    vals.find((v): v is string => typeof v === 'string' && v.length > 0);
  return {
    id: str(raw.id, nested.id),
    name: str(raw.name, nested.name),
    state: str(raw.newState, raw.new_state, raw.state, nested.state),
    errorReason: str(raw.errorReason, raw.error_reason, nested.errorReason, nested.error_reason),
    createdAt: str(raw.createdAt, raw.created_at, nested.createdAt),
    updatedAt: str(raw.updatedAt, raw.updated_at, nested.updatedAt)
  };
}

/**
 * Fetch the single sandbox's freshest state from Daytona. Merges over the
 * webhook payload so a missing field (e.g. errorReason) survives, and returns
 * the payload unchanged on any auth/API failure so the alert still fires.
 */
async function fetchSandboxFresh(orgId: string, id: string, payload: Sandbox): Promise<Sandbox> {
  try {
    const token = await getDaytonaAccessToken(orgId);
    const auth = { Authorization: `Bearer ${token}`, [ORG_HEADER]: orgId, Accept: 'application/json' };
    const fresh = await getJson<Sandbox>(`${DAYTONA_API}/sandbox/${encodeURIComponent(id)}`, auth);
    return { ...payload, ...fresh };
  } catch {
    return payload;
  }
}

/** The hourly full usage + allocation scan (the original cron behavior). */
async function handleUsageScan(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const orgId = input(ctx, 'DAYTONA_ORG_ID') ?? DEFAULT_ORG_ID;
  const quotaPct = numInput(ctx, 'QUOTA_ALERT_PCT', 80);
  const staleHours = numInput(ctx, 'STALE_HOURS', 12);

  const token = await getDaytonaAccessToken(orgId);
  const auth = { Authorization: `Bearer ${token}`, [ORG_HEADER]: orgId, Accept: 'application/json' };

  const usage = await readUsage(ctx, orgId, auth);
  const sandboxes = await getAllSandboxes(auth);

  const last = await loadSnapshot(ctx);
  const { alerts, running } = evaluateSignals(usage, sandboxes, {
    quotaPct,
    staleHours,
    now: Date.now(),
    lastRunning: last?.running
  });

  // Dedupe: only post when the alert *set* changed since we last alerted.
  const signature = alerts.slice().sort().join('\n');
  if (alerts.length > 0 && signature !== last?.signature) {
    // Make delivery loud: post() resolves with ts:'' (no throw) when the
    // writeback gets no receipt, so an empty ts is a silent drop, not success.
    const res = await slackClient().post(
      channel,
      `:satellite: *Daytona monitor* — org \`${orgId}\`\n${alerts.join('\n')}`
    );
    if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
  }

  await saveSnapshot(ctx, { running, signature: alerts.length > 0 ? signature : '' });
}

export interface SignalOptions {
  /** Alert when a usage/quota ratio reaches this percent. */
  quotaPct: number;
  /** Hours before a STARTED sandbox counts as stale. */
  staleHours: number;
  /** Current time in ms (injected for deterministic tests). */
  now: number;
  /** Running-sandbox count from the previous run, for the allocation-jump signal. */
  lastRunning?: number;
}

/**
 * Pure signal evaluation — given a usage payload and the full sandbox list,
 * return the Slack alert lines plus the current running count. No IO, no clock
 * access (time is injected via `opts.now`), so it is fully unit-testable.
 *
 * Daytona sandbox states arrive lowercase (started/stopped/error/archived); we
 * normalize with toUpperCase() before comparing.
 */
export function evaluateSignals(
  usage: UsageResponse,
  sandboxes: Sandbox[],
  opts: SignalOptions
): { alerts: string[]; running: number } {
  const { quotaPct, staleHours, now } = opts;
  const alerts: string[] = [];

  // (a) quota nearing limit, per region/class, per resource.
  for (const r of usage.regionUsage ?? []) {
    const where = [r.regionId, r.sandboxClass].filter(Boolean).join('/') || 'org';
    for (const [name, used, total] of [
      ['CPU', r.currentCpuUsage, r.totalCpuQuota],
      ['memory', r.currentMemoryUsage, r.totalMemoryQuota],
      ['disk', r.currentDiskUsage, r.totalDiskQuota]
    ] as const) {
      if (!total || used == null) continue;
      const pct = Math.round((used / total) * 100);
      if (pct >= quotaPct) {
        alerts.push(`:warning: *${name} quota* ${where}: *${pct}%* (${used}/${total})`);
      }
    }
  }

  // (b) any sandbox in a failed state (Daytona surfaces both error and
  // build_failed for the two ways a box can die).
  for (const s of sandboxes) {
    const state = (s.state ?? '').toUpperCase();
    if (!ERROR_STATES.has(state)) continue;
    const why = s.errorReason ? ` — ${s.errorReason}` : '';
    alerts.push(`:rotating_light: *Sandbox ${state}* ${label(s)}${why}`);
  }

  // (c) stale running: STARTED longer than STALE_HOURS.
  const staleMs = staleHours * 3_600_000;
  for (const s of sandboxes) {
    if ((s.state ?? '').toUpperCase() !== 'STARTED') continue;
    const started = Date.parse(s.createdAt ?? s.updatedAt ?? '');
    if (!Number.isNaN(started) && now - started >= staleMs) {
      const hrs = Math.floor((now - started) / 3_600_000);
      alerts.push(`:hourglass: *Stale sandbox* ${label(s)} running *${hrs}h* (>= ${staleHours}h)`);
    }
  }

  // (d) allocation jump vs last run.
  const running = sandboxes.filter((s) => (s.state ?? '').toUpperCase() === 'STARTED').length;
  if (opts.lastRunning != null && running - opts.lastRunning >= 5) {
    alerts.push(`:chart_with_upwards_trend: *Allocation jump*: running sandboxes ${opts.lastRunning} → *${running}*`);
  }

  return { alerts, running };
}

/**
 * Fetch every sandbox via cursor pagination.
 *
 * The list endpoint is `/sandbox` (singular) → `{ items, nextCursor }`; the
 * plural `/sandboxes` 404s. Each page caps at 100 items, so a single page would
 * silently miss an ERROR/stale sandbox past the first 100 — page until the
 * cursor is absent or stops advancing. A 50-page safety cap bounds the loop in
 * case the cursor ever fails to advance.
 */
async function getAllSandboxes(headers: Record<string, string>): Promise<Sandbox[]> {
  const out: Sandbox[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const url = `${DAYTONA_API}/sandbox${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await getJson<{ items?: Sandbox[]; nextCursor?: string }>(url, headers);
    const items = asList<Sandbox>(body);
    out.push(...items);
    if (items.length === 0 || !body.nextCursor || body.nextCursor === cursor) break;
    cursor = body.nextCursor;
  }
  return out;
}

/**
 * Org usage/quota. Prefer the @relayfile/adapter-daytona VFS mount
 * (/daytona/usage/<orgId>.json, polled hourly by the adapter — no token, no
 * direct REST call), and fall back to the Daytona REST API while the adapter's
 * usage sync is still rolling out (relayfile-adapters#155). `evaluateSignals`
 * sees the same `UsageResponse` shape either way.
 */
async function readUsage(
  ctx: WorkforceCtx,
  orgId: string,
  auth: Record<string, string>
): Promise<UsageResponse> {
  try {
    return await readJsonFile<UsageResponse>(vfsClient(), 'daytona', 'getUsage', daytonaUsagePath(orgId));
  } catch (err) {
    // No mounted usage record yet (adapter sync not live, or empty tree) — use
    // the authoritative REST endpoint so quota signals still fire. Log the cause
    // so a real fault (perms, malformed JSON, path drift) is distinguishable
    // from the expected pre-rollout miss during triage.
    ctx.log?.('info', 'daytona usage VFS read failed; falling back to REST /usage', {
      orgId,
      error: err instanceof Error ? err.message : String(err)
    });
    return getJson<UsageResponse>(`${DAYTONA_API}/organizations/${orgId}/usage`, auth);
  }
}

/** Anchor relayfile reads to the mount root (never the runner CWD). */
function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Daytona ${res.status} on ${url}: ${await res.text()}`);
  return (await res.json()) as T;
}
function asList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)) {
    return (payload as { items: T[] }).items;
  }
  return [];
}
function label(s: Sandbox): string {
  return `\`${s.name ?? s.id ?? 'unknown'}\``;
}
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
  running: number;
  signature: string;
}
async function loadSnapshot(ctx: WorkforceCtx): Promise<Snapshot | undefined> {
  const [item] = await ctx.memory.recall('daytona snapshot', { tags: ['daytona-monitor:snapshot'], limit: 1 });
  if (!item) return undefined;
  try {
    return JSON.parse(item.content) as Snapshot;
  } catch {
    return undefined;
  }
}
async function saveSnapshot(ctx: WorkforceCtx, snap: Snapshot): Promise<void> {
  await ctx.memory.save(JSON.stringify(snap), { tags: ['daytona-monitor:snapshot'], scope: 'workspace' });
}
