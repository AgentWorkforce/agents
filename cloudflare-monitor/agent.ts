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

const CF_ROOT = '/cloudflare';
const D1_USAGE_INDEX = `${CF_ROOT}/d1/usage/_index.json`;
const R2_USAGE_INDEX = `${CF_ROOT}/r2/usage/_index.json`;
const QUEUE_USAGE_INDEX = `${CF_ROOT}/queues/usage/_index.json`;
const WORKER_USAGE_INDEX = `${CF_ROOT}/workers/usage/_index.json`;

export interface D1Usage {
  database_id?: string;
  database_name?: string;
  query_count?: number;
  rows_read?: number;
  rows_written?: number;
  duration_ms_p50?: number;
  window_start?: string;
  window_end?: string;
}

export interface R2Usage {
  bucket_name?: string;
  storage_bytes?: number;
  class_a_operations?: number;
  class_b_operations?: number;
  egress_bytes?: number;
}

export interface QueueUsage {
  queue_name?: string;
  messages_published?: number;
  messages_acknowledged?: number;
  messages_sent?: number;
  messages_retried?: number;
  messages_unacked?: number;
}

export interface WorkerUsage {
  script_name?: string;
  requests?: number;
  errors?: number;
  cpu_time_p99?: number;
}

interface AlertSignals {
  highD1Usage: D1Usage[];
  highR2Usage: R2Usage[];
  highWorkerErrors: WorkerUsage[];
  queueBacklogs: QueueUsage[];
  queueRetries: QueueUsage[];
}

interface MonitorMemory {
  lastAlertFingerprint?: string;
  lastScanAt?: string;
}

export default defineAgent({
  schedules: [{ name: 'cloudflare-scan', cron: '0 */2 * * *', tz: 'UTC' }],
  handler: async (ctx, event) => {
    // Chat path: a relay message arrived — answer questions about Cloudflare usage.
    if (isRelaycastMessageEvent(event)) {
      await handleInboxChat(ctx, event);
      return;
    }
    // Clock path: the full-state usage sweep (every 2h). Cron envelopes in this
    // runtime carry `name`/`cron`, not `schedule`, so gate on isCronTickEvent
    // (the schedule's `name` is the only configured tick).
    if (isCronTickEvent(event)) {
      await handleScan(ctx);
      return;
    }
  }
});

const DEFAULT_D1_ROWS_READ_THRESHOLD = 1_000_000;
const DEFAULT_D1_ROWS_WRITTEN_THRESHOLD = 100_000;
const DEFAULT_R2_STORAGE_GB_THRESHOLD = 100;
const R2_CLASSA_OPS_THRESHOLD = 1_000_000;
const R2_EGRESS_THRESHOLD = 107_374_182_400;
const DEFAULT_QUEUE_UNACKED_THRESHOLD = 1_000;
const QUEUE_RETRY_THRESHOLD = 100;
const WORKER_ERROR_RATE_THRESHOLD = 0.05;
const BYTES_PER_GB = 1_073_741_824;

interface ScanThresholds {
  d1RowsRead: number;
  d1RowsWritten: number;
  r2StorageBytes: number;
  queueUnacked: number;
}

