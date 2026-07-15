/**
 * inbox-buddy handler — dual-transport conversational Gmail Q&A.
 *
 * A conversational agent you chat with in Slack OR Telegram to ask about your
 * Gmail. Built as a dogfooding forcing-function for two threading problems:
 *
 *   1. Conversational continuity — remembering earlier turns in OUR chat. We
 *      persist/replay the transcript via ctx.memory keyed by the conversation
 *      (lib/conversation), independent of harness session-resume.
 *   2. Email threading — resolving "that thread with X" to the right Gmail
 *      thread and reasoning over its full message list (lib/gmail, lib/prompt).
 *
 * Transport is configuration-driven (workforce#252). Two webhook-driven
 * triggers are registered — `slack.app_mention` and `telegram.message` — but the
 * persona gates each transport on its id input (SLACK_CHANNEL / TELEGRAM_CHAT),
 * so only the configured transport(s) actually connect + register. The handler
 * dispatches by event type and ALWAYS replies on the origin transport, so a
 * question asked in Slack is answered in Slack and never mirrored to Telegram.
 *
 * The Gmail data path (lib/gmail / lib/prompt / lib/conversation) and the model
 * call are transport-agnostic and shared by both paths. Reads Gmail ONLY from
 * the relayfile VFS mount (`/google-mail/threads/**`) — no Gmail token; auth
 * lives in the google-mail Nango connection.
 */
import {
  defineAgent,
  resolveMountRoot,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { loadConversation, recordTurn } from './lib/conversation.js';
import { loadRecentThreads } from './lib/gmail.js';
import { buildPrompt, focusedThreadIds, SYSTEM_PROMPT } from './lib/prompt.js';
import {
  readSlackMessage,
  stripLeadingMention,
  skipReason as slackSkipReason,
  conversationKeyForSlack,
  postReply,
  defaultSlack,
  type SlackMessage,
  type SlackPoster
} from './lib/slack.js';
import {
  readTelegramMessage,
  skipReason as telegramSkipReason,
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
    // `on: 'app_mention'` never actually routes: the cloud's integration-watch
    // matcher hard-excludes app_mention from generic resource matching
    // (relayfileTriggerMatchesEvent short-circuits false for it), and Slack
    // mentions inside an existing thread arrive to the webhook as a plain
    // `message.created` event, not a literal `app_mention` eventType. Match on
    // the Relayfile trigger + `@mention` text gate instead — the same pattern
    // review-agent (pr-reviewer) and joke-bot actually use in production. Each
    // transport's trigger is pruned at deploy when its id input is empty
    // (persona enabledByInput). `${SLACK_CHANNEL}` below is NOT JS
    // interpolation (this is a plain single-quoted string) — it's the
    // persona-kit input-reference syntax, substituted with the deploy-resolved
    // channel id by the deploy CLI before the trigger ever reaches cloud.
    slack: [{ on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'], match: '@mention' }],
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    // defineAgent infers the event as `slack.app_mention` / `telegram.message`,
    // but the runtime's exported event unions don't yet carry those literals, so
    // the inferred type isn't assignable to AgentEvent. Cast across the runtime
    // type-defs gap; the handler only touches `.type`/`.expand()`, which every
    // event provides.
    const ev = event as unknown as AgentEvent;
    if (ev.type.startsWith('telegram.')) {
      await handleTelegramMessage(ctx, ev);
    } else {
      await handleSlackMessage(ctx, ev);
    }
  }
});

// ── Slack chat path ──────────────────────────────────────────────────────────

/**
 * Chat path: a Slack message in the chat channel. Gate it, compose an answer
 * grounded in the transcript + recent Gmail, reply in Slack, and persist the
 * turn. `deps` is injectable so unit tests never call the model/network.
 */
export async function handleSlackMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  deps: {
    complete?: (prompt: string) => Promise<string>;
    slack?: SlackPoster;
    now?: () => Date;
  } = {}
): Promise<void> {
  // Diagnostic: deployments logs only surface the message STRING (not data
  // fields), so encode the event type / skip reason into the message itself.
  ctx.log?.('info', `inbox-buddy.event transport=slack type=${event.type}`);

  if (!event.type.startsWith('slack.')) {
    ctx.log?.('info', `inbox-buddy.skip transport=slack reason=non-slack-event type=${event.type}`);
    return;
  }

  const msg = readSlackMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'inbox-buddy.skip transport=slack reason=unparseable-payload');
    return;
  }

  const channel = input(ctx, 'SLACK_CHANNEL');
  const reason = slackSkipReason(msg, channel);
  if (reason) {
    ctx.log?.('info', `inbox-buddy.skip transport=slack reason=${reason.replace(/\s+/g, '-')} channel=${msg.channel} configured=${channel ?? 'unset'}`);
    return;
  }

  const question = stripLeadingMention(msg.text).trim();
  const slack = deps.slack ?? defaultSlack();
  const answer = await composeAnswer(ctx, {
    transport: 'slack',
    conversationKey: conversationKeyForSlack(msg),
    channelLabel: msg.channel,
    question,
    complete: deps.complete,
    now: deps.now
  });

  await postReply(ctx, slack, msg, answer);
}

