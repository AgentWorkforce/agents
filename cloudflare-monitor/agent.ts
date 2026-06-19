import {
  defineAgent,
  isCronTickEvent,
  readJsonFile,
  resolveMountRoot,
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
    if (isCronTickEvent(event) && event.schedule === '0 */2 * * *') {
      await handleScan(ctx);
      return;
    }
  }
});

const D1_ROWS_READ_THRESHOLD = 1_000_000;
const D1_ROWS_WRITTEN_THRESHOLD = 100_000;
const R2_STORAGE_THRESHOLD = 107_374_182_400;
const R2_CLASSA_OPS_THRESHOLD = 1_000_000;
const R2_EGRESS_THRESHOLD = 107_374_182_400;
const QUEUE_UNACKED_THRESHOLD = 1_000;
const QUEUE_RETRY_THRESHOLD = 100;
const WORKER_ERROR_RATE_THRESHOLD = 0.05;

async function handleScan(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log?.('warn', 'cloudflare-monitor.no-channel', { reason: 'SLACK_CHANNEL not set; skipping alert' });
    return;
  }

  const root = resolveMountRoot({});
  const signals = await evaluateSignals(ctx, root);
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
): Promise<AlertSignals> {
  const [d1Usage, r2Usage, queueUsage, workerUsage] = await Promise.all([
    readCollection<D1Usage>(ctx, mountRoot, 'getD1Usage', D1_USAGE_INDEX),
    readCollection<R2Usage>(ctx, mountRoot, 'getR2Usage', R2_USAGE_INDEX),
    readCollection<QueueUsage>(ctx, mountRoot, 'getQueueUsage', QUEUE_USAGE_INDEX),
    readCollection<WorkerUsage>(ctx, mountRoot, 'getWorkerUsage', WORKER_USAGE_INDEX),
  ]);

  const highD1Usage = d1Usage.filter((d) =>
    (d.rows_read ?? 0) > D1_ROWS_READ_THRESHOLD
    || (d.rows_written ?? 0) > D1_ROWS_WRITTEN_THRESHOLD
  );

  const highR2Usage = r2Usage.filter((r) =>
    (r.storage_bytes ?? 0) > R2_STORAGE_THRESHOLD
    || (r.class_a_operations ?? 0) > R2_CLASSA_OPS_THRESHOLD
    || (r.egress_bytes ?? 0) > R2_EGRESS_THRESHOLD
  );

  const queueBacklogs = queueUsage.filter((q) =>
    (q.messages_unacked ?? 0) > QUEUE_UNACKED_THRESHOLD
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
  }

  if (signals.queueRetries.length > 0) {
    lines.push('');
    lines.push(`*Queue retry rates* (${signals.queueRetries.length})`);
    for (const q of signals.queueRetries.slice(0, 5)) {
      lines.push(`  • \`${q.queue_name ?? 'unknown'}\` — ${(q.messages_retried ?? 0).toLocaleString()} retried`);
    }
  }

  return lines.join('\n');
}

function buildFingerprint(signals: AlertSignals): string {
  const parts = [
    signals.highD1Usage.map((d) => `d1:${d.database_id}:${d.rows_read}:${d.rows_written}`).sort().join(','),
    signals.highR2Usage.map((r) => `r2:${r.bucket_name}:${r.storage_bytes}`).sort().join(','),
    signals.highWorkerErrors.map((w) => `we:${w.script_name}:${w.errors}`).sort().join(','),
    signals.queueBacklogs.map((q) => `qb:${q.queue_name}:${q.messages_unacked}`).sort().join(','),
    signals.queueRetries.map((q) => `qr:${q.queue_name}:${q.messages_retried}`).sort().join(','),
  ];
  return parts.filter(Boolean).join('|');
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
  } catch {
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
