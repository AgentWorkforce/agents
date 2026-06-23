/**
 * hn-monitor handler.
 *
 *   cron tick
 *     → fetch the HN front page
 *     → keep stories whose title matches one of your TOPICS
 *     → drop ones already posted (durable memory)
 *     → summarize with ctx.llm
 *     → post digest to Slack, Telegram, or both
 *
 *   telegram message / relay inbox DM
 *     → answer questions about what's been recently posted
 *
 * Transport is configuration-driven. Set SLACK_CHANNEL, TELEGRAM_CHAT, or
 * both — the handler delivers to whichever targets are configured. Uses
 * @agentworkforce/delivery for unified messaging under the hood.
 */
import {
  defineAgent,
  isCronTickEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import {
  createDelivery,
  input,
  list,
  withTimeout,
  fetchWithTimeout,
  type DeliveryClient,
  type DeliveryResult
} from '@agentworkforce/delivery';

export interface Story {
  id: number;
  title: string;
  url: string;
  points: number;
}

export interface PostRecord {
  postedAt: string;
  digest: string;
  stories: Array<{ title: string; url: string; points: number }>;
}

interface PendingThreadBody {
  targets: string;
  header: string;
  body: string;
  createdAt: string;
  stories: Array<{ title: string; url: string; points: number }>;
}

// ── shared message parsing (provider-specific) ───────────────────────────

interface ParsedMessage {
  text: string;
  provider: 'slack' | 'telegram' | 'relay';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function parseTelegramMessage(payload: unknown): ParsedMessage | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const data = asRecord(rec.data) ?? rec;
  const from = asRecord(data.from);
  if (from?.is_bot || data.fromIsBot) return null;
  const text = str(data.text) ?? str(data.caption) ?? '';
  if (!text.trim()) return null;
  return { text: text.trim(), provider: 'telegram' };
}

function parseRelayMessage(payload: unknown): ParsedMessage | null {
  const data = asRecord((payload as { data?: Record<string, unknown> })?.data);
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const text = str(data?.text) ?? str(nested.text) ?? '';
  if (!text.trim()) return null;
  return { text: text.trim(), provider: 'relay' };
}

function parseSlackMessage(payload: unknown, wantChannel: string | undefined): ParsedMessage | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const data = asRecord(rec.data) ?? rec;
  const raw = asRecord(data.raw_event) ?? data;
  const channel = str(data.channel) ?? str(raw.channel) ?? '';
  if (data.is_bot === true || data.bot_id || (str(data.subtype) ?? str(raw.subtype))) return null;
  if (wantChannel && channel.split('__')[0] !== wantChannel.split('__')[0]) return null;
  const text = str(data.text) ?? str(raw.text) ?? '';
  const cleaned = text.replace(/^\s*<@[^>]+>\s*/, '').trim();
  if (!cleaned) return null;
  return { text: cleaned, provider: 'slack' };
}

// ── agent definition ─────────────────────────────────────────────────────

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  triggers: {
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    // Q&A path: telegram message
    if (typeof event.type === 'string' && event.type.startsWith('telegram.')) {
      await handleQaMessage(ctx, event as unknown as AgentEvent, 'telegram');
      return;
    }
    // Cron path
    if (!isCronTickEvent(event as unknown as AgentEvent)) return;

    const delivery = createDelivery(ctx);
    if (delivery.targets.length === 0) {
      ctx.log?.('warn', 'hn-monitor.no-targets', { reason: 'neither SLACK_CHANNEL nor TELEGRAM_CHAT configured' });
      return;
    }

    // Pending thread body recovery — if a previous run posted the header but
    // the threaded body failed, retry it before processing new stories.
    if (await retryPendingThreadBody(ctx, delivery)) return;

    const topics = list(input(ctx, 'TOPICS')).map((t) => t.toLowerCase());

    const stories = await fetchFrontPage();
    ctx.log?.('info', 'hn-monitor.fetched', { stories: stories.length });
    const matches = stories.filter((s) => topics.some((t) => s.title.toLowerCase().includes(t)));
    ctx.log?.('info', 'hn-monitor.matched', { matched: matches.length });

    const seen = await loadSeen(ctx);
    const fresh = matches.filter((s) => !seen.includes(s.id));
    ctx.log?.('info', 'hn-monitor.fresh', { fresh: fresh.length });
    if (fresh.length === 0) {
      ctx.log?.('info', 'hn-monitor.nothing-new', { matched: matches.length });
      return;
    }

    await postFreshStories(ctx, delivery, seen, fresh);
  }
});

// ── Q&A handler ──────────────────────────────────────────────────────────

