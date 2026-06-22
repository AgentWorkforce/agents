/**
 * hn-monitor-telegram handler.
 *
 *   cron tick
 *     → fetch the HN front page
 *     → keep stories whose title matches one of your TOPICS
 *     → drop ones already posted (durable memory)
 *     → summarize with ctx.llm
 *     → post a compact count header to Telegram, then thread the digest under it
 *
 *   telegram message
 *     → answer questions about what's been posted (recall ~30 days of digests)
 *
 * The Telegram sibling of hn-monitor: same scan/summarize/Q&A, Telegram instead
 * of Slack. Threading is native (reply_to_message_id) — simpler than slack's
 * header+parentRef dance. Uses the shared Telegram transport (../shared/telegram.ts).
 */
import {
  defineAgent,
  isCronTickEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import {
  readTelegramMessage,
  skipReason,
  replyToMessage,
  defaultTelegram,
  bareChatId,
  type TelegramSender
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

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  triggers: {
    // Q&A: message the bot to ask about recently posted digests.
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    if (typeof event.type === 'string' && event.type.startsWith('telegram.')) {
      await handleTelegramMessage(ctx, event as unknown as AgentEvent);
      return;
    }
    if (!isCronTickEvent(event as unknown as AgentEvent)) return;

    const chat = input(ctx, 'TELEGRAM_CHAT');
    if (!chat) throw new Error('TELEGRAM_CHAT is required');
    const topics = list(input(ctx, 'TOPICS')).map((t) => t.toLowerCase());

    const stories = await fetchFrontPage();
    ctx.log?.('info', 'hn-monitor-telegram.fetched', { stories: stories.length });
    const matches = stories.filter((s) => topics.some((t) => s.title.toLowerCase().includes(t)));
    ctx.log?.('info', 'hn-monitor-telegram.matched', { matched: matches.length });

    const seen = await loadSeen(ctx);
    const fresh = matches.filter((s) => !seen.includes(s.id));
    ctx.log?.('info', 'hn-monitor-telegram.fresh', { fresh: fresh.length });
    if (fresh.length === 0) {
      ctx.log?.('info', 'hn-monitor-telegram.nothing-new', { matched: matches.length });
      return;
    }

    await postFreshStories(ctx, chat, seen, fresh);
  }
});

/** Q&A path: recall recent digests and answer the user's question over Telegram. */
export async function handleTelegramMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: { complete?: (prompt: string) => Promise<string>; telegram?: TelegramSender } = {}
): Promise<void> {
  const msg = readTelegramMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'hn-monitor-telegram.inbox.unparseable');
    return;
  }
  const reason = skipReason(msg, input(ctx, 'TELEGRAM_CHAT'));
  if (reason) {
    ctx.log?.('info', `hn-monitor-telegram.inbox.skip reason=${reason.replace(/\s+/g, '-')}`);
    return;
  }

  const posts = await loadPosts(ctx);
  ctx.log?.('info', 'hn-monitor-telegram.inbox.recalled', { posts: posts.length });

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
    msg.text.trim()
  ].join('\n');

  const complete = deps.complete ?? ((p: string) => ctx.llm.complete(p, { maxTokens: 1024 }));
  let answer: string;
  try {
    answer = await withTimeout(complete(prompt), 45_000, 'ctx.llm.complete');
  } catch (error) {
    ctx.log?.('warn', 'hn-monitor-telegram.llm-fallback', { error: String(error) });
    const titles = posts
      .flatMap((p) => (p.stories ?? []).map((s) => `- ${s.title ?? 'Untitled'} ${s.url ?? ''}`))
      .slice(0, 15)
      .join('\n');
    answer = titles
      ? `I couldn't generate an answer right now; here are the recent post titles:\n${titles}`
      : "I couldn't generate an answer right now, and I don't have any recent posts to show.";
  }

  const tg = deps.telegram ?? defaultTelegram();
  await replyToMessage(ctx, tg, msg, answer.trim() || 'No answer available.');
}

