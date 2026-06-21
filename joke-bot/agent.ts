/**
 * joke-bot handler.
 *
 *   relay inbox message arrives (you DM the agent)
 *     → pull the recent conversation from memory (multi-turn threading)
 *     → ask the persona's HARNESS (claude/codex/opencode) for a joke reply
 *     → post it to Slack (writeback) — the chat reply surface
 *     → save the turn back to memory so the next message can do callbacks
 *
 * The joke is generated with ctx.harness.run (NOT ctx.llm.complete) on purpose:
 * that runs the persona's configured harness, so this same agent tests
 * claude / codex / opencode just by flipping `harness` in persona.ts.
 */
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

const CONVO_TURNS = 6; // how much recent back-and-forth to feed the harness

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}

/** Extract the user's text from a relaycast.message event (fields ride in the
 *  expanded payload; mirror neon-monitor's inbox extraction). */
async function readQuestion(event: AgentEvent): Promise<string> {
  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const text = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  return text.trim();
}

/** Coerce a memory recall result into plain strings regardless of record shape. */
function toLines(records: unknown): string[] {
  if (!Array.isArray(records)) return [];
  return records
    .map((r) => (typeof r === 'string' ? r : (r as { content?: unknown })?.content))
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

export default defineAgent({
  // A daily joke-of-the-day gives the agent a real scheduled listener and
  // exercises the harness+Slack path on its own.
  schedules: [{ name: 'joke-of-the-day', cron: '0 16 * * *', tz: 'UTC' }],

  // Slack-native chat: @mention the bot in the configured channel and it replies
  // in-thread. (The relaycast inbox path below still works too, via persona.relay.)
  triggers: {
    // This Slack workspace emits `message.created` (NOT `app_mention`) — the
    // proven model (linear-slack, review). The channel-scoped path is the wake
    // gate (cloud intersects it before provisioning), so joke-bot only wakes for
    // proj-cloud messages; the handler then replies ONLY when @mentioned.
    // `${SLACK_CHANNEL}` is a deploy-time placeholder (single quotes = literal).
    slack: [
      { on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'], match: '@mention' }
    ]
  },

  handler: async (ctx: WorkforceCtx, event: AgentEvent) => {
    // Clock path: post a topical joke of the day.
    if (isCronTickEvent(event)) {
      await handleJokeOfTheDay(ctx);
      return;
    }
    // Slack path: someone @mentioned the bot — reply in-thread (this is what
    // you trigger by messaging it in Slack, and it exercises the harness).
    if (typeof event.type === 'string' && event.type.startsWith('slack.')) {
      await handleSlackMention(ctx, event);
      return;
    }
    // Relaycast path: a relay DM arrived — reply with a joke.
    if (!isRelaycastMessageEvent(event)) return;

    const channel = input(ctx, 'SLACK_CHANNEL');
    if (!channel) {
      ctx.log?.('warn', 'joke-bot.no-channel', { reason: 'SLACK_CHANNEL not set; cannot reply' });
      return;
    }

    const question = await readQuestion(event);
    if (!question) {
      ctx.log?.('info', 'joke-bot.empty', { reason: 'no text in message; skipping' });
      return;
    }

    const convoTag = `joke-convo:${channel}`;

    // Multi-turn threading: recall the recent conversation so the harness can
    // do callbacks instead of treating every message as a cold start.
    const history = toLines(
      await ctx.memory
        .recall('recent joke-bot conversation turns', { tags: [convoTag], limit: CONVO_TURNS, scope: 'workspace' })
        .catch(() => [])
    );

    const prompt = [
      history.length > 0 ? `Conversation so far (oldest first):\n${history.join('\n')}\n` : '',
      `The user just said: ${question}`,
      '',
      'Reply with a single short, funny joke or comeback. Output ONLY the reply text — no preamble, no quotes, no stage directions.'
    ].filter(Boolean).join('\n');

    const run = await ctx.harness.run({ prompt });
    const reply = (run.output ?? '').trim();
    if (run.exitCode !== 0 || !reply) {
      ctx.log?.('error', 'joke-bot.harness-failed', { exitCode: run.exitCode, stderr: run.stderr?.slice(0, 500) });
      throw new Error(`harness returned no usable reply (exit ${run.exitCode})`);
    }

    const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, reply);
    if (!result?.ts) {
      ctx.log?.('error', 'joke-bot.post-failed', { reason: 'Slack post returned no receipt ts' });
      throw new Error('Slack post returned no receipt ts; treating as delivery failure');
    }

    // Persist this turn for callback humor on the next message.
    await ctx.memory
      .save(`User: ${question}\njoke-bot: ${reply}`, { tags: [convoTag], scope: 'workspace', ttlSeconds: 30 * 24 * 60 * 60 })
      .catch((e) => ctx.log?.('warn', 'joke-bot.memory-save-failed', { error: String(e) }));

    ctx.log?.('info', 'joke-bot.replied', { channel, harness: ctx.persona?.harness, chars: reply.length });
  }
});

/** Scheduled path: ask the harness for one topical joke and post it. */
async function handleJokeOfTheDay(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log?.('warn', 'joke-bot.no-channel', { reason: 'SLACK_CHANNEL not set; skipping joke of the day' });
    return;
  }

  const run = await ctx.harness.run({
    prompt:
      'Give me one short, original "joke of the day" about recent tech / pop-culture / current events. ' +
      'Output ONLY the joke text — no preamble, no quotes.'
  });
  const joke = (run.output ?? '').trim();
  if (run.exitCode !== 0 || !joke) {
    ctx.log?.('error', 'joke-bot.jotd-harness-failed', { exitCode: run.exitCode, stderr: run.stderr?.slice(0, 500) });
    throw new Error(`harness returned no joke of the day (exit ${run.exitCode})`);
  }

  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, `🃏 Joke of the day:\n${joke}`);
  if (!result?.ts) throw new Error('Slack post returned no receipt ts for joke of the day');
  ctx.log?.('info', 'joke-bot.jotd-posted', { channel, harness: ctx.persona?.harness });
}