async function handleQaMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  provider: 'telegram' | 'slack' | 'relay'
): Promise<void> {
  const payload = (await event.expand('full').catch(() => undefined)) as { data?: unknown } | undefined;
  if (!payload?.data) return;

  let parsed: ParsedMessage | null = null;
  if (provider === 'telegram') parsed = parseTelegramMessage(payload.data);
  else if (provider === 'slack') parsed = parseSlackMessage(payload.data, input(ctx, 'SLACK_CHANNEL'));
  else parsed = parseRelayMessage(payload.data);

  if (!parsed) {
    ctx.log?.('info', 'hn-monitor.qa.skip', { reason: 'unparseable or filtered message' });
    return;
  }

  const posts = await loadPosts(ctx);
  ctx.log?.('info', 'hn-monitor.qa.recalled', { posts: posts.length });

  const context = posts.length
    ? posts.map((p) => `### Posted ${p.postedAt ?? 'Unknown'}\n${p.digest ?? ''}`).join('\n\n')
    : 'No Hacker News digests have been posted yet.';

  const prompt = [
    "You are a Hacker News monitor. Answer the user's question using ONLY the recently posted digests below.",
    'Do not invent stories or facts that are not present in the posts. If the posts do not cover the question, say so.',
    'Be concise.',
    '',
    '## Recently posted digests (most recent ~30 days)',
    context,
    '',
    '## User question',
    parsed.text
  ].join('\n');

  let answer: string;
  try {
    answer = await withTimeout(ctx.llm.complete(prompt, { maxTokens: 1024 }), 45_000, 'ctx.llm.complete');
  } catch (error) {
    ctx.log?.('warn', 'hn-monitor.qa.llm-fallback', { error: String(error) });
    const titles = posts
      .flatMap((p) => (p.stories ?? []).map((s) => `- ${s.title ?? 'Untitled'} ${s.url ?? ''}`))
      .slice(0, 15)
      .join('\n');
    answer = titles
      ? `I couldn't generate an answer right now; here are the recent post titles:\n${titles}`
      : "I couldn't generate an answer right now, and I don't have any recent posts to show.";
  }

  // Deliver answer to all configured targets (non-blocking for Q&A replies)
  const delivery = createDelivery(ctx);
  if (delivery.targets.length > 0) {
    await delivery.publish(answer.trim() || 'No answer available.');
  }
}

// ── posting ──────────────────────────────────────────────────────────────