export async function postFreshStories(
  ctx: WorkforceCtx,
  chat: string,
  seen: number[],
  fresh: Story[],
  deps: { complete?: (prompt: string) => Promise<string>; telegram?: TelegramSender } = {}
): Promise<void> {
  // Claim the stories as seen BEFORE the post (at-least-once concurrency guard;
  // a cron tick can re-invoke this handler — cloud#1990).
  await saveSeen(ctx, [...seen, ...fresh.map((s) => s.id)].slice(-200));
  // Once the header posts, a thrown handler is retried by the runtime and would
  // re-post a duplicate header — so only release the claim + rethrow while
  // nothing has posted yet.
  let headerPosted = false;
  try {
    ctx.log?.('info', 'hn-monitor-telegram.summarizing', { fresh: fresh.length });
    const { header, body } = await summarize(ctx, fresh, deps.complete);
    const tg = deps.telegram ?? defaultTelegram();

    // Native Telegram threading: post the header, then post the digest with
    // reply_to_message_id = the header's delivered message id. ok:false means the
    // writeback got no receipt (silent drop) — treat it as a loud failure.
    const head = await tg.send(bareChatId(chat), header);
    if (!head.ok) throw new Error(`Telegram header post to ${bareChatId(chat)} got no writeback receipt (silent drop)`);
    headerPosted = true;
    ctx.log?.('info', 'hn-monitor-telegram.header-posted', { messageId: head.messageId });
    const replyToMessageId = head.messageId ? Number(head.messageId) || undefined : undefined;
    const reply = await tg.send(bareChatId(chat), body, { replyToMessageId });
    if (!reply.ok) throw new Error(`Telegram threaded digest to ${bareChatId(chat)} got no writeback receipt (silent drop)`);
    ctx.log?.('info', 'hn-monitor-telegram.posted', { messageId: head.messageId });

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
    // The header already posted; releasing + rethrowing would duplicate it on
    // the runtime's retry. Keep the claim and log loudly instead.
    ctx.log?.('error', 'hn-monitor-telegram.thread-incomplete', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Top ~30 front-page stories via the public HN Algolia API. Returns [] on any
 *  network/parse failure so a transient outage doesn't crash the run. */
async function fetchFrontPage(): Promise<Story[]> {
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30');
    if (!res.ok) return [];
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

/** Split into the count `header` (parent) and the `body` (threaded digest).
 *  summarize() must ALWAYS return a postable body — on timeout/error it falls
 *  back to a plain bulleted digest from the story lines. */
async function summarize(
  ctx: WorkforceCtx,
  stories: Story[],
  complete?: (prompt: string) => Promise<string>
): Promise<{ header: string; body: string }> {
  const lines = stories.map((s) => `- ${s.title} (${s.points} pts) ${s.url}`).join('\n');
  const header = `📰 Hacker News — ${stories.length} new match(es)`;
  const run = complete ?? ((p: string) => ctx.llm.complete(p, { maxTokens: 500 }));
  try {
    const digest = await withTimeout(
      run(`Write a tight digest (one bullet per story, lead with why it matters):\n\n${lines}`),
      45_000,
      'ctx.llm.complete'
    );
    return { header, body: digest.trim() };
  } catch (error) {
    ctx.log?.('warn', 'hn-monitor-telegram.llm-fallback', { error: String(error) });
    return { header, body: lines };
  }
}

/** Race a promise against a timeout so a hung LLM can't stall the run. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
async function loadSeen(ctx: WorkforceCtx): Promise<number[]> {
  const [item] = await ctx.memory.recall('hn-monitor seen', { tags: ['hn-monitor-telegram:seen'], limit: 1 });
  try {
    return item ? (JSON.parse(item.content) as number[]) : [];
  } catch {
    return [];
  }
}
async function saveSeen(ctx: WorkforceCtx, ids: number[]): Promise<void> {
  await ctx.memory.save(JSON.stringify(ids), { tags: ['hn-monitor-telegram:seen'], scope: 'workspace' });
}
async function savePost(ctx: WorkforceCtx, record: PostRecord): Promise<void> {
  await ctx.memory.save(JSON.stringify(record), { tags: ['hn-monitor-telegram:post'], scope: 'workspace' });
}
/** Recalls recent posted digests, newest first, dropping any malformed record. */
async function loadPosts(ctx: WorkforceCtx): Promise<PostRecord[]> {
  const items = await ctx.memory.recall('hn-monitor posted digest', {
    tags: ['hn-monitor-telegram:post'],
    scope: 'workspace',
    limit: 60
  });
  const posts: PostRecord[] = [];
  for (const item of items) {
    try {
      posts.push(JSON.parse(item.content) as PostRecord);
    } catch {
      // skip records that aren't valid JSON
    }
  }
  return posts.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
}