/** Slack @mention path: reply in-thread with a joke, with per-thread memory. */
async function handleSlackMention(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const data = ((await event.expand('full').catch(() => undefined)) as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const channel = typeof data.channel === 'string' ? data.channel : undefined;
  const ts = typeof data.ts === 'string' ? data.ts : undefined;
  if (!channel || !ts) {
    ctx.log?.('info', 'joke-bot.slack-no-target', { reason: 'missing channel/ts' });
    return;
  }
  // Never reply to bots (including ourselves) or edited/deleted/system messages.
  if (data.is_bot === true || data.bot_id || (typeof data.subtype === 'string' && data.subtype)) {
    ctx.log?.('info', 'joke-bot.slack-skip', { reason: 'bot or non-plain message' });
    return;
  }

  // Reply ONLY when actually @mentioned — otherwise we'd answer every message
  // in the channel (the wake fires on all `message.created`).
  const rawText = typeof data.text === 'string' ? data.text : '';
  if (!/<@[^>]+>/.test(rawText)) {
    ctx.log?.('info', 'joke-bot.slack-no-mention', { reason: 'message did not mention the bot; skipping' });
    return;
  }

  const threadTs = typeof data.thread_ts === 'string' && data.thread_ts ? data.thread_ts : ts;
  // Strip the "<@U...>" mention token(s) so the harness sees just the ask.
  const question = rawText.replace(/<@[^>]+>/g, '').trim();
  if (!question) {
    ctx.log?.('info', 'joke-bot.slack-empty', { reason: 'no text after stripping mention' });
    return;
  }

  const convoTag = `joke-convo:slack:${channel}:${threadTs}`;
  const history = toLines(
    await ctx.memory
      .recall('recent joke-bot thread', { tags: [convoTag], limit: CONVO_TURNS, scope: 'workspace' })
      .catch(() => [])
  );

  const prompt = [
    history.length > 0 ? `Conversation so far (oldest first):\n${history.join('\n')}\n` : '',
    `The user just said: ${question}`,
    '',
    'Reply with a single short, funny joke or comeback. Output ONLY the reply text — no preamble, no quotes, no stage directions.'
  ].filter(Boolean).join('\n');

  const run = await ctx.harness.run({ prompt });
  const reply = (run.output ?? '').trim();
  if (run.exitCode !== 0 || !reply) {
    ctx.log?.('error', 'joke-bot.slack-harness-failed', { exitCode: run.exitCode, stderr: run.stderr?.slice(0, 500) });
    throw new Error(`harness returned no usable reply (exit ${run.exitCode})`);
  }

  // Thread the reply under the user's message (ts-based threading).
  const result = await slackClient({ writebackTimeoutMs: 15_000 }).reply(channel, threadTs, reply);
  if (!result?.ts) {
    ctx.log?.('error', 'joke-bot.slack-reply-failed', { reason: 'Slack reply returned no receipt ts' });
    throw new Error('Slack reply returned no receipt ts');
  }

  await ctx.memory
    .save(`User: ${question}\njoke-bot: ${reply}`, { tags: [convoTag], scope: 'workspace', ttlSeconds: 30 * 24 * 60 * 60 })
    .catch((e) => ctx.log?.('warn', 'joke-bot.memory-save-failed', { error: String(e) }));

  ctx.log?.('info', 'joke-bot.slack-replied', { channel, threadTs, harness: ctx.persona?.harness, chars: reply.length });
}
