/**
 * joke-bot-telegram handler.
 *
 *   Telegram message arrives
 *     → pull the recent conversation from memory (multi-turn threading)
 *     → ask ctx.llm.complete for a joke
 *     → reply in the chat (threaded on the source message)
 *     → save the turn back to memory so the next message can do callbacks
 *
 *   cron tick (daily)
 *     → post one topical "joke of the day" to the configured chat
 *
 * The Telegram sibling of joke-bot: same comedian, Telegram instead of Slack.
 * Self-contained (joke-bot has no shared lib) but uses the shared Telegram
 * transport (../shared/telegram.ts). Reply generation is ctx.llm.complete (a
 * direct LLM call), and with sandbox:false the writeback goes over the relayfile
 * HTTP API — no Daytona box.
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
  conversationKeyForTelegram,
  replyToMessage,
  defaultTelegram,
  bareChatId,
  type TelegramSender
} from '../shared/telegram.js';

const CONVO_TURNS = 6; // how much recent back-and-forth to feed the model

// ctx.llm.complete() takes only { maxTokens } — no system option — so the
// persona's voice rides as a preamble on the prompt.
const COMEDIAN_PREAMBLE =
  'You are a sharp, fast stand-up comedian who riffs on current events, tech, and pop culture. ' +
  'Keep replies short (1-3 lines), punchy, and genuinely funny — a clever observation or tight ' +
  'setup→punchline over puns. Good-natured: no slurs, no punching down, nothing mean about the ' +
  'person you are talking to. If the user is continuing an earlier bit, build on it (callback humor). ' +
  'Output ONLY the reply text — no preamble, no quotes, no stage directions.';

export default defineAgent({
  schedules: [{ name: 'joke-of-the-day', cron: '0 16 * * *', tz: 'UTC' }],
  triggers: {
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    if (isCronTickEvent(event as unknown as AgentEvent)) {
      await handleJokeOfTheDay(ctx);
      return;
    }
    await handleTelegramMention(ctx, event as unknown as AgentEvent);
  }
});

interface JokeDeps {
  complete?: (prompt: string) => Promise<string>;
  telegram?: TelegramSender;
}

/** Telegram chat path: reply in-thread, with per-conversation memory. */
export async function handleTelegramMention(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: JokeDeps = {}
): Promise<void> {
  if (typeof event.type === 'string' && !event.type.startsWith('telegram.')) {
    ctx.log?.('info', `joke-bot-telegram.skip reason=non-telegram-event type=${event.type}`);
    return;
  }

  const msg = readTelegramMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'joke-bot-telegram.skip reason=unparseable-payload');
    return;
  }

  const reason = skipReason(msg, input(ctx, 'TELEGRAM_CHAT'));
  if (reason) {
    ctx.log?.('info', `joke-bot-telegram.skip reason=${reason.replace(/\s+/g, '-')} chat=${msg.chatId}`);
    return;
  }

  const tg = deps.telegram ?? defaultTelegram();
  const question = msg.text.trim();
  const key = conversationKeyForTelegram(msg);
  const tag = `joke-convo:telegram:${key}`;
  const reply = await joke(ctx, buildPrompt(await recall(ctx, tag), question), deps.complete);
  await replyToMessage(ctx, tg, msg, reply);
  await remember(ctx, tag, question, reply);
  ctx.log?.('info', 'joke-bot-telegram.replied', { chat: bareChatId(msg.chatId), chars: reply.length });
}

/** Scheduled path: post one topical joke of the day to the configured chat. */
export async function handleJokeOfTheDay(ctx: WorkforceCtx, deps: JokeDeps = {}): Promise<void> {
  const chat = input(ctx, 'TELEGRAM_CHAT');
  if (!chat) {
    ctx.log?.('warn', 'joke-bot-telegram.no-chat', { reason: 'TELEGRAM_CHAT not set; skipping joke of the day' });
    return;
  }
  const tg = deps.telegram ?? defaultTelegram();
  const reply = await joke(
    ctx,
    'Give me one short, original "joke of the day" about recent tech / pop-culture / current events.',
    deps.complete
  );
  const res = await tg.send(bareChatId(chat), `🃏 Joke of the day:\n${reply}`);
  if (!res.ok) ctx.log?.('warn', 'joke-bot-telegram.jotd.no-receipt', { chat: bareChatId(chat) });
  else ctx.log?.('info', 'joke-bot-telegram.jotd-posted', { chat: bareChatId(chat) });
}

// ── joke generation + memory ────────────────────────────────────────────────

/** Generate a joke via direct LLM inference (subscription-backed). */
async function joke(
  ctx: WorkforceCtx,
  context: string,
  complete?: (prompt: string) => Promise<string>
): Promise<string> {
  const run = complete ?? ((p: string) => ctx.llm.complete(p, { maxTokens: 300 }));
  const reply = (await run(`${COMEDIAN_PREAMBLE}\n\n${context}`)).trim();
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

function toLines(records: unknown): string[] {
  if (!Array.isArray(records)) return [];
  return records
    .map((r) => (typeof r === 'string' ? r : (r as { content?: unknown })?.content))
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

async function recall(ctx: WorkforceCtx, tag: string): Promise<string[]> {
  return toLines(
    await ctx.memory
      .recall('recent joke-bot conversation', { tags: [tag], limit: CONVO_TURNS, scope: 'workspace' })
      .catch(() => [])
  );
}

async function remember(ctx: WorkforceCtx, tag: string, user: string, reply: string): Promise<void> {
  await ctx.memory
    .save(`User: ${user}\njoke-bot: ${reply}`, { tags: [tag], scope: 'workspace', ttlSeconds: 30 * 24 * 60 * 60 })
    .catch((e) => ctx.log?.('warn', 'joke-bot-telegram.memory-save-failed', { error: String(e) }));
}

/** Resolve an input: env first (local dev), then ctx, then declared default. */
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}
