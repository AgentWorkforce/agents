/**
 * hn-monitor handler.
 *
 *   fetch the HN front page
 *     → keep stories whose title matches one of your TOPICS
 *     → drop ones already posted (durable memory)
 *     → summarize with ctx.llm
 *     → post to Slack
 */
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

export interface Story {
  id: number;
  title: string;
  url: string;
  points: number;
}

/**
 * A digest we posted, stored durably under `hn-monitor:post`. Memory `ttlDays`
 * (30) gives the rolling retention window for free, so a recall returns roughly
 * the last month of posts for the inbox Q&A path to answer over.
 */
export interface PostRecord {
  postedAt: string;
  digest: string;
  stories: Array<{ title: string; url: string; points: number }>;
}

export default defineAgent({
  // Runs on a clock (09:00 & 17:00), not an event. No triggers needed.
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  handler: async (ctx, event) => {
    // Chat path: a relay DM arrived — answer questions about what we've posted.
    if (isRelaycastMessageEvent(event)) {
      await handleInboxMessage(ctx, event);
      return;
    }
    if (!isCronTickEvent(event)) return;

    const channel = input(ctx, 'SLACK_CHANNEL');
    if (!channel) throw new Error('SLACK_CHANNEL is required');
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

    await postFreshStories(ctx, channel, seen, fresh);
  }
});

/**
 * Chat handler: when someone DMs the agent via the relay inbox, recall the last
 * ~30 days of posted digests and use the LLM to answer their question grounded
 * ONLY in those stored posts, then post the answer to SLACK_CHANNEL.
 */
export async function handleInboxMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  client: SlackPoster = slackClient({ writebackTimeoutMs: 15_000 })
): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');

  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const question = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  if (!question.trim()) {
    ctx.log('info', 'hn-monitor.inbox.no-text');
    return;
  }

  const posts = await loadPosts(ctx);
  ctx.log('info', 'hn-monitor.inbox.recalled', { posts: posts.length });

  const context = posts.length
    ? posts.map((p) => `### Posted ${p.postedAt}\n${p.digest}`).join('\n\n')
    : 'No Hacker News digests have been posted yet.';

  const prompt = [
    'You are a Hacker News monitor. Answer the user\'s question using ONLY the recently posted digests below.',
    'Do not invent stories or facts that are not present in the posts. If the posts do not cover the question, say so.',
    'Be concise and use Slack mrkdwn formatting.',
    '',
    '## Recently posted digests (most recent ~30 days)',
    context,
    '',
    '## User question',
    question
  ].join('\n');

  const answer = await ctx.llm.complete(prompt, { maxTokens: 1024 });

  const res = await client.post(channel, answer);
  if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
}

interface SlackPoster {
  post(channel: string, text: string): Promise<{ ts: string }>;
}

export async function postFreshStories(
  ctx: WorkforceCtx,
  channel: string,
  seen: number[],
  fresh: Story[],
  client: SlackPoster = slackClient({ writebackTimeoutMs: 15_000 })
): Promise<void> {
  // Claim the stories as seen BEFORE the post. Cron delivery is at-least-once: a
  // single tick can re-invoke this handler (cloud re-runs a delivery whose lease
  // expires before it reports done — see AgentWorkforce/cloud#1990). Claiming
  // first means a concurrent re-invocation loads these ids as already-seen and
  // stays silent instead of double-posting.
  await saveSeen(ctx, [...seen, ...fresh.map((s) => s.id)].slice(-200));
  try {
    ctx.log('info', 'hn-monitor.summarizing', { fresh: fresh.length });
    const digest = await summarize(ctx, fresh);
    // post() resolves with ts:'' (no throw) when the writeback gets no receipt,
    // so an empty ts is a SILENT DROP, not success — make it a loud failure
    // (matches daytona-monitor / pr-reviewer). Without this, a dropped digest
    // looked like a success and was never retried.
    ctx.log('info', 'hn-monitor.posting', { channel });
    const res = await client.post(channel, digest);
    if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
    ctx.log('info', 'hn-monitor.posted', { ts: res.ts });
    // Retain the digest so a user can DM the agent and ask about recent posts.
    // ttlDays (30) on memory ages these out, giving a rolling ~30-day window.
    await savePost(ctx, {
      postedAt: new Date().toISOString(),
      digest,
      stories: fresh.map((s) => ({ title: s.title, url: s.url, points: s.points }))
    });
  } catch (err) {
    // The claim was provisional: summarize or post failed, so RELEASE it by
    // restoring the prior seen set. The next tick then retries this digest
    // instead of dropping it forever — the old behavior marked the stories seen
    // permanently, so a single transient LLM/Slack failure made the agent go
    // silent for good. Releasing keeps the double-post guard (ids stay claimed
    // for the duration of the attempt) while making a failed run self-heal.
    await saveSeen(ctx, seen).catch(() => {});
    throw err;
  }
}

/** Top ~30 front-page stories via the public HN Algolia API. Returns [] on
 *  any network/parse failure so a transient outage doesn't crash the run. */
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

async function summarize(ctx: WorkforceCtx, stories: Story[]): Promise<string> {
  const lines = stories.map((s) => `- ${s.title} (${s.points} pts) ${s.url}`).join('\n');
  const digest = await ctx.llm.complete(
    `Write a tight Slack digest (mrkdwn, one bullet per story, lead with why it matters):\n\n${lines}`,
    { maxTokens: 500 }
  );
  return `:newspaper: *Hacker News* — ${stories.length} new match(es)\n${digest.trim()}`;
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
/** Recalls recent posted digests, newest first, dropping any malformed record. */
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
      // skip records that aren't valid JSON
    }
  }
  return posts.sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));
}
