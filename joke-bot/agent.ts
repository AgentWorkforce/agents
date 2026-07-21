/**
 * joke-bot handler — dual-transport conversational joke bot (Slack and/or Telegram).
 *
 *   Slack @mention / relay-inbox DM / Telegram message arrives
 *     → pull the recent conversation from memory (multi-turn threading)
 *     → ask ctx.llm.complete (subscription-backed, direct inference) for a joke
 *     → reply on the ORIGIN transport (Slack thread / channel, or Telegram chat)
 *     → save the turn back to memory so the next message can do callbacks
 *
 *   cron tick (daily)
 *     → post one topical "joke of the day" to EVERY configured transport
 *
 * Transport is configuration-driven (workforce#252): the persona gates `slack` on
 * SLACK_CHANNEL and `telegram` on TELEGRAM_CHAT, so the unconfigured transport is
 * pruned at deploy. Reply generation uses ctx.llm.complete (a direct LLM call),
 * and with sandbox:false the writeback goes over the relayfile HTTP API — no
 * Daytona box. The Slack transport is inline (slackClient); Telegram uses the
 * shared transport (../shared/telegram.ts).
 */
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';
import {
  readTelegramMessage,
  skipReason as telegramSkipReason,
  conversationKeyForTelegram,
  replyToMessage,
  defaultTelegram,
  bareChatId,
  type TelegramSender
} from '../shared/telegram.js';

const CONVO_TURNS = 6; // how much recent back-and-forth to feed the model
const LLM_TIMEOUT_MS = 30_000;
const FALLBACK_JOKE = "I hit a dead mic for a second, but I'm still here. Try me again?";

// ctx.llm.complete() takes only { maxTokens } — no system option — so the
// persona's voice rides as a preamble on the prompt.
const COMEDIAN_PREAMBLE =
  'You are a sharp, fast stand-up comedian who riffs on current events, tech, and pop culture. ' +
  'Keep replies short (1-3 lines), punchy, and genuinely funny — a clever observation or tight ' +
  'setup→punchline over puns. Good-natured: no slurs, no punching down, nothing mean about the ' +
  'person you are talking to. If the user is continuing an earlier bit, build on it (callback humor). ' +
  'Output ONLY the reply text — no preamble, no quotes, no stage directions.';

/** The slice of slackClient() the Slack paths use (injectable for tests). */
export interface SlackChat {
  post(channel: string, text: string): Promise<{ ts?: string }>;
  reply(channel: string, threadTs: string, text: string): Promise<{ ts?: string }>;
}
function defaultSlack(): SlackChat {
  return slackClient({ writebackTimeoutMs: 15_000 });
}

interface JokeDeps {
  complete?: (prompt: string) => Promise<string>;
  telegram?: TelegramSender;
  slack?: SlackChat;
}

export default defineAgent({
  schedules: [{ name: 'joke-of-the-day', cron: '0 16 * * *', tz: 'UTC' }],
  triggers: {
    // Slack @mention (NOTE: trigger `match` is currently NOT enforced by cloud
    // dispatch — kept for when enforcement lands; with sandbox:false the
    // per-message wake is cheap) + Telegram message. Each transport's trigger is
    // pruned at deploy when its id input is empty (persona enabledByInput).
    slack: [{ on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'], match: '@mention' }],
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    // defineAgent infers a telegram.message | slack.message.created | cron.tick
    // union the runtime's exported AgentEvent doesn't yet carry; cast across the
    // type-defs gap (the handlers only touch `.type`/`.expand()`). Same as inbox-buddy.
    const ev = event as unknown as AgentEvent;
    if (isCronTickEvent(ev)) {
      await handleJokeOfTheDay(ctx);
      return;
    }
    if (typeof ev.type === 'string' && ev.type.startsWith('telegram.')) {
      await handleTelegramMention(ctx, ev);
      return;
    }
    if (typeof ev.type === 'string' && ev.type.startsWith('slack.')) {
      await handleSlackMention(ctx, ev);
      return;
    }
    if (isRelaycastMessageEvent(ev)) {
      await handleRelayDm(ctx, ev);
    }
  }
});

// ── Telegram chat path ─────────────────────────────────────────────────────────

/** Telegram message path: reply in-thread, with per-conversation memory. */
export async function handleTelegramMention(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: JokeDeps = {}
): Promise<void> {
  if (typeof event.type === 'string' && !event.type.startsWith('telegram.')) {
    ctx.log?.('info', `joke-bot.skip transport=telegram reason=non-telegram-event type=${event.type}`);
    return;
  }

  const msg = readTelegramMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'joke-bot.skip transport=telegram reason=unparseable-payload');
    return;
  }

  const reason = telegramSkipReason(msg, input(ctx, 'TELEGRAM_CHAT'));
  if (reason) {
    ctx.log?.('info', `joke-bot.skip transport=telegram reason=${reason.replace(/\s+/g, '-')} chat=${msg.chatId}`);
    return;
  }

  const tg = deps.telegram ?? defaultTelegram();
  const question = msg.text.trim();
  const tag = `joke-convo:telegram:${conversationKeyForTelegram(msg)}`;
  let reply: string;
  try {
    reply = await joke(ctx, buildPrompt(await recall(ctx, tag), question), deps.complete);
  } catch (error) {
    ctx.log?.('warn', 'joke-bot.llm-fallback', { transport: 'telegram', error: String(error) });
    reply = FALLBACK_JOKE;
  }
  await replyToMessage(ctx, tg, msg, reply);
  await remember(ctx, tag, question, reply);
  ctx.log?.('info', 'joke-bot.replied', { transport: 'telegram', chat: bareChatId(msg.chatId), chars: reply.length });
}

