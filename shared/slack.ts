/**
 * Shared Slack transport helpers for Workforce agents.
 *
 * Promoted from `inbox-buddy/lib/slack.ts` — every agent that handles Slack
 * messages needs the same payload parsing, channel guard, bot filter, and
 * reply helper. Keeping them here prevents each new agent from either
 * reimplementing them (and getting the ordering or fail-closed logic wrong)
 * or depending on another agent's internal lib path.
 *
 * Mirrors `shared/telegram.ts` (the same shape for Telegram).
 *
 * Promotion target: @agentworkforce/delivery — the message-handling helpers
 * (readSlackMessage, slackSkipReason, bareSlackChannelId, stripSlackLeadingMention,
 * conversationKeyForSlack) have been added to workforce/packages/delivery/src/slack.ts
 * mirroring readTelegramMessage/telegramSkipReason/bareTelegramChatId in telegram.ts.
 * Once agents bumps @agentworkforce/delivery past the release that includes these
 * exports, import directly from there and delete this file.
 *
 * SLACK_BOT_USER_ID guard: not encoded in skipReason() because some agents
 * (inbox-buddy, linear-slack) own a dedicated channel where every non-bot
 * message is theirs. Agents in shared channels (pr-shepherd, joke-bot) should
 * add the guard themselves: fail closed when botUserId is unset, check
 * rawText.includes(`<@${botUserId}>`) before handling.
 */
import type { WorkforceCtx } from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

export interface SlackMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  user?: string;
  isBot: boolean;
  subtype?: string;
}

/** The slice of slackClient() the handler uses (injectable for tests). */
export interface SlackPoster {
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  reply(channel: string, threadTs: string, text: string): Promise<{ channel: string; ts: string }>;
}

const WRITEBACK_TIMEOUT_MS = 15_000;

export function defaultSlack(): SlackPoster {
  return slackClient({ writebackTimeoutMs: WRITEBACK_TIMEOUT_MS });
}

// ── payload parsing ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function unwrapRecord(payload: unknown): Record<string, unknown> | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  return asRecord(rec.data) ?? rec;
}

/** Read a Slack message envelope into a normalized shape (or null if unusable). */
export function readSlackMessage(payload: unknown): SlackMessage | null {
  const rec = unwrapRecord(payload);
  if (!rec) return null;
  const raw = asRecord(rec.raw_event) ?? rec;

  const channel = str(rec.channel) ?? str(raw.channel);
  if (!channel) return null;
  const ts = str(rec.ts) ?? str(raw.ts) ?? str(rec.event_ts) ?? str(raw.event_ts);
  if (!ts) return null;

  return {
    channel,
    ts,
    threadTs: str(rec.thread_ts) ?? str(rec.threadTs) ?? str(raw.thread_ts),
    text: str(rec.text) ?? str(raw.text) ?? '',
    user: str(rec.user) ?? str(raw.user),
    isBot: Boolean(rec.is_bot ?? raw.is_bot) || Boolean(str(rec.bot_id) ?? str(raw.bot_id)),
    subtype: str(rec.subtype) ?? str(raw.subtype)
  };
}

/** Strip a leading `<@U…>`/`@name` mention so the question text is clean. */
export function stripLeadingMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, '').replace(/^\s*@\S+\s*/, '');
}

/**
 * Strip the `__name` suffix the platform appends to channel ids in some payloads
 * (e.g. `/slack/channels/{id__name}/**`). Bare Slack ids never contain `__`, so
 * this is a safe no-op when the id is already bare. Use it before comparing
 * channels, keying memory, or calling the Slack API.
 */
export function bareChannelId(channel: string): string {
  return channel.split('__')[0];
}

/**
 * Conversation key for continuity. A threaded message keys on its thread; a
 * top-level message keys on the CHANNEL itself, so consecutive top-level
 * messages in a dedicated chat channel form one continuous conversation.
 *
 * `startThread` must match what was passed to {@link postReply}. An agent that
 * answers a top-level mention in a new thread has made that thread the
 * conversation, so the opening turn keys on its own ts — otherwise the reply
 * lands under `channel:ts` while the opening turn sits under `channel`, and the
 * follow-up prompt loses the question it is answering.
 */
export function conversationKeyForSlack(
  msg: SlackMessage,
  options: SlackReplyOptions = {},
): string {
  const chanId = bareChannelId(msg.channel);
  const threadTs = msg.threadTs ?? (options.startThread ? msg.ts : undefined);
  return threadTs ? `${chanId}:${threadTs}` : chanId;
}

/**
 * Reason this message should be skipped, or null to handle it. Skips the bot's
 * own/other bot messages (loop guard), edits/joins (subtype), the wrong channel,
 * and empty text.
 */
export function skipReason(msg: SlackMessage, boardChannel: string | undefined): string | null {
  if (msg.isBot) return 'bot message';
  if (msg.subtype) return `slack subtype ${msg.subtype}`;
  if (!boardChannel || bareChannelId(msg.channel) !== bareChannelId(boardChannel)) return 'not the chat channel';
  if (!stripLeadingMention(msg.text).trim()) return 'empty message text';
  return null;
}

/** Post the reply (threaded if the incoming message was in a thread). Loud-ish:
 *  a missing receipt is logged (cloud writeback often outruns the wait). */
export type SlackReplyOptions = {
  /**
   * Answer a top-level mention in a NEW thread beneath it rather than in the
   * channel. Off by default; see the note in the body before enabling.
   */
  startThread?: boolean;
};

export async function postReply(
  ctx: WorkforceCtx,
  slack: SlackPoster,
  msg: SlackMessage,
  text: string,
  options: SlackReplyOptions = {}
): Promise<void> {
  const chanId = bareChannelId(msg.channel);
  // `startThread` opts an agent into answering a TOP-LEVEL mention inside a new
  // thread under it. It is opt-in, not the default, because it changes the
  // conversation unit: `conversationKeyForSlack` keys a top-level message on
  // the channel so consecutive top-level messages form one continuous
  // conversation, and silently threading them would strand that history under
  // a different key (see inbox-buddy's multi-turn context).
  //
  // An agent that opts in must also key continuity on the thread — use
  // `conversationKeyForSlack(msg, { startThread: true })`.
  const threadTs = msg.threadTs ?? (options.startThread ? msg.ts : undefined);
  const result = threadTs
    ? await slack.reply(chanId, threadTs, text)
    : await slack.post(chanId, text);
  if (!result?.ts) {
    ctx.log?.('warn', 'slack.reply.no-receipt', { channel: chanId, threaded: Boolean(threadTs) });
  }
}