export async function postFreshStories(
  ctx: WorkforceCtx,
  delivery: DeliveryClient,
  seen: number[],
  fresh: Story[]
): Promise<void> {
  // Claim the stories as seen BEFORE the post. Cron delivery is at-least-once:
  // a single tick can re-invoke this handler (cloud re-runs a delivery whose
  // lease expires before it reports done). Claiming first means a concurrent
  // re-invocation loads these ids as already-seen and stays silent.
  await saveSeen(ctx, [...seen, ...fresh.map((s) => s.id)].slice(-200));

  let headerPosted = false;
  let pending: PendingThreadBody | null = null;
  try {
    ctx.log?.('info', 'hn-monitor.summarizing', { fresh: fresh.length });
    const { header, body } = await summarize(ctx, fresh);
    ctx.log?.('info', 'hn-monitor.posting', { targets: delivery.targets });

    // Publish the header non-blocking: returns draft refs immediately
    // (zero receipt round-trips). The cloud orders threaded messages under
    // the header server-side via parentRef — the x-reply-radar pattern.
    const heads = await delivery.publish(header);
    if (heads.refs.length === 0) {
      throw new Error(`Header publish failed across all targets`);
    }
    headerPosted = true;
    ctx.log?.('info', 'hn-monitor.header-published', { refs: heads.refs.length });

    // Thread the body under each header, also non-blocking. Each transport
    // uses its native threading: Slack parentRef (embedded in body, cloud
    // orders server-side), Telegram reply_to_message_id.
    const bodyResult = await delivery.send(body, { replyTo: heads, nonBlocking: true });
    if (!bodyResult.ok) {
      // Partial failure: save pending state so the next tick can retry the body
      pending = {
        targets: delivery.targets.join(','),
        header,
        body,
        createdAt: new Date().toISOString(),
        stories: fresh.map((s) => ({ title: s.title, url: s.url, points: s.points }))
      };
      throw new Error(`Threaded body failed on some targets`);
    }
    ctx.log?.('info', 'hn-monitor.posted', { targets: delivery.targets.join(',') });

    // Retain the digest for Q&A recall (~30 day rolling window via memory ttl).
    await savePost(ctx, {
      postedAt: new Date().toISOString(),
      digest: `${header}\n${body}`,
      stories: fresh.map((s) => ({ title: s.title, url: s.url, points: s.points }))
    });
  } catch (err) {
    if (!headerPosted) {
      // Nothing landed yet — release the provisional claim so the next tick
      // retries this digest, then rethrow.
      await saveSeen(ctx, seen).catch(() => {});
      throw err;
    }
    if (pending) {
      await savePendingThreadBody(ctx, pending)
        .catch((error) => ctx.log?.('error', 'hn-monitor.pending-save-failed', { error: String(error) }));
    }
    // The header already posted; releasing + rethrowing would duplicate it on
    // the runtime's retry. Keep the claim and let the next scan retry the body.
    ctx.log?.('error', 'hn-monitor.thread-incomplete', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── pending thread body recovery ─────────────────────────────────────────

async function retryPendingThreadBody(
  ctx: WorkforceCtx,
  delivery: DeliveryClient
): Promise<boolean> {
  const pending = await loadPendingThreadBody(ctx);
  if (!pending) return false;
  // Only retry if the targets match (same transports configured)
  const configuredTargets = delivery.targets.join(',');
  if (pending.targets !== configuredTargets) return false;

  const bodyResult = await delivery.send(pending.body, { nonBlocking: true });
  if (!bodyResult.ok) {
    ctx.log?.('error', 'hn-monitor.pending-body-retry-failed', { targets: configuredTargets });
    return true;
  }

  await savePost(ctx, {
    postedAt: new Date().toISOString(),
    digest: `${pending.header}\n${pending.body}`,
    stories: pending.stories
  });
  await clearPendingThreadBody(ctx);
  ctx.log?.('info', 'hn-monitor.pending-body-posted', { targets: configuredTargets });
  return true;
}

// ── HN fetching ──────────────────────────────────────────────────────────

async function fetchFrontPage(): Promise<Story[]> {
  const res = await fetchWithTimeout(
    'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30',
    {},
    8_000
  );
  if (!res?.ok) return [];
  try {
    const data = (await res.json()) as { hits: Array<{ objectID: string; title: string; url: string | null; points: number }> };
    return data.hits.map((h) => ({
      id: Number(h.objectID),
      title: h.title,
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points
    }));
  } catch {
    return [];
  }
}

// ── summarization ────────────────────────────────────────────────────────

async function summarize(ctx: WorkforceCtx, stories: Story[]): Promise<{ header: string; body: string }> {
  const lines = stories.map((s) => `- ${s.title} (${s.points} pts) ${s.url}`).join('\n');
  const header = `:newspaper: *Hacker News* — ${stories.length} new match(es)`;
  try {
    const digest = await withTimeout(
      ctx.llm.complete(
        `Write a tight digest (one bullet per story, lead with why it matters):\n\n${lines}`,
        { maxTokens: 500 }
      ),
      45_000,
      'ctx.llm.complete'
    );
    return { header, body: digest.trim() };
  } catch (error) {
    ctx.log?.('warn', 'hn-monitor.llm-fallback', { error: String(error) });
    return { header, body: lines };
  }
}

// ── memory helpers ───────────────────────────────────────────────────────

async function loadSeen(ctx: WorkforceCtx): Promise<number[]> {
  const [item] = await ctx.memory.recall('hn-monitor seen', { tags: ['hn-monitor:seen'], limit: 1 });
  try {
    return item ? (JSON.parse(item.content) as number[]) : [];
  } catch {
    return [];
  }
}
async function saveSeen(ctx: WorkforceCtx, ids: number[]): Promise<void> {
  await ctx.memory.save(JSON.stringify(ids), { tags: ['hn-monitor:seen'], scope: 'workspace' });
}
async function savePost(ctx: WorkforceCtx, record: PostRecord): Promise<void> {
  await ctx.memory.save(JSON.stringify(record), { tags: ['hn-monitor:post'], scope: 'workspace' });
}
async function loadPosts(ctx: WorkforceCtx): Promise<PostRecord[]> {
  const items = await ctx.memory.recall('hn-monitor posted digest', {
    tags: ['hn-monitor:post'],
    scope: 'workspace',
    limit: 60
  });
  const posts: PostRecord[] = [];
  for (const item of items) {
    try {
      posts.push(JSON.parse(item.content) as PostRecord);
    } catch {
      // skip malformed records
    }
  }
  return posts.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
}

async function loadPendingThreadBody(ctx: WorkforceCtx): Promise<PendingThreadBody | null> {
  const [item] = await ctx.memory.recall('hn-monitor pending thread body', {
    tags: ['hn-monitor:pending-thread-body'],
    limit: 1
  });
  if (!item?.content) return null;
  try {
    return JSON.parse(item.content) as PendingThreadBody | null;
  } catch {
    return null;
  }
}
async function savePendingThreadBody(ctx: WorkforceCtx, pending: PendingThreadBody): Promise<void> {
  await ctx.memory.save(JSON.stringify(pending), { tags: ['hn-monitor:pending-thread-body'], scope: 'workspace' });
}
async function clearPendingThreadBody(ctx: WorkforceCtx): Promise<void> {
  await ctx.memory.save('null', { tags: ['hn-monitor:pending-thread-body'], scope: 'workspace' });
}
