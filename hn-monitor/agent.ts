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
  isRelaycastMessageEvent,
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
import {
  readTelegramMessage,
  skipReason as telegramSkipReason,
  bareChatId,
  type TelegramMessage
} from '../shared/telegram.js';

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
  /** Sorted, comma-separated targets for order-independent comparison. */
  targets: string;
  header: string;
  body: string;
  createdAt: string;
  stories: Array<{ title: string; url: string; points: number }>;
  /** Serialized DeliveryResult.refs from the header publish, for recovery.
   *  The `draftRef` field holds the relay path for Slack refs and the messageId
   *  for Telegram refs — see saveHeaderRefs() / rebuildHeaderRefs(). */
  headerRefs: Array<{ provider: 'slack' | 'telegram'; draftRef: string; channel?: string; chatId?: string }>;
}

// ── message parsing ──────────────────────────────────────────────────────

interface ParsedMessage {
  text: string;
  provider: 'telegram' | 'relay';
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function parseRelayMessage(event: { data?: unknown }): ParsedMessage | null {
  const data = asRecord(event.data);
  if (!data) return null;
  const nested = (data.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const text = str(data.text) ?? str(nested.text) ?? '';
  if (!text.trim()) return null;
  return { text: text.trim(), provider: 'relay' };
}

// ── agent definition ─────────────────────────────────────────────────────

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  triggers: {
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    // Q&A path: relay inbox DM
    if (isRelaycastMessageEvent(event as unknown as AgentEvent)) {
      await handleQaMessage(ctx, event as unknown as AgentEvent, 'relay');
      return;
    }
    // Q&A path: telegram message
    if (typeof event.type === 'string' && event.type.startsWith('telegram.')) {
      await handleQaMessage(ctx, event as unknown as AgentEvent, 'telegram');
      return;
    }
    // Cron path
    if (!isCronTickEvent(event as unknown as AgentEvent)) return;

    const delivery = createDelivery(ctx);
    if (delivery.targets.length === 0) {
      ctx.log('warn', 'hn-monitor.no-targets', { reason: 'neither SLACK_CHANNEL nor TELEGRAM_CHAT configured' });
      return;
    }

    // Pending thread body recovery — if a previous run posted the header but
    // the threaded body failed, retry it before processing new stories.
    if (await retryPendingThreadBody(ctx, delivery)) return;

    const topics = list(input(ctx, 'TOPICS')).map((t) => t.toLowerCase());

    const stories = await fetchFrontPage();
    ctx.log('info', 'hn-monitor.fetched', { stories: stories.length });
    const matches = stories.filter((s) => topics.some((t) => s.title.toLowerCase().includes(t)));
    ctx.log('info', 'hn-monitor.matched', { matched: matches.length });

    const seen = await loadSeen(ctx);
    const fresh = matches.filter((s) => !seen.includes(s.id));
    ctx.log('info', 'hn-monitor.fresh', { fresh: fresh.length });
    if (fresh.length === 0) {
      ctx.log('info', 'hn-monitor.nothing-new', { matched: matches.length });
      return;
    }

    await postFreshStories(ctx, delivery, seen, fresh);
  }
});

// ── Q&A handler ──────────────────────────────────────────────────────────