function numberInput(ctx: WorkforceCtx, name: string, fallback: number): number {
  const raw = input(ctx, name);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function resolveThresholds(ctx: WorkforceCtx): ScanThresholds {
  return {
    d1RowsRead: numberInput(ctx, 'D1_ROWS_READ_THRESHOLD', DEFAULT_D1_ROWS_READ_THRESHOLD),
    d1RowsWritten: numberInput(ctx, 'D1_ROWS_WRITTEN_THRESHOLD', DEFAULT_D1_ROWS_WRITTEN_THRESHOLD),
    // R2_STORAGE_GB_THRESHOLD is in GB; convert to bytes for storage_bytes comparison.
    r2StorageBytes: numberInput(ctx, 'R2_STORAGE_GB_THRESHOLD', DEFAULT_R2_STORAGE_GB_THRESHOLD) * BYTES_PER_GB,
    queueUnacked: numberInput(ctx, 'QUEUE_UNACKED_THRESHOLD', DEFAULT_QUEUE_UNACKED_THRESHOLD),
  };
}

async function handleScan(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log?.('warn', 'cloudflare-monitor.no-channel', { reason: 'SLACK_CHANNEL not set; skipping alert' });
    return;
  }

  const root = resolveMountRoot({});
  const signals = await evaluateSignals(ctx, root, resolveThresholds(ctx));
  const hasAlerts = signals.highD1Usage.length > 0
    || signals.highR2Usage.length > 0
    || signals.highWorkerErrors.length > 0
    || signals.queueBacklogs.length > 0
    || signals.queueRetries.length > 0;

  if (!hasAlerts) {
    ctx.log?.('info', 'cloudflare-monitor.scan-clean', { at: new Date().toISOString() });
    return;
  }

  const fingerprint = buildFingerprint(signals);
  const mem = await loadMemory(ctx);

  if (mem.lastAlertFingerprint === fingerprint) {
    ctx.log?.('info', 'cloudflare-monitor.unchanged', {
      fingerprint,
      reason: 'signals unchanged since last alert; staying silent'
    });
    return;
  }

  const message = formatAlertMessage(signals);
  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, message);

  if (!result?.ts) {
    ctx.log?.('error', 'cloudflare-monitor.post-failed', {
      reason: 'Slack writeback returned empty ts — path may not be mounted'
    });
    throw new Error('Slack post returned no receipt ts; treating as delivery failure');
  }

  await saveMemory(ctx, { lastAlertFingerprint: fingerprint, lastScanAt: new Date().toISOString() });
  ctx.log?.('info', 'cloudflare-monitor.alerted', { ts: result.ts, fingerprint });
}

async function evaluateSignals(
  ctx: WorkforceCtx,
  mountRoot: string,
  thresholds: ScanThresholds,
): Promise<AlertSignals> {
  const [d1Usage, r2Usage, queueUsage, workerUsage] = await Promise.all([
    readCollection<D1Usage>(ctx, mountRoot, 'getD1Usage', D1_USAGE_INDEX),
    readCollection<R2Usage>(ctx, mountRoot, 'getR2Usage', R2_USAGE_INDEX),
    readCollection<QueueUsage>(ctx, mountRoot, 'getQueueUsage', QUEUE_USAGE_INDEX),
    readCollection<WorkerUsage>(ctx, mountRoot, 'getWorkerUsage', WORKER_USAGE_INDEX),
  ]);

  const highD1Usage = d1Usage.filter((d) =>
    (d.rows_read ?? 0) > thresholds.d1RowsRead
    || (d.rows_written ?? 0) > thresholds.d1RowsWritten
  );

  const highR2Usage = r2Usage.filter((r) =>
    (r.storage_bytes ?? 0) > thresholds.r2StorageBytes
    || (r.class_a_operations ?? 0) > R2_CLASSA_OPS_THRESHOLD
    || (r.egress_bytes ?? 0) > R2_EGRESS_THRESHOLD
  );

  const queueBacklogs = queueUsage.filter((q) =>
    (q.messages_unacked ?? 0) > thresholds.queueUnacked
  );

  const queueRetries = queueUsage.filter((q) =>
    (q.messages_retried ?? 0) > QUEUE_RETRY_THRESHOLD
  );

  const highWorkerErrors = workerUsage.filter((w) => {
    const rate = (w.requests ?? 0) > 0 ? (w.errors ?? 0) / (w.requests ?? 1) : 0;
    return rate >= WORKER_ERROR_RATE_THRESHOLD;
  });

  return { highD1Usage, highR2Usage, highWorkerErrors, queueBacklogs, queueRetries };
}