// ── Telegram chat path ─────────────────────────────────────────────────────────

/**
 * Chat path: a Telegram message. Same shape as the Slack path — gate, compose,
 * reply in Telegram (threading on the source message), persist the turn.
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
  ctx.log?.('info', `inbox-buddy.event transport=telegram type=${event.type}`);

  if (!event.type.startsWith('telegram.')) {
    ctx.log?.('info', `inbox-buddy.skip transport=telegram reason=non-telegram-event type=${event.type}`);
    return;
  }

  const msg = readTelegramMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'inbox-buddy.skip transport=telegram reason=unparseable-payload');
    return;
  }

  const chat = input(ctx, 'TELEGRAM_CHAT');
  const reason = telegramSkipReason(msg, chat);
  if (reason) {
    ctx.log?.('info', `inbox-buddy.skip transport=telegram reason=${reason.replace(/\s+/g, '-')} chat=${msg.chatId} configured=${chat ?? 'unset'}`);
    return;
  }

  const question = msg.text.trim();
  const tg = deps.telegram ?? defaultTelegram();
  const answer = await composeAnswer(ctx, {
    transport: 'telegram',
    conversationKey: conversationKeyForTelegram(msg),
    channelLabel: msg.chatId,
    question,
    complete: deps.complete,
    now: deps.now
  });

  await replyToMessage(ctx, tg, msg, answer);
}

// ── shared answer core (transport-agnostic) ────────────────────────────────────

/**
 * The transport-agnostic heart of both paths: load the conversation transcript +
 * recent Gmail threads, answer grounded in both (with a bounded model call and a
 * deterministic fallback), and persist the turn for continuity BEFORE the caller
 * delivers — so continuity survives a flaky reply transport. Returns the answer
 * text for the caller to deliver on the origin transport.
 */
async function composeAnswer(
  ctx: WorkforceCtx,
  opts: {
    transport: 'slack' | 'telegram';
    conversationKey: string;
    channelLabel: string;
    question: string;
    complete?: (prompt: string) => Promise<string>;
    now?: () => Date;
  }
): Promise<string> {
  const { transport, conversationKey: key, channelLabel, question } = opts;
  const prior = await loadConversation(ctx, key);

  const root = resolveMountRoot({});
  const threads = await loadRecentThreads({ relayfileMountRoot: root }, THREAD_LOAD_LIMIT);

  const focused = focusedThreadIds(threads, question);
  // String form for deployments-logs visibility; data form for tests/structured sinks.
  ctx.log?.('info', `inbox-buddy.context transport=${transport} channel=${channelLabel} priorTurns=${prior.length} threadsLoaded=${threads.length} focused=${focused.join('|') || 'none'}`, {
    transport,
    conversationKey: key,
    priorTurns: prior.length,
    threadsLoaded: threads.length,
    focusedThreads: focused
  });

  const userPrompt = buildPrompt({ question, transcript: prior, threads });
  const complete = opts.complete ?? ((p: string) => ctx.llm.complete(`${SYSTEM_PROMPT}\n\n${p}`, { maxTokens: 1024 }));

  // ctx.llm.complete can hang or error — bound it and fall back to a
  // deterministic answer so the chat still gets a reply.
  let answer: string;
  try {
    answer = await withTimeout(complete(userPrompt), LLM_TIMEOUT_MS, 'ctx.llm.complete');
  } catch (error) {
    ctx.log?.('warn', 'inbox-buddy.llm-fallback', { transport, error: String(error) });
    answer = fallbackAnswer(threads.length);
  }
  answer = answer.trim() || fallbackAnswer(threads.length);

  // Persist BEFORE delivery so continuity survives a flaky reply transport.
  await recordTurn(ctx, key, prior, question, answer, opts.now);
  return answer;
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

export type { SlackMessage, TelegramMessage };
