/**
 * inbox-buddy handler.
 *
 * A conversational agent you chat with in a dedicated Slack channel to ask about
 * your Gmail. Built as a dogfooding forcing-function for two threading problems:
 *
 *   1. Conversational continuity — remembering earlier turns in OUR chat. We
 *      persist/replay the transcript via ctx.memory keyed by the Slack
 *      conversation (lib/conversation), independent of harness session-resume.
 *   2. Email threading — resolving "that thread with X" to the right Gmail
 *      thread and reasoning over its full message list (lib/gmail, lib/prompt).
 *
 * Channel model (mirrors the in-production linear-slack agent): a `slack`
 * trigger watches ONE channel (the SLACK_CHANNEL picker input); the handler
 * answers every fresh human message there and replies in Slack. The relay inbox
 * is agent-to-agent, so it is NOT used for the human chat path.
 *
 * Reads Gmail ONLY from the relayfile VFS mount (`/google-mail/threads/**`) — no
 * Gmail token; auth lives in the google-mail Nango connection.
 */
import {
  defineAgent,
  resolveMountRoot,
  type WorkforceCtx,
  type WorkforceEvent
} from '@agentworkforce/runtime';
import {
  loadConversation,
  recordTurn
} from './lib/conversation.js';
import { loadRecentThreads } from './lib/gmail.js';
import { buildPrompt, focusedThreadIds, SYSTEM_PROMPT } from './lib/prompt.js';
import {
  readSlackMessage,
  stripLeadingMention,
  skipReason,
  conversationKeyForSlack,
  postReply,
  defaultSlack,
  type SlackMessage,
  type SlackPoster
} from './lib/slack.js';

const LLM_TIMEOUT_MS = 45_000;
const THREAD_LOAD_LIMIT = 200;

export default defineAgent({
  triggers: {
    // Channel-scoped watch path is the wake gate: the cloud dispatcher
    // intersects this against the event's relayfile path before provisioning, so
    // the agent only wakes for its chat channel. `${SLACK_CHANNEL}` is a
    // deploy-time placeholder (single quotes keep it literal) that cloud
    // substitutes with the picker-chosen channel id (AgentWorkforce/cloud#1999).
    slack: [{ on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'] }]
  },
  handler: async (ctx, event) => {
    await handleSlackMessage(ctx, event);
  }
});

/**
 * Chat path: a Slack message in the chat channel. Gate it, load the conversation
 * transcript + recent Gmail threads, answer grounded in both, reply in Slack,
 * and persist the turn. `deps` is injectable so unit tests never call the
 * model/network.
 */
export async function handleSlackMessage(
  ctx: WorkforceCtx,
  event: WorkforceEvent,
  deps: {
    complete?: (prompt: string) => Promise<string>;
    slack?: SlackPoster;
    now?: () => Date;
  } = {}
): Promise<void> {
  if (!event.type.startsWith('slack.')) {
    ctx.log?.('info', 'inbox-buddy.skip', { reason: 'non-slack event', type: event.type });
    return;
  }

  const msg = readSlackMessage((await event.expand('full')).data);
  if (!msg) {
    ctx.log?.('info', 'inbox-buddy.skip', { reason: 'unparseable slack payload' });
    return;
  }

  const reason = skipReason(msg, input(ctx, 'SLACK_CHANNEL'));
  if (reason) {
    ctx.log?.('info', 'inbox-buddy.skip', { reason, channel: msg.channel });
    return;
  }

  const question = stripLeadingMention(msg.text).trim();
  const slack = deps.slack ?? defaultSlack();
  const key = conversationKeyForSlack(msg);
  const prior = await loadConversation(ctx, key);

  const root = resolveMountRoot({});
  const threads = await loadRecentThreads({ relayfileMountRoot: root }, THREAD_LOAD_LIMIT);

  ctx.log?.('info', 'inbox-buddy.context', {
    conversationKey: key,
    priorTurns: prior.length,
    threadsLoaded: threads.length,
    focusedThreads: focusedThreadIds(threads, question)
  });

  const userPrompt = buildPrompt({ question, transcript: prior, threads });
  const complete = deps.complete ?? ((p: string) => ctx.llm.complete(`${SYSTEM_PROMPT}\n\n${p}`, { maxTokens: 1024 }));

  // ctx.llm.complete can hang or error — bound it and fall back to a
  // deterministic answer so the chat still gets a reply.
  let answer: string;
  try {
    answer = await withTimeout(complete(userPrompt), LLM_TIMEOUT_MS, 'ctx.llm.complete');
  } catch (error) {
    ctx.log?.('warn', 'inbox-buddy.llm-fallback', { error: String(error) });
    answer = fallbackAnswer(threads.length);
  }
  answer = answer.trim() || fallbackAnswer(threads.length);

  // Persist BEFORE delivery so continuity survives a flaky reply transport.
  await recordTurn(ctx, key, prior, question, answer, deps.now);
  await postReply(ctx, slack, msg, answer);
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

export type { SlackMessage };
