/**
 * linear-slack handler (harness / VFS-navigation model).
 *
 * Slack-native conversational Linear board assistant. It responds to every
 * human message in one dedicated channel (the SLACK_CHANNEL picker input) and
 * runs a claude harness inside the sandbox with the Linear VFS mounted — the
 * model navigates `./linear` on demand (see persona.systemPrompt) instead of
 * having the whole board pre-loaded into context.
 *
 * The handler is thin: it gates the event, reconstructs the thread's
 * conversation history from memory (multi-turn), hands the turn to the harness,
 * posts the harness's reply to Slack, and records the turn. DMs are not handled.
 */
import {
  defineAgent,
  type WorkforceCtx,
  type WorkforceProviderEvent,
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

const MEMORY_TAG = 'linear-slack';
const HISTORY_LIMIT = 8;

interface SlackMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  user?: string;
  isBot: boolean;
  subtype?: string;
}

interface SlackClientLike {
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  reply(channel: string, threadTs: string, text: string): Promise<{ channel: string; ts: string }>;
}

export default defineAgent({
  triggers: {
    // Channel-scoped watch paths are the wake gate: the cloud dispatcher
    // intersects these against the event's relayfile path BEFORE provisioning a
    // box, so this agent only wakes for the board channel — never for any other
    // channel or DM.
    //
    // `${SLACK_CHANNEL}` is a deploy-time placeholder, NOT a JS template — the
    // single quotes keep it literal in the bundle, and the cloud deploy
    // substitutes the picker-chosen channel id into the watch glob
    // (AgentWorkforce/cloud#1999). Hence single quotes, not backticks.
    slack: [
      {
        on: 'message.created',
        paths: ['/slack/channels/${SLACK_CHANNEL}/**'],
      },
    ],
  },
  handler: async (ctx, event) => {
    await handleSlackEvent(ctx, event, slackClient());
  },
});

export async function handleSlackEvent(
  ctx: WorkforceCtx,
  event: WorkforceProviderEvent,
  slack: SlackClientLike,
): Promise<void> {
  if (event.source !== 'slack') {
    logSkip(ctx, event, 'non-slack event source');
    return;
  }

  const msg = readSlackMessage(event.payload);
  if (!msg) {
    logSkip(ctx, event, 'unparseable slack payload');
    return;
  }

  // Loop guard: never react to bot messages (including our own replies).
  if (msg.isBot) {
    logSkip(ctx, event, 'bot message');
    return;
  }
  // Only fresh human messages — skip edits/deletes/joins/etc.
  if (msg.subtype) {
    logSkip(ctx, event, `slack subtype ${msg.subtype}`);
    return;
  }

  // The trigger paths already gate the wake to the board channel; defense in
  // depth. The deploy resolved SLACK_CHANNEL to the same id it interpolated into
  // the watch path, so the runtime input is the source of truth.
  const boardChannel = input(ctx, 'SLACK_CHANNEL');
  if (boardChannel && msg.channel !== boardChannel) {
    logSkip(ctx, event, 'not the board channel', { channel: msg.channel });
    return;
  }

  const text = stripLeadingMention(msg.text).trim();
  if (!text) {
    logSkip(ctx, event, 'empty message text');
    return;
  }

  const convKey = `${msg.channel}:${msg.threadTs ?? msg.ts}`;
  const history = await recallThread(ctx, convKey);

  const prompt = [
    history.length ? `Conversation so far:\n${history.join('\n')}\n` : '',
    `Teammate just said:\n${text}`,
  ]
    .filter(Boolean)
    .join('\n');

  let reply: string;
  try {
    const result = await ctx.harness.run({ prompt, cwd: ctx.sandbox.cwd });
    reply = result.output.trim() || "I looked but don't have anything to add on that.";
  } catch (err) {
    ctx.log?.('warn', 'linear-slack.harness.failed', { error: errorMessage(err) });
    reply = isTransientLlmError(err)
      ? "I'm getting rate-limited by the model right now — give me a moment and ask again."
      : 'Sorry, I hit an unexpected error working on that. Please try again.';
    // Best-effort apology — we're already in the error path, so don't let an
    // undelivered apology mask the original failure; just log it loudly.
    try {
      await postReply(slack, msg, reply);
    } catch (postErr) {
      ctx.log?.('error', 'linear-slack.reply.undelivered', { error: errorMessage(postErr) });
    }
    return;
  }

  await postReply(slack, msg, reply);
  await rememberTurn(ctx, convKey, 'user', text);
  await rememberTurn(ctx, convKey, 'assistant', reply);
}