export async function handleQaMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  provider: 'telegram' | 'relay',
  deps: {
    complete?: (prompt: string) => Promise<string>;
    /** Inject a delivery client for testing (avoids real writeback). */
    delivery?: DeliveryClient;
  } = {}
): Promise<void> {
  const expanded = await event.expand('full').catch(() => undefined);
  if (!expanded) return;

  let question: string | null = null;

  if (provider === 'telegram') {
    const payload = expanded as { data?: unknown };
    if (!payload.data) return;
    const msg = readTelegramMessage(payload.data);
    if (!msg) return;
    // Gate: skip bot echoes, wrong chat, empty text
    const reason = telegramSkipReason(msg, input(ctx, 'TELEGRAM_CHAT'));
    if (reason) {
      ctx.log('info', `hn-monitor.qa.skip reason=${reason.replace(/\s+/g, '-')}`);
      return;
    }
    question = msg.text.trim();
  } else {
    // relay inbox DM
    const parsed = parseRelayMessage(expanded as { data?: unknown });
    if (!parsed) {
      ctx.log('info', 'hn-monitor.qa.skip', { reason: 'unparseable relay message' });
      return;
    }
    question = parsed.text;
  }

  if (!question) return;

  const posts = await loadPosts(ctx);
  ctx.log('info', 'hn-monitor.qa.recalled', { posts: posts.length });

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
    question
  ].join('\n');

  const complete = deps.complete ?? ((p: string) => ctx.llm.complete(p, { maxTokens: 1024 }));
  let answer: string;
  try {
    answer = await withTimeout(complete(prompt), 45_000, 'ctx.llm.complete');
  } catch (error) {
    ctx.log('warn', 'hn-monitor.qa.llm-fallback', { error: String(error) });
    const titles = posts
      .flatMap((p) => (p.stories ?? []).map((s) => `- ${s.title ?? 'Untitled'} ${s.url ?? ''}`))
      .slice(0, 15)
      .join('\n');
    answer = titles
      ? `I couldn't generate an answer right now; here are the recent post titles:\n${titles}`
      : "I couldn't generate an answer right now, and I don't have any recent posts to show.";
  }

  // Reply only to the origin transport so questions don't mirror everywhere.
  const delivery = deps.delivery ?? createDelivery(ctx);
  if (delivery.targets.length > 0) {
    if (provider === 'relay') {
      // Relay DMs: reply to Slack if configured (legacy behavior).
      // If only Telegram is configured, reply there instead.
      const targets: Array<'slack' | 'telegram'> = delivery.targets.includes('slack') ? ['slack'] : [...delivery.targets];
      // When using injected mock, just publish directly (target filtering is
      // the test's responsibility). When using real client, scope to targets.
      const scoped = deps.delivery
        ? delivery
        : createDelivery(ctx, undefined, targets);
      await scoped.publish(answer.trim() || 'No answer available.');
    } else {
      // Telegram Q&A: reply ONLY to Telegram.
      const scoped = deps.delivery
        ? delivery
        : createDelivery(ctx, undefined, [provider]);
      await scoped.publish(answer.trim() || 'No answer available.');
    }
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
    ctx.log('info', 'hn-monitor.summarizing', { fresh: fresh.length });
    const { header, body } = await summarize(ctx, fresh);
    ctx.log('info', 'hn-monitor.posting', { targets: delivery.targets });

    // Publish the header non-blocking: returns draft refs immediately
    // (zero receipt round-trips). The cloud orders threaded messages under
    // the header server-side via parentRef — the x-reply-radar pattern.
    const heads = await delivery.publish(header);
    if (heads.refs.length === 0 || heads.refs.length < delivery.targets.length) {
      throw new Error(`Header publish failed across all targets`);
    }
    headerPosted = true;
    ctx.log('info', 'hn-monitor.header-published', { refs: heads.refs.length });

    // Build pending state BEFORE sending the body, so even if delivery.send()
    // throws (hard failure, not just ok:false), the catch block can save state
    // for recovery on the next cron tick.
    const pendingBase = {
      targets: [...delivery.targets].sort().join(','),
      header,
      body,
      createdAt: new Date().toISOString(),
      stories: fresh.map((s) => ({ title: s.title, url: s.url, points: s.points })),
      headerRefs: saveHeaderRefs(heads)
    };

    // Thread the body under each header, also non-blocking.
    const bodyResult = await delivery.send(body, { replyTo: heads, nonBlocking: true });
    // In non-blocking mode, ok=true means at least one target got a draft ref.
    // Check that ALL attempted targets received refs — if any were lost, treat
    // as partial failure so the pending-recovery path saves state for retry.
    if (!bodyResult.ok || bodyResult.refs.length < delivery.targets.length) {
      pending = pendingBase;
      throw new Error(`Threaded body failed on some targets`);
    }
    ctx.log('info', 'hn-monitor.posted', { targets: delivery.targets.join(',') });

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
        .catch((error) => ctx.log('error', 'hn-monitor.pending-save-failed', { error: String(error) }));
    }
    // The header already posted; releasing + rethrowing would duplicate it on
    // the runtime's retry. Keep the claim and let the next scan retry the body.
    ctx.log('error', 'hn-monitor.thread-incomplete', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Serialize DeliveryResult.refs into storable headerRefs. */
function saveHeaderRefs(result: DeliveryResult): PendingThreadBody['headerRefs'] {
  return result.refs.map((r) => ({
    provider: r.provider,
    // For Slack: draftRef is the relay path (parentRef). For Telegram:
    // store the messageId in draftRef so recovery can reconstruct threading.
    draftRef: 'draftRef' in r ? r.draftRef : r.messageId,
    channel: r.provider === 'slack' ? (r as import('@agentworkforce/delivery').SlackRef).channel : undefined,
    chatId: r.provider === 'telegram' ? (r as import('@agentworkforce/delivery').TelegramRef).chatId : undefined
  }));
}

// ── pending thread body recovery ─────────────────────────────────────────

export async function retryPendingThreadBody(
  ctx: WorkforceCtx,
  delivery: DeliveryClient
): Promise<boolean> {
  const pending = await loadPendingThreadBody(ctx);
  if (!pending) return false;
  // Compare targets with canonical ordering to avoid order-dependent mismatch.
  const configuredTargets = [...delivery.targets].sort().join(',');
  if (pending.targets !== configuredTargets) {
    // Targets changed since the body was saved — clean up the stale record
    // so it doesn't sit in memory until TTL expiry.
    await clearPendingThreadBody(ctx).catch(() => {});
    return false;
  }

  // Reconstruct replyTo from saved headerRefs for proper threading on retry.
  const bodyOpts = pending.headerRefs?.length
    ? {
        nonBlocking: true as const,
        replyTo: {
          ok: true,
          refs: rebuildHeaderRefs(pending.headerRefs)
        }
      }
    : { nonBlocking: true as const };

  const bodyResult = await delivery.send(pending.body, bodyOpts);
  // Match postFreshStories: ALL targets must receive refs for success.
  if (!bodyResult.ok || bodyResult.refs.length < delivery.targets.length) {
    ctx.log('error', 'hn-monitor.pending-body-retry-failed', { targets: configuredTargets });
    return true;
  }

  await savePost(ctx, {
    postedAt: new Date().toISOString(),
    digest: `${pending.header}\n${pending.body}`,
    stories: pending.stories
  });
  await clearPendingThreadBody(ctx);
  ctx.log('info', 'hn-monitor.pending-body-posted', { targets: configuredTargets });
  return true;
}

/** Reconstruct MessageRefs from stored headerRefs, with correct threading ids. */
function rebuildHeaderRefs(
  stored: PendingThreadBody['headerRefs']
): Array<import('@agentworkforce/delivery').MessageRef> {
  return stored.map((r) => {
    if (r.provider === 'telegram') {
      // For Telegram, draftRef stores the original messageId — use it for
      // reply_to_message_id threading on retry.
      return {
        provider: 'telegram' as const,
        chatId: r.chatId ?? '',
        messageId: r.draftRef
      };
    }
    return {
      provider: 'slack' as const,
      channel: r.channel ?? '',
      ts: '',
      draftRef: r.draftRef
    };
  });
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
    ctx.log('warn', 'hn-monitor.llm-fallback', { error: String(error) });
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