function formatAlertMessage(signals: AlertSignals): string {
  const lines: string[] = [':warning: *Cloudflare infrastructure alert*'];

  if (signals.highD1Usage.length > 0) {
    lines.push('');
    lines.push(`*D1 usage spikes* (${signals.highD1Usage.length})`);
    for (const d of signals.highD1Usage.slice(0, 5)) {
      const name = d.database_name ?? d.database_id ?? 'unknown';
      const rows = `${(d.rows_read ?? 0).toLocaleString()}r/${(d.rows_written ?? 0).toLocaleString()}w`;
      lines.push(`  • \`${name}\` — ${rows} rows, ${(d.query_count ?? 0).toLocaleString()} queries`);
    }
    if (signals.highD1Usage.length > 5) {
      lines.push(`  • … and ${signals.highD1Usage.length - 5} more`);
    }
  }

  if (signals.highR2Usage.length > 0) {
    lines.push('');
    lines.push(`*R2 usage spikes* (${signals.highR2Usage.length})`);
    for (const r of signals.highR2Usage.slice(0, 5)) {
      const name = r.bucket_name ?? 'unknown';
      const storage = r.storage_bytes ? `${(r.storage_bytes / 1_073_741_824).toFixed(1)}GB` : '?';
      const ops = `A:${(r.class_a_operations ?? 0).toLocaleString()} B:${(r.class_b_operations ?? 0).toLocaleString()}`;
      lines.push(`  • \`${name}\` — ${storage}, ${ops}`);
    }
    if (signals.highR2Usage.length > 5) {
      lines.push(`  • … and ${signals.highR2Usage.length - 5} more`);
    }
  }

  if (signals.highWorkerErrors.length > 0) {
    lines.push('');
    lines.push(`*Worker error rate spikes* (${signals.highWorkerErrors.length})`);
    for (const w of signals.highWorkerErrors.slice(0, 5)) {
      const name = w.script_name ?? 'unknown';
      const rate = (w.requests ?? 0) > 0 ? `${((w.errors ?? 0) / (w.requests ?? 1) * 100).toFixed(1)}%` : '?';
      lines.push(`  • \`${name}\` — ${rate} error rate (${(w.errors ?? 0).toLocaleString()}/${(w.requests ?? 0).toLocaleString()})`);
    }
    if (signals.highWorkerErrors.length > 5) {
      lines.push(`  • … and ${signals.highWorkerErrors.length - 5} more`);
    }
  }

  if (signals.queueBacklogs.length > 0) {
    lines.push('');
    lines.push(`*Queue backlogs* (${signals.queueBacklogs.length})`);
    for (const q of signals.queueBacklogs.slice(0, 5)) {
      lines.push(`  • \`${q.queue_name ?? 'unknown'}\` — ${(q.messages_unacked ?? 0).toLocaleString()} unacked`);
    }
    if (signals.queueBacklogs.length > 5) {
      lines.push(`  • … and ${signals.queueBacklogs.length - 5} more`);
    }
  }

  if (signals.queueRetries.length > 0) {
    lines.push('');
    lines.push(`*Queue retry rates* (${signals.queueRetries.length})`);
    for (const q of signals.queueRetries.slice(0, 5)) {
      lines.push(`  • \`${q.queue_name ?? 'unknown'}\` — ${(q.messages_retried ?? 0).toLocaleString()} retried`);
    }
    if (signals.queueRetries.length > 5) {
      lines.push(`  • … and ${signals.queueRetries.length - 5} more`);
    }
  }

  return lines.join('\n');
}

function buildFingerprint(signals: AlertSignals): string {
  const parts = [
    signals.highD1Usage
      .map((d) => `d1:${d.database_id ?? d.database_name}:${d.rows_read}:${d.rows_written}`)
      .sort().join(','),
    signals.highR2Usage
      .map((r) => `r2:${r.bucket_name}:${r.storage_bytes}:${r.class_a_operations}:${r.egress_bytes}`)
      .sort().join(','),
    signals.highWorkerErrors
      .map((w) => `we:${w.script_name}:${w.errors}:${w.requests}`)
      .sort().join(','),
    signals.queueBacklogs.map((q) => `qb:${q.queue_name}:${q.messages_unacked}`).sort().join(','),
    signals.queueRetries.map((q) => `qr:${q.queue_name}:${q.messages_retried}`).sort().join(','),
  ];
  return parts.filter(Boolean).join('|');
}

// ── Chat / inbox handler ──────────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT = `You are a Cloudflare spend and usage assistant with access to live infrastructure usage data for this organization. You can answer questions about:

