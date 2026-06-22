/**
 * inbox-buddy-telegram handler.
 *
 * The Telegram-transport sibling of inbox-buddy: same conversational Gmail Q&A
 * (multi-turn continuity + email threading), but you chat with it in Telegram.
 * It REUSES inbox-buddy's transport-agnostic libs verbatim:
 *   - lib/conversation — transcript persist/replay (continuity)
 *   - lib/gmail        — read recent threads from the /google-mail VFS mount
 *   - lib/prompt       — focus the referenced thread + build the prompt
 * and swaps the Slack transport for the shared Telegram transport
 * (../shared/telegram.ts).
 *
 * Trigger: telegram `message` (webhook-driven; the update rides in
 * event.expand('full').data). Replies via telegramClient().messages.write,
 * threading on the source message. No Gmail/Telegram tokens in the agent — auth
 * lives in the respective Nango connections.
 */
import {
  defineAgent,
  resolveMountRoot,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { loadConversation, recordTurn } from '../inbox-buddy/lib/conversation.js';
import { loadRecentThreads } from '../inbox-buddy/lib/gmail.js';
import { buildPrompt, focusedThreadIds, SYSTEM_PROMPT } from '../inbox-buddy/lib/prompt.js';
import {
  readTelegramMessage,
  skipReason,
  conversationKeyForTelegram,
  replyToMessage,
  defaultTelegram,
  type TelegramMessage,
  type TelegramSender
} from '../shared/telegram.js';

const LLM_TIMEOUT_MS = 45_000;
const THREAD_LOAD_LIMIT = 200;

export default defineAgent({
  triggers: {
    // Telegram `message` is webhook-driven: the update rides in the event
    // payload (event.expand('full').data), independent of the relayfile mount —
    // the same property that makes slack's app_mention robust for inbox-buddy.
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    // defineAgent infers the event as `telegram.message`; the runtime's exported
    // event unions don't carry that literal yet (telegram catalog cutover is
    // pending — workforce#249), so cast across the type-defs gap. The handler
    // only touches `.type`/`.expand()`, which every event provides.
    await handleTelegramMessage(ctx, event as unknown as AgentEvent);
  }
});

/**
 * Chat path: a Telegram message. Gate it, load the conversation transcript +
 * recent Gmail threads, answer grounded in both, reply in Telegram, and persist
 * the turn. `deps` is injectable so unit tests never call the model/network.
 */
export async function handleTelegramMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: {
    complete?: (prompt: string) => Promise<string>;
    telegram?: TelegramSender;
    now?: () => Date;
  } = {}
): Promise<void> {
  ctx.log?.('info', `inbox-buddy-telegram.event type=${event.type}`);

  if (!event.type.startsWith('telegram.')) {
    ctx.log?.('info', `inbox-buddy-telegram.skip reason=non-telegram-event type=${event.type}`);
    return;
  }

  const msg = readTelegramMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'inbox-buddy-telegram.skip reason=unparseable-payload');
    return;
  }

  const reason = skipReason(msg, input(ctx, 'TELEGRAM_CHAT'));
  if (reason) {
    ctx.log?.('info', `inbox-buddy-telegram.skip reason=${reason.replace(/\s+/g, '-')} chat=${msg.chatId} configured=${input(ctx, 'TELEGRAM_CHAT') ?? 'unset'}`);
    return;
  }

  const question = msg.text.trim();
  const tg = deps.telegram ?? defaultTelegram();
  const key = conversationKeyForTelegram(msg);
  const prior = await loadConversation(ctx, key);

  const root = resolveMountRoot({});
  const threads = await loadRecentThreads({ relayfileMountRoot: root }, THREAD_LOAD_LIMIT);

  const focused = focusedThreadIds(threads, question);
  ctx.log?.('info', `inbox-buddy-telegram.context chat=${msg.chatId} priorTurns=${prior.length} threadsLoaded=${threads.length} focused=${focused.join('|') || 'none'}`, {
    conversationKey: key,
    priorTurns: prior.length,
    threadsLoaded: threads.length,
    focusedThreads: focused
  });

  const userPrompt = buildPrompt({ question, transcript: prior, threads });
  const complete = deps.complete ?? ((p: string) => ctx.llm.complete(`${SYSTEM_PROMPT}\n\n${p}`, { maxTokens: 1024 }));

  // ctx.llm.complete can hang or error — bound it and fall back to a
  // deterministic answer so the chat still gets a reply.
  let answer: string;
  try {
    answer = await withTimeout(complete(userPrompt), LLM_TIMEOUT_MS, 'ctx.llm.complete');
  } catch (error) {
    ctx.log?.('warn', 'inbox-buddy-telegram.llm-fallback', { error: String(error) });
    answer = fallbackAnswer(threads.length);
  }
  answer = answer.trim() || fallbackAnswer(threads.length);

  // Persist BEFORE delivery so continuity survives a flaky reply transport.
  await recordTurn(ctx, key, prior, question, answer, deps.now);
  await replyToMessage(ctx, tg, msg, answer);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fallbackAnswer(threadCount: number): string {
  return threadCount > 0
    ? `I'm having trouble composing an answer right now. I can see ${threadCount} recent thread(s) — try again in a moment, or narrow it to a sender or subject.`
    : "I'm having trouble composing an answer right now, and I don't see any recent email in the mount yet.";
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

/** Resolve an input: env first (local dev), then ctx, then declared default. */
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const raw = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  const v = raw != null ? String(raw).trim() : '';
  return v || undefined;
}

export type { TelegramMessage };