// ── Slack @mention path ────────────────────────────────────────────────────────

/** Slack @mention path: reply in-thread, with per-thread memory. */
export async function handleSlackMention(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: JokeDeps = {}
): Promise<void> {
  const data = ((await event.expand('full').catch(() => undefined)) as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const channel = typeof data.channel === 'string' ? data.channel : undefined;
  const ts = typeof data.ts === 'string' ? data.ts : undefined;
  if (!channel || !ts) {
    ctx.log?.('info', 'joke-bot.skip transport=slack reason=missing-channel-ts');
    return;
  }
  // Channel guard: only ever reply in the configured channel. The slack trigger
  // wakes across channels (broad slack scope feeds the wake-path match, and the
  // trigger `match` gate isn't enforced cloud-side yet), so without this joke-bot
  // would answer @mentions in ANY channel. Fail CLOSED — if SLACK_CHANNEL is
  // unset/miswired, don't reply at all. Normalize `id__name` → `id`.
  const want = input(ctx, 'SLACK_CHANNEL')?.split('__')[0];
  const chanId = channel.split('__')[0];
  if (!want) {
    ctx.log?.('warn', 'joke-bot.skip transport=slack reason=no-channel-configured');
    return;
  }
  if (chanId !== want) {
    ctx.log?.('info', `joke-bot.skip transport=slack reason=wrong-channel channel=${chanId} want=${want}`);
    return;
  }
  if (data.is_bot === true || data.bot_id || (typeof data.subtype === 'string' && data.subtype)) {
    ctx.log?.('info', 'joke-bot.skip transport=slack reason=bot-or-non-plain-message');
    return;
  }
  // The Slack trigger's `match` gate is not enforced cloud-side yet, so match
  // the connected bot's exact user mention here. Fail closed when its id is
  // absent: accepting any `<@...>` token would wake joke-bot for conversations
  // addressed only to somebody else.
  const botUserId = input(ctx, 'SLACK_BOT_USER_ID')?.split('__')[0];
  if (!botUserId) {
    ctx.log?.('warn', 'joke-bot.skip transport=slack reason=no-bot-user-id-configured');
    return;
  }
  const rawText = typeof data.text === 'string' ? data.text : '';
  const botMention = `<@${botUserId}>`;
  if (!rawText.includes(botMention)) {
    ctx.log?.('info', 'joke-bot.skip transport=slack reason=no-mention');
    return;
  }
  const threadTs = typeof data.thread_ts === 'string' && data.thread_ts ? data.thread_ts : ts;
  // Strip ONLY the leading bot mention; preserve any other mentions in the text
  // (e.g. "@joke-bot tell a joke about @alice" keeps @alice).
  const leadingTrimmed = rawText.trimStart();
  const question = (leadingTrimmed.startsWith(botMention)
    ? leadingTrimmed.slice(botMention.length)
    : rawText
  ).trim();
  if (!question) {
    ctx.log?.('info', 'joke-bot.skip transport=slack reason=empty-after-mention');
    return;
  }

  const slack = deps.slack ?? defaultSlack();
  const tag = `joke-convo:slack:${chanId}:${threadTs}`;
  let reply: string;
  try {
    reply = await joke(ctx, buildPrompt(await recall(ctx, tag), question), deps.complete);
  } catch (error) {
    ctx.log?.('warn', 'joke-bot.llm-fallback', { transport: 'slack', error: String(error) });
    reply = FALLBACK_JOKE;
  }
  const result = await slack.reply(chanId, threadTs, reply);
  if (!result?.ts) ctx.log?.('warn', 'joke-bot.slack-no-receipt', { channel: chanId, threadTs });
  await remember(ctx, tag, question, reply);
  ctx.log?.('info', 'joke-bot.replied', { transport: 'slack', channel: chanId, threadTs, chars: reply.length });
}

// ── relay-inbox DM path (Slack writeback) ──────────────────────────────────────

/** Relay-inbox DM path: a native relaycast DM → reply by posting to SLACK_CHANNEL. */
export async function handleRelayDm(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: JokeDeps = {}
): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL')?.split('__')[0];
  if (!channel) {
    ctx.log?.('warn', 'joke-bot.skip transport=relay reason=no-slack-channel');
    return;
  }
  const question = await readQuestion(event);
  if (!question) {
    ctx.log?.('info', 'joke-bot.skip transport=relay reason=empty-message');
    return;
  }
  const slack = deps.slack ?? defaultSlack();
  const tag = `joke-convo:${channel}`;
  let reply: string;
  try {
    reply = await joke(ctx, buildPrompt(await recall(ctx, tag), question), deps.complete);
  } catch (error) {
    ctx.log?.('warn', 'joke-bot.llm-fallback', { transport: 'relay', error: String(error) });
    reply = FALLBACK_JOKE;
  }
  const result = await slack.post(channel, reply);
  if (!result?.ts) ctx.log?.('warn', 'joke-bot.slack-no-receipt', { channel, surface: 'relay' });
  await remember(ctx, tag, question, reply);
  ctx.log?.('info', 'joke-bot.replied', { transport: 'relay', channel, chars: reply.length });
}