- **D1** — per-database rows read/written, query count, p50 query duration
- **R2** — per-bucket storage bytes, Class A/B operations, egress bytes
- **Queues** — per-queue messages published/acknowledged/sent/retried/unacked
- **Workers** — per-script requests, errors, p99 CPU time

When answering:
- Use Slack mrkdwn formatting (*bold*, \`code\`, bullet lists).
- Be specific — quote database/bucket/queue/script names and the relevant numbers.
- If the data doesn't contain enough detail to answer, say so and suggest what to check in the Cloudflare dashboard.
- Keep responses concise — prefer a tight bullet list over a long paragraph.`;

async function handleInboxChat(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');

  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const question = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  if (!question.trim()) {
    ctx.log?.('info', 'cloudflare-monitor.relaycast-empty', { reason: 'no text in message; skipping' });
    return;
  }

  const root = resolveMountRoot({});

  // Load the full usage picture so the LLM can answer cross-cutting questions.
  const [d1Usage, r2Usage, queueUsage, workerUsage] = await Promise.all([
    readCollection<D1Usage>(ctx, root, 'getD1Usage', D1_USAGE_INDEX),
    readCollection<R2Usage>(ctx, root, 'getR2Usage', R2_USAGE_INDEX),
    readCollection<QueueUsage>(ctx, root, 'getQueueUsage', QUEUE_USAGE_INDEX),
    readCollection<WorkerUsage>(ctx, root, 'getWorkerUsage', WORKER_USAGE_INDEX),
  ]);

  const userMessage = [
    `## D1 usage (${d1Usage.length} databases)`,
    JSON.stringify(d1Usage.slice(0, 30), null, 2),
    '',
    `## R2 usage (${r2Usage.length} buckets)`,
    JSON.stringify(r2Usage.slice(0, 30), null, 2),
    '',
    `## Queue usage (${queueUsage.length} queues)`,
    JSON.stringify(queueUsage.slice(0, 30), null, 2),
    '',
    `## Worker usage (${workerUsage.length} scripts)`,
    JSON.stringify(workerUsage.slice(0, 30), null, 2),
    '',
    `## User question\n${question}`,
  ].join('\n');

  // ctx.llm.complete() is a direct LLM completion (deployer's subscription
  // credential via useSubscription: true). LlmContext.complete() takes the
  // prompt directly, so the system guidance rides as a preamble.
  const reply = await ctx.llm.complete(`${CHAT_SYSTEM_PROMPT}\n\n${userMessage}`);

  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, reply);
  if (!result?.ts) {
    ctx.log?.('error', 'cloudflare-monitor.chat-post-failed', { reason: 'Slack post returned no receipt' });
    throw new Error('Slack post returned no receipt ts after chat reply');
  }
}

async function readCollection<T>(
  ctx: WorkforceCtx,
  mountRoot: string,
  tag: string,
  indexPath: string,
): Promise<T[]> {
  try {
    const index = await readJsonFile({ relayfileMountRoot: mountRoot }, 'cloudflare', tag, indexPath) as { items?: T[] } | T[] | null;
    if (!index) return [];
    if (Array.isArray(index)) return index;
    if (Array.isArray((index as { items?: T[] }).items)) return (index as { items: T[] }).items;
    return [];
  } catch (error) {
    // Log the read failure so a broken mount/read doesn't masquerade as a clean
    // (no-alert) scan. Return empty so a single missing feed doesn't crash the run.
    ctx.log?.('warn', 'cloudflare-monitor.read-failed', {
      tag,
      indexPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}

async function loadMemory(ctx: WorkforceCtx): Promise<MonitorMemory> {
  try {
    const [item] = await ctx.memory.recall('cloudflare monitor state', { tags: ['cloudflare-monitor:state'], limit: 1 });
    return item ? (JSON.parse(item.content) as MonitorMemory) : {};
  } catch {
    return {};
  }
}

async function saveMemory(ctx: WorkforceCtx, state: MonitorMemory): Promise<void> {
  await ctx.memory.save(JSON.stringify(state), { tags: ['cloudflare-monitor:state'], scope: 'workspace' });
}