/**
 * Post the reply and CONFIRM it was delivered. `slackClient` doesn't call the
 * Slack API — it writes a draft into the VFS mount and polls for a writeback
 * receipt. When the receipt never arrives (writeback path not mounted, mount
 * degraded, box torn down before flush) it RESOLVES with an empty `ts` instead
 * of throwing — relay-helpers swallows the timeout. An empty `ts` therefore
 * means "Slack never got this." Throw so the runtime logs `handler.error` and
 * the dropped reply is visible, instead of a silent no-op that logs
 * `handler.ok` with nothing in the channel (linear-slack investigation
 * 2026-06-09: a whole turn's reply was orphaned as an unflushed draft).
 */
async function postReply(slack: SlackClientLike, msg: SlackMessage, text: string): Promise<void> {
  const result = msg.threadTs
    ? await slack.reply(msg.channel, msg.threadTs, text)
    : await slack.post(msg.channel, text);
  if (!result?.ts) {
    throw new Error(
      `slack ${msg.threadTs ? 'reply' : 'post'} to ${msg.channel} was not delivered ` +
        '(writeback returned no receipt — is the /slack/channels subtree mounted?)',
    );
  }
}

/* ---------- Slack payload reading ---------- */

function readSlackMessage(payload: unknown): SlackMessage | null {
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
    subtype: str(rec.subtype) ?? str(raw.subtype),
  };
}

/** Slack events may arrive wrapped as { resource: { payload | record } } or flat. */
function unwrapRecord(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  if (!record) return null;
  const resource = asRecord(record.resource) ?? record;
  return asRecord(resource.payload) ?? asRecord(resource.record) ?? resource;
}

function stripLeadingMention(text: string): string {
  return text.replace(/^\s*<@[^>\s]+>\s*/u, '');
}

/* ---------- memory (multi-turn) ---------- */

async function recallThread(ctx: WorkforceCtx, convKey: string): Promise<string[]> {
  try {
    const items = await ctx.memory.recall(convKey, {
      scope: 'workspace',
      tags: [MEMORY_TAG, convKey],
      limit: HISTORY_LIMIT,
    });
    return items.map((item) => item.content);
  } catch (err) {
    ctx.log?.('warn', 'linear-slack.memory.recall.failed', { error: errorMessage(err) });
    return [];
  }
}

async function rememberTurn(
  ctx: WorkforceCtx,
  convKey: string,
  role: 'user' | 'assistant',
  body: string,
): Promise<void> {
  if (!body.trim()) return;
  try {
    await ctx.memory.save(`${role}: ${body}`, { scope: 'workspace', tags: [MEMORY_TAG, convKey] });
  } catch (err) {
    ctx.log?.('warn', 'linear-slack.memory.save.failed', { error: errorMessage(err) });
  }
}

/* ---------- small helpers ---------- */

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const value = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return value && value.trim() ? value.trim() : undefined;
}

function isTransientLlmError(error: unknown): boolean {
  return /\b429\b|rate_limit|\b50[0-9]\b|overloaded|timeout/i.test(errorMessage(error));
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkip(
  ctx: WorkforceCtx,
  event: WorkforceProviderEvent,
  reason: string,
  attrs: Record<string, unknown> = {},
): void {
  ctx.log?.('info', 'linear-slack skipped', { eventId: event.id, type: event.type, reason, ...attrs });
}
