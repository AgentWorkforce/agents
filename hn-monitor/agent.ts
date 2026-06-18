/**
 * hn-monitor handler.
 *
 *   fetch the HN front page
 *     → keep stories whose title matches one of your TOPICS
 *     → drop ones already posted (durable memory)
 *     → summarize with ctx.llm
 *     → post to Slack
 */
import { defineAgent, isCronTickEvent, type WorkforceCtx } from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

export interface Story {
  id: number;
  title: string;
  url: string;
  points: number;
}

export default defineAgent({
  // Runs on a clock (09:00 & 17:00), not an event. No triggers needed.
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  handler: async (ctx, event) => {
  if (!isCronTickEvent(event)) return;

  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const topics = list(input(ctx, 'TOPICS')).map((t) => t.toLowerCase());

  const stories = await fetchFrontPage();
  const matches = stories.filter((s) => topics.some((t) => s.title.toLowerCase().includes(t)));

  const seen = await loadSeen(ctx);
  const fresh = matches.filter((s) => !seen.includes(s.id));
  if (fresh.length === 0) {
    ctx.log('info', 'hn-monitor.nothing-new', { matched: matches.length });
    return;
  }

  await postFreshStories(ctx, channel, seen, fresh);
  }
});

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
    const digest = await summarize(ctx, fresh);
    // post() resolves with ts:'' (no throw) when the writeback gets no receipt,
    // so an empty ts is a SILENT DROP, not success — make it a loud failure
    // (matches daytona-monitor / pr-reviewer). Without this, a dropped digest
    // looked like a success and was never retried.
    const res = await client.post(channel, digest);
    if (!res.ts) throw new Error(`Slack post to ${channel} got no writeback receipt (silent drop)`);
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
