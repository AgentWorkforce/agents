/**
 * linear-slack handler (harness / VFS-navigation model).
 *
 * Slack-native conversational Linear board assistant. It responds to every
 * human message in one dedicated channel (the SLACK_CHANNEL picker input) and
 * runs a claude harness inside the sandbox with the Linear VFS mounted — the
 * model navigates `./linear` on demand (see persona.systemPrompt) instead of
 * having the whole board pre-loaded into context.
 *
 * The handler gates the event, reconstructs the thread's conversation history
 * from memory (multi-turn), hands the turn to the harness, then posts the reply.
 * DMs are not handled.
 *
 * Board WRITES do NOT go through the harness's filesystem. The mounted `./linear`
 * tree is for READS only — the harness once "created" an issue by hand-writing a
 * JSON file into it (inventing an `AR-NN` ref + UUID), which is not a Linear
 * mutation and silently created nothing while the reply claimed success. Instead
 * the harness resolves ids from the VFS and emits a fenced `linear-actions`
 * block; this handler executes those actions through `linearClient()` (the real
 * writeback: draft → `issueCreate` → receipt) and reports the CONFIRMED Linear
 * url. Unconfirmed writes are surfaced, never claimed as done.
 */
import {
  defineAgent,
  type WorkforceCtx,
  type WorkforceProviderEvent,
} from '@agentworkforce/runtime';
import { linearClient, slackClient } from '@relayfile/relay-helpers';

const MEMORY_TAG = 'linear-slack';
const HISTORY_LIMIT = 8;

// The harness appends board mutations as a single fenced block of JSON actions
// (an array, or one object). Reads stay in the VFS; only writes ride this rail.
const LINEAR_ACTION_FENCE = /```linear-actions\s*\n([\s\S]*?)```/;
// Allow-listed Linear IssueCreateInput fields. Whitelisting (vs forwarding the
// raw object) keeps a stray read-only field — `id`/`identifier` — from tripping
// the adapter's `rejectReadOnlyFields` and failing the whole create.
const CREATE_ISSUE_FIELDS = [
  'teamId', 'title', 'description', 'projectId', 'priority',
  'assigneeId', 'stateId', 'labelIds', 'dueDate', 'estimate', 'parentId', 'cycleId',
] as const;

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
  react(channel: string, messageTs: string, emoji: string): Promise<void>;
}

// Reacted onto the teammate's message the instant the handler picks up the turn,
// so the channel gets an acknowledgement within seconds of box-boot instead of
// sitting silent for the minutes-long harness run.
const ACK_EMOJI = 'eyes';

// How long writes wait for a writeback receipt. The relay-helpers default is 3s
// — too short for the cloud worker's round-trip, so `post()` returned `ts: ''`
// and `createIssue()` returned the draft-path fallback even when the write
// actually landed (2026-06-09: the issue was created but the reply never
// posted). A longer window keeps the handler — and the box — alive until the
// receipt arrives, so the reply both confirms and flushes before teardown.
const WRITEBACK_TIMEOUT_MS = 12_000;

/**
 * The slice of `linearClient()` this handler uses for writes. Both calls go
 * through the VFS writeback (draft → mutation → receipt) and return
 * `{ id, url }` — but they FALL BACK to the draft path when no receipt arrives
 * (relay-helpers `created()` swallows the timeout), so a `url` that isn't an
 * http(s) link means "Linear never confirmed it." Callers must check.
 */
interface LinearWriteClient {
  createIssue(
    args: { teamId: string; title: string } & Record<string, unknown>,
  ): Promise<{ id: string; url: string }>;
  comment(issueId: string, body: string): Promise<{ id: string; url: string }>;
}

interface LinearAction {
  action: string;
  [key: string]: unknown;
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
    const opts = { writebackTimeoutMs: WRITEBACK_TIMEOUT_MS };
    await handleSlackEvent(ctx, event, slackClient(opts), linearClient(opts));
  },
});

export async function handleSlackEvent(
  ctx: WorkforceCtx,
  event: WorkforceProviderEvent,
  slack: SlackClientLike,
  linear: LinearWriteClient,
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

  // Acknowledge before the long harness run. Fire-and-forget: the draft is
  // written synchronously (so the 👀 is queued immediately), and we DON'T await
  // the receipt — the harness starts right away while the reaction flushes in
  // the background. Best-effort; never fail the turn over a reaction.
  void Promise.resolve(slack.react(msg.channel, msg.ts, ACK_EMOJI)).catch((err) =>
    ctx.log?.('warn', 'linear-slack.ack.failed', { error: errorMessage(err) }),
  );

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
    await postReply(ctx, slack, msg, reply);
    return;
  }

  // Split any board-mutation block off the prose and run it through the real
  // Linear writeback. The user-facing reply is the harness prose plus the
  // CONFIRMED outcome of each action — never the harness's own success claim.
  const { prose, actions, malformed } = extractActions(reply);
  const outcomes = malformed
    ? ['⚠️ I tried to update the board but my action block was malformed — nothing was changed.']
    : await executeLinearActions(ctx, linear, actions);

  const finalReply = [prose, ...outcomes].map((s) => s.trim()).filter(Boolean).join('\n\n')
    || "I looked but don't have anything to add on that.";

  await postReply(ctx, slack, msg, finalReply);
  await rememberTurn(ctx, convKey, 'user', text);
  await rememberTurn(ctx, convKey, 'assistant', finalReply);
}