// ── scheduled "joke of the day" (fan-out to every configured transport) ─────────

export async function handleJokeOfTheDay(ctx: WorkforceCtx, deps: JokeDeps = {}): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL')?.split('__')[0];
  const chat = input(ctx, 'TELEGRAM_CHAT');
  if (!channel && !chat) {
    ctx.log?.('warn', 'joke-bot.jotd.skip', { reason: 'neither SLACK_CHANNEL nor TELEGRAM_CHAT set' });
    return;
  }
  let reply: string;
  try {
    reply = await joke(
      ctx,
      'Give me one short, original "joke of the day" about recent tech / pop-culture / current events.',
      deps.complete
    );
  } catch (error) {
    ctx.log?.('warn', 'joke-bot.jotd.llm-fallback', { error: String(error) });
    reply = FALLBACK_JOKE;
  }
  const text = `🃏 Joke of the day:\n${reply}`;

  if (channel) {
    const slack = deps.slack ?? defaultSlack();
    const result = await slack.post(channel, text);
    if (!result?.ts) ctx.log?.('warn', 'joke-bot.jotd.slack-no-receipt', { channel });
    else ctx.log?.('info', 'joke-bot.jotd-posted', { transport: 'slack', channel });
  }
  if (chat) {
    const tg = deps.telegram ?? defaultTelegram();
    const res = await tg.send(bareChatId(chat), text);
    if (!res.ok) ctx.log?.('warn', 'joke-bot.jotd.telegram-no-receipt', { chat: bareChatId(chat) });
    else ctx.log?.('info', 'joke-bot.jotd-posted', { transport: 'telegram', chat: bareChatId(chat) });
  }
}

// ── joke generation + memory ────────────────────────────────────────────────

/** Generate a joke via direct LLM inference (subscription-backed). */
async function joke(
  ctx: WorkforceCtx,
  context: string,
  complete?: (prompt: string) => Promise<string>
): Promise<string> {
  const run = complete ?? ((p: string) => ctx.llm.complete(p, { maxTokens: 300 }));
  const reply = (await withTimeout(run(`${COMEDIAN_PREAMBLE}\n\n${context}`), LLM_TIMEOUT_MS, 'ctx.llm.complete')).trim();
  if (!reply) throw new Error('ctx.llm.complete returned an empty reply');
  return reply;
}

function buildPrompt(history: string[], question: string): string {
  return [
    history.length > 0 ? `Conversation so far (oldest first):\n${history.join('\n')}\n` : '',
    `The user just said: ${question}`,
    '',
    'Reply with a single short, funny joke or comeback.'
  ].filter(Boolean).join('\n');
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
  const lines = toLines(
    await ctx.memory
      .recall('recent joke-bot conversation', { tags: [tag], limit: CONVO_TURNS, scope: 'workspace' })
      .catch(() => [])
  );
  return lines.reverse();
}

async function remember(ctx: WorkforceCtx, tag: string, user: string, reply: string): Promise<void> {
  await ctx.memory
    .save(`User: ${user}\njoke-bot: ${reply}`, { tags: [tag], scope: 'workspace', ttlSeconds: 30 * 24 * 60 * 60 })
    .catch((e) => ctx.log?.('warn', 'joke-bot.memory-save-failed', { error: String(e) }));
}

/** Resolve an input: env first (local dev), then ctx, then declared default. */
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}

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
