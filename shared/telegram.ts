/**
 * Shared Telegram transport for the `*-telegram` agent variants.
 *
 * Mirrors `inbox-buddy/lib/slack.ts` but for the Telegram adapter
 * (`@relayfile/adapter-telegram`). Uses the ergonomic `telegramClient()`
 * (relay-helpers ≥0.4.2) — `.sendMessage(chatId, text, opts)`, which returns
 * `{ ok, messageId, ... }` and applies writeback idempotency for us — behind a
 * small injectable `send()` seam, plus the message parsing + guards every
 * telegram agent needs.
 *
 * Telegram threading is native: pass `replyToMessageId` (and `threadId` for
 * forum topics). No `thread_ts`/`parentRef` dance.
 */
import type { WorkforceCtx } from '@agentworkforce/runtime';
import { telegramClient } from '@relayfile/relay-helpers';

export interface TelegramMessage {
  chatId: string;
  messageId: string;
  text: string;
  /** Forum-topic id (`message_thread_id`), if the chat is a forum supergroup. */
  threadId?: string;
  fromIsBot: boolean;
}

/**
 * Strip the `__title` suffix the adapter appends to chat dirs
 * (`/telegram/chats/<chatId>__<title>`); the writeback `chatId` param wants the
 * bare id. Bare ids never contain `__`, so this is a safe no-op when already
 * bare. (Telegram analog of inbox-buddy/lib/slack.ts `bareChannelId`.)
 */
export function bareChatId(chatId: string): string {
  return String(chatId).split('__')[0];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Parse a Telegram message envelope (from `event.expand('full').data`, the
 * adapter's TelegramMessageRecord) into a normalized shape, or null if unusable.
 */
export function readTelegramMessage(payload: unknown): TelegramMessage | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const data = asRecord(rec.data) ?? rec;
  const from = asRecord(data.from);
  const chat = asRecord(data.chat);

  const chatId = str(data.chatId) ?? str(chat?.id);
  if (!chatId) return null;
  const messageId = str(data.messageId) ?? str(data.message_id);
  if (!messageId) return null;

  return {
    chatId,
    messageId,
    text: str(data.text) ?? str(data.caption) ?? '',
    threadId: str(data.messageThreadId) ?? str(data.message_thread_id),
    fromIsBot: Boolean(from?.is_bot ?? data.fromIsBot)
  };
}

/**
 * Conversation key for continuity: the bare chat id, plus the forum-topic id
 * when present so separate topics form separate conversations. (Telegram analog
 * of `conversationKeyForSlack`.)
 */
export function conversationKeyForTelegram(msg: TelegramMessage): string {
  const id = bareChatId(msg.chatId);
  return msg.threadId ? `${id}:${msg.threadId}` : id;
}

/**
 * Reason this message should be skipped, or null to handle it. Skips the bot's
 * own echoes (Telegram redelivers the bot's sends as `message` updates — loop
 * guard), the wrong chat, and empty text. (Telegram analog of `skipReason`.)
 */
export function skipReason(msg: TelegramMessage, boardChat: string | undefined): string | null {
  if (msg.fromIsBot) return 'bot message';
  if (boardChat && bareChatId(msg.chatId) !== bareChatId(boardChat)) return 'not the configured chat';
  if (!msg.text.trim()) return 'empty message text';
  return null;
}

/** The slice of telegramClient() the agents use (injectable for tests). */
export interface TelegramSender {
  send(
    chatId: string,
    text: string,
    opts?: { replyToMessageId?: number; threadId?: number }
  ): Promise<{ ok: boolean; messageId?: string }>;
}

const WRITEBACK_TIMEOUT_MS = 15_000;

/**
 * Default sender over the ergonomic `telegramClient().sendMessage` — which
 * builds the request body, applies writeback idempotency, and returns
 * `{ ok, messageId, ... }` directly. `ok:false` means the writeback produced no
 * receipt (cloud writeback often outruns the wait) — callers decide if that's
 * fatal.
 */
export function defaultTelegram(): TelegramSender {
  const tg = telegramClient({ writebackTimeoutMs: WRITEBACK_TIMEOUT_MS });
  return {
    async send(chatId, text, opts) {
      const res = await tg.sendMessage(bareChatId(chatId), text, {
        replyToMessageId: opts?.replyToMessageId,
        threadId: opts?.threadId
      });
      return { ok: res.ok, messageId: res.messageId || undefined };
    }
  };
}

/**
 * Reply to an incoming message in its chat, threading on the source message.
 * Best-effort: a missing receipt is logged, not thrown (matches the slack
 * `postReply` tolerance — cloud writeback can outrun the wait).
 */
export async function replyToMessage(
  ctx: WorkforceCtx,
  tg: TelegramSender,
  msg: TelegramMessage,
  text: string
): Promise<void> {
  const chatId = bareChatId(msg.chatId);
  const res = await tg.send(chatId, text, {
    replyToMessageId: Number(msg.messageId) || undefined,
    threadId: msg.threadId ? Number(msg.threadId) || undefined : undefined
  });
  if (!res.ok) ctx.log?.('warn', 'telegram.reply.no-receipt', { chatId });
}