/** Pull the fenced `linear-actions` block out of the reply, leaving the prose. */
function extractActions(reply: string): { prose: string; actions: LinearAction[]; malformed: boolean } {
  const match = reply.match(LINEAR_ACTION_FENCE);
  if (!match) return { prose: reply, actions: [], malformed: false };
  const prose = reply.replace(LINEAR_ACTION_FENCE, '').trim();
  try {
    const parsed = JSON.parse(match[1].trim());
    const actions = Array.isArray(parsed) ? parsed : [parsed];
    // Drop anything that isn't a tagged action object.
    const valid = actions.filter(
      (a): a is LinearAction => Boolean(a) && typeof a === 'object' && typeof a.action === 'string',
    );
    return { prose, actions: valid, malformed: false };
  } catch {
    return { prose, actions: [], malformed: true };
  }
}

/**
 * Execute board mutations and return one CONFIRMED-or-flagged line each. A write
 * counts as done only when Linear hands back a real http(s) url; the draft-path
 * fallback (no receipt) is reported as unconfirmed so we never fabricate success.
 */
async function executeLinearActions(
  ctx: WorkforceCtx,
  linear: LinearWriteClient,
  actions: LinearAction[],
): Promise<string[]> {
  const outcomes: string[] = [];
  for (const action of actions) {
    try {
      if (action.action === 'create_issue') {
        const teamId = str(action.teamId);
        const title = str(action.title);
        if (!teamId || !title) {
          outcomes.push(`⚠️ Couldn't create the issue — missing \`${!teamId ? 'teamId' : 'title'}\`. Can you confirm it?`);
          continue;
        }
        const { url } = await linear.createIssue({ ...pick(action, CREATE_ISSUE_FIELDS), teamId, title });
        outcomes.push(confirm(
          ctx, 'create_issue', url,
          `✅ Created the issue: ${url}`,
          '📝 Submitting that issue to Linear now — it should appear on the board within a minute or two.',
        ));
      } else if (action.action === 'comment') {
        const missing = !str(action.issueId) ? 'issueId' : !str(action.body) ? 'body' : null;
        if (missing) {
          outcomes.push(`⚠️ Couldn't add the comment — missing \`${missing}\`.`);
          continue;
        }
        const { url } = await linear.comment(String(action.issueId), String(action.body));
        outcomes.push(confirm(
          ctx, 'comment', url,
          `✅ Added the comment: ${url}`,
          '📝 Posting that comment to Linear now — it should appear shortly.',
        ));
      } else {
        outcomes.push(`⚠️ I can't do "${action.action}" yet — only creating issues and commenting.`);
      }
    } catch (err) {
      ctx.log?.('error', 'linear-slack.action.failed', { action: action.action, error: errorMessage(err) });
      outcomes.push(`⚠️ "${action.action}" failed: ${errorMessage(err)}`);
    }
  }
  return outcomes;
}

/**
 * A receipt url (http) proves the mutation landed and we link it. The draft-path
 * fallback means the receipt didn't return inside the wait window — the write
 * still flushes (creates land via the mirror within ~minutes), so we report it
 * as pending rather than failed, and log it for triage.
 */
function confirm(ctx: WorkforceCtx, action: string, url: string, okMessage: string, pendingMessage: string): string {
  if (/^https?:\/\//i.test(url)) return okMessage;
  ctx.log?.('warn', 'linear-slack.action.unconfirmed', { action, url });
  return pendingMessage;
}

/** Copy only the allow-listed keys whose values are present. */
function pick(source: LinearAction, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

/**
 * Post the reply. `slackClient` doesn't call the Slack API — it writes a draft
 * into the VFS mount and polls up to `WRITEBACK_TIMEOUT_MS` for a receipt,
 * returning an empty `ts` if none arrives.
 *
 * An empty `ts` is NOT proof of a drop: the `/slack/channels` scope is mounted
 * (build-time guard) and the draft still flushes at box cleanup, so a missing
 * receipt usually just means the worker's round-trip outran the wait. We log it
 * loudly for triage but DO NOT throw — an earlier version threw here, which
 * crashed the turn and tore the box down before the draft could flush, eating
 * the reply entirely (2026-06-09: issue created, channel silent). The genuine
 * "nothing mounts /slack" failure is caught at build time by
 * tests/persona-integration-scopes, not here.
 */
async function postReply(
  ctx: WorkforceCtx,
  slack: SlackClientLike,
  msg: SlackMessage,
  text: string,
): Promise<void> {
  const result = msg.threadTs
    ? await slack.reply(msg.channel, msg.threadTs, text)
    : await slack.post(msg.channel, text);
  if (!result?.ts) {
    ctx.log?.('warn', 'linear-slack.reply.no-receipt', { channel: msg.channel, threaded: Boolean(msg.threadTs) });
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
