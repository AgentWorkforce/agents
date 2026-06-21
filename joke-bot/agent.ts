/**
 * joke-bot handler.
 *
 *   relay inbox DM OR Slack @mention arrives
 *     → pull the recent conversation from memory (multi-turn threading)
 *     → ask ctx.llm.complete (subscription-backed, direct inference) for a joke
 *     → post it to Slack (writeback) — the chat reply surface
 *     → save the turn back to memory so the next message can do callbacks
 *
 * Reply generation uses ctx.llm.complete (NOT ctx.harness.run): a direct LLM
 * call (sub-second) instead of booting a full harness CLI session (minutes).
 * Combined with `sandbox: false` (persona), the handler runs in the persona
 * runner with no Daytona box — the right shape for a lightweight reply bot.
 * (Testing the claude/codex/opencode harness CLIs is a separate exercise that
 * needs ctx.harness.run + sandbox:true.)
 */
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

const CONVO_TURNS = 6; // how much recent back-and-forth to feed the model

// ctx.llm.complete() takes only { maxTokens } — no system option — so the
// persona's voice rides as a preamble on the prompt.
const COMEDIAN_PREAMBLE =
  'You are a sharp, fast stand-up comedian who riffs on current events, tech, and pop culture. ' +
  'Keep replies short (1-3 lines), punchy, and genuinely funny — a clever observation or tight ' +
  'setup→punchline over puns. Good-natured: no slurs, no punching down, nothing mean about the ' +
  'person you are talking to. If the user is continuing an earlier bit, build on it (callback humor). ' +
  'Output ONLY the reply text — no preamble, no quotes, no stage directions.';

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}

/** Generate a joke via direct LLM inference (subscription-backed). */
async function joke(ctx: WorkforceCtx, context: string): Promise<string> {
  const reply = (await ctx.llm.complete(`${COMEDIAN_PREAMBLE}\n\n${context}`, { maxTokens: 300 })).trim();
  if (!reply) throw new Error('ctx.llm.complete returned an empty reply');
  return reply;
}

async function readQuestion(event: AgentEvent): Promise<string> {
  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data;
  const nested = (data?.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const text = typeof data?.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';
  return text.trim();
}

function toLines(records: unknown): string[] {
  if (!Array.isArray(records)) return [];
  return records
    .map((r) => (typeof r === 'string' ? r : (r as { content?: unknown })?.content))
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

async function recall(ctx: WorkforceCtx, tag: string): Promise<string[]> {
  return toLines(
    await ctx.memory.recall('recent joke-bot conversation', { tags: [tag], limit: CONVO_TURNS, scope: 'workspace' }).catch(() => [])
  );
}

async function remember(ctx: WorkforceCtx, tag: string, user: string, reply: string): Promise<void> {
  await ctx.memory
    .save(`User: ${user}\njoke-bot: ${reply}`, { tags: [tag], scope: 'workspace', ttlSeconds: 30 * 24 * 60 * 60 })
    .catch((e) => ctx.log?.('warn', 'joke-bot.memory-save-failed', { error: String(e) }));
}

function buildPrompt(history: string[], question: string): string {
  return [
    history.length > 0 ? `Conversation so far (oldest first):\n${history.join('\n')}\n` : '',
    `The user just said: ${question}`,
    '',
    'Reply with a single short, funny joke or comeback.'
  ].filter(Boolean).join('\n');
}

export default defineAgent({
  schedules: [{ name: 'joke-of-the-day', cron: '0 16 * * *', tz: 'UTC' }],
  triggers: {
    // NOTE: trigger `match` is currently NOT enforced by the cloud dispatch
    // (parse-validated then dropped) — kept here for when cloud enforcement lands
    // (AgentWorkforce/cloud). With `sandbox: false` there is no box to waste
    // anyway, so the per-message wake is cheap (handler returns in ms).
    slack: [
      { on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'], match: '@mention' }
    ]
  },

  handler: async (ctx: WorkforceCtx, event: AgentEvent) => {
    if (isCronTickEvent(event)) {
      await handleJokeOfTheDay(ctx);
      return;
    }
    if (typeof event.type === 'string' && event.type.startsWith('slack.')) {
      await handleSlackMention(ctx, event);
      return;
    }
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
    const tag = `joke-convo:${channel}`;
    const reply = await joke(ctx, buildPrompt(await recall(ctx, tag), question));
    const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, reply);
    if (!result?.ts) throw new Error('Slack post returned no receipt ts');
    await remember(ctx, tag, question, reply);
    ctx.log?.('info', 'joke-bot.replied', { channel, surface: 'relay', chars: reply.length });
  }
});

/** Slack @mention path: reply in-thread, with per-thread memory. */
async function handleSlackMention(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const data = ((await event.expand('full').catch(() => undefined)) as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const channel = typeof data.channel === 'string' ? data.channel : undefined;
  const ts = typeof data.ts === 'string' ? data.ts : undefined;
  if (!channel || !ts) {
    ctx.log?.('info', 'joke-bot.slack-no-target', { reason: 'missing channel/ts' });
    return;
  }
  // Channel guard: only ever reply in the configured channel. The slack trigger
  // wakes across channels (broad slack scope feeds the wake-path match, and the
  // trigger `match` gate isn't enforced cloud-side yet), so without this joke-bot
  // would answer @mentions in ANY channel. Normalize `id__name` → `id`.
  const want = input(ctx, 'SLACK_CHANNEL');
  const chanId = channel.split('__')[0];
  if (want && chanId !== want) {
    ctx.log?.('info', 'joke-bot.slack-wrong-channel', { channel: chanId, want });
    return;
  }
  if (data.is_bot === true || data.bot_id || (typeof data.subtype === 'string' && data.subtype)) {
    ctx.log?.('info', 'joke-bot.slack-skip', { reason: 'bot or non-plain message' });
    return;
  }
  const rawText = typeof data.text === 'string' ? data.text : '';
  if (!/<@[^>]+>/.test(rawText)) {
    ctx.log?.('info', 'joke-bot.slack-no-mention', { reason: 'message did not mention the bot; skipping' });
    return;
  }
  const threadTs = typeof data.thread_ts === 'string' && data.thread_ts ? data.thread_ts : ts;
  const question = rawText.replace(/<@[^>]+>/g, '').trim();
  if (!question) {
    ctx.log?.('info', 'joke-bot.slack-empty', { reason: 'no text after stripping mention' });
    return;
  }

  const tag = `joke-convo:slack:${channel}:${threadTs}`;
  const reply = await joke(ctx, buildPrompt(await recall(ctx, tag), question));
  const result = await slackClient({ writebackTimeoutMs: 15_000 }).reply(channel, threadTs, reply);
  if (!result?.ts) throw new Error('Slack reply returned no receipt ts');
  await remember(ctx, tag, question, reply);
  ctx.log?.('info', 'joke-bot.slack-replied', { channel, threadTs, chars: reply.length });
}

/** Scheduled path: post one topical joke of the day. */
async function handleJokeOfTheDay(ctx: WorkforceCtx): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) {
    ctx.log?.('warn', 'joke-bot.no-channel', { reason: 'SLACK_CHANNEL not set; skipping joke of the day' });
    return;
  }
  const reply = await joke(ctx, 'Give me one short, original "joke of the day" about recent tech / pop-culture / current events.');
  const result = await slackClient({ writebackTimeoutMs: 15_000 }).post(channel, `🃏 Joke of the day:\n${reply}`);
  if (!result?.ts) throw new Error('Slack post returned no receipt ts for joke of the day');
  ctx.log?.('info', 'joke-bot.jotd-posted', { channel });
}
