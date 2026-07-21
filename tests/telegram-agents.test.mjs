import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import {
  readTelegramMessage,
  bareChatId,
  conversationKeyForTelegram,
  skipReason,
  replyToMessage
} from '../.test-build/shared/telegram.js';
import { handleTelegramMessage as inboxHandle } from '../.test-build/inbox-buddy/agent.js';
import { handleTelegramMention, handleJokeOfTheDay, handleSlackMention } from '../.test-build/joke-bot/agent.js';
import jokeBotPersona from '../.test-build/joke-bot/persona.js';
import { checkReleases } from '../.test-build/spotify-releases/agent.js';
import { postFreshStories, retryPendingThreadBody } from '../.test-build/hn-monitor/agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEEDS = path.join(HERE, '..', 'evals', 'seeds');

const ORIG_MOUNT_ROOT = process.env.RELAYFILE_MOUNT_ROOT;
function restoreMountRoot() {
  if (ORIG_MOUNT_ROOT === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
  else process.env.RELAYFILE_MOUNT_ROOT = ORIG_MOUNT_ROOT;
}

function telegramEvent({ chatId = '123', messageId = '10', text = 'hi', fromIsBot = false, threadId } = {}) {
  const resource = { chatId, messageId, text, from: { is_bot: fromIsBot } };
  if (threadId) resource.messageThreadId = threadId;
  return envelopeToAgentEvent({
    id: `evt_${messageId}`,
    workspace: 'ws-test',
    type: 'telegram.message',
    occurredAt: '2026-06-10T12:00:00.000Z',
    resource
  });
}

/** A fake Telegram sender capturing send() calls. */
function makeTelegram() {
  const sends = [];
  return {
    sends,
    async send(chatId, text, opts) {
      sends.push({ chatId, text, opts });
      return { ok: true, messageId: `${sends.length}` };
    }
  };
}

function makeCtx() {
  const store = [];
  let seq = 0;
  return {
    logs: [],
    log(level, message, data) { this.logs.push({ level, message, data }); },
    memory: {
      async save(content, opts = {}) { store.push({ content, tags: opts.tags ?? [], scope: opts.scope, seq: seq++ }); return { id: `m${seq}` }; },
      async recall(_q, opts = {}) {
        const tags = opts.tags ?? [];
        return store
          .filter((r) => tags.every((t) => r.tags.includes(t)))
          .sort((a, b) => b.seq - a.seq)
          .slice(0, opts.limit ?? 50)
          .map((r) => ({ id: `m${r.seq}`, content: r.content, tags: r.tags, scope: r.scope, createdAt: '' }));
      }
    },
    llm: { async complete() { throw new Error('inject deps.complete in tests'); } }
  };
}

// ── shared transport ──────────────────────────────────────────────────────────

test('readTelegramMessage parses a telegram.message payload', async () => {
  const ev = telegramEvent({ chatId: '42', messageId: '7', text: 'tell me a joke', threadId: '3' });
  const msg = readTelegramMessage((await ev.expand('full')).data);
  assert.equal(msg.chatId, '42');
  assert.equal(msg.messageId, '7');
  assert.equal(msg.text, 'tell me a joke');
  assert.equal(msg.threadId, '3');
  assert.equal(msg.fromIsBot, false);
});

test('bareChatId strips the __title suffix', () => {
  assert.equal(bareChatId('42__general'), '42');
  assert.equal(bareChatId('42'), '42');
});

test('conversationKeyForTelegram keys on bare chat, plus forum topic', () => {
  assert.equal(conversationKeyForTelegram({ chatId: '42__x', messageId: '1', text: 'a', fromIsBot: false }), '42');
  assert.equal(conversationKeyForTelegram({ chatId: '42', messageId: '1', text: 'a', fromIsBot: false, threadId: '9' }), '42:9');
});

test('skipReason: bot loop guard, wrong chat, empty text', () => {
  assert.equal(skipReason({ chatId: '1', messageId: '1', text: 'hi', fromIsBot: true }, '1'), 'bot message');
  assert.equal(skipReason({ chatId: '2', messageId: '1', text: 'hi', fromIsBot: false }, '1'), 'not the configured chat');
  assert.equal(skipReason({ chatId: '1', messageId: '1', text: 'hi', fromIsBot: false }, undefined), 'not the configured chat');
  assert.equal(skipReason({ chatId: '1', messageId: '1', text: 'hi', fromIsBot: false }, ''), 'not the configured chat');
  assert.equal(skipReason({ chatId: '1', messageId: '1', text: '   ', fromIsBot: false }, '1'), 'empty message text');
  assert.equal(skipReason({ chatId: '1__g', messageId: '1', text: 'real', fromIsBot: false }, '1'), null);
});

test('replyToMessage threads on the source message id', async () => {
  const tg = makeTelegram();
  const ctx = makeCtx();
  await replyToMessage(ctx, tg, { chatId: '5__chat', messageId: '99', text: 'q', fromIsBot: false }, 'an answer');
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.sends[0].chatId, '5');
  assert.equal(tg.sends[0].text, 'an answer');
  assert.equal(tg.sends[0].opts.replyToMessageId, 99);
});

// ── inbox-buddy (Telegram transport of the unified dual-transport agent) ───────

function seedGmailMount() {
  const mount = mkdtempSync(path.join(tmpdir(), 'ibt-'));
  const dir = path.join(mount, 'google-mail', 'threads');
  mkdirSync(dir, { recursive: true });
  for (const [id, file] of Object.entries({
    T_alice_export: 'gmail-thread-alice-export.json',
    T_bob_lunch: 'gmail-thread-bob-lunch.json'
  })) {
    writeFileSync(path.join(dir, `${id}.json`), readFileSync(path.join(SEEDS, file), 'utf8'));
  }
  return mount;
}

test('inbox-buddy (telegram): answers a Gmail question and threads the reply + records the turn', async () => {
  const mount = seedGmailMount();
  process.env.RELAYFILE_MOUNT_ROOT = mount;
  try {
    const ctx = makeCtx();
    const tg = makeTelegram();
    let seenPrompt = '';
    await inboxHandle(
      { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '123' }, inputSpecs: {} } },
      telegramEvent({ chatId: '123', messageId: '5', text: 'recap the Alice export thread' }),
      { complete: async (p) => { seenPrompt = p; return 'Alice sends the numbers Friday.'; }, telegram: tg, now: () => new Date('2026-06-10T12:00:00Z') }
    );
    assert.match(seenPrompt, /Threads in focus/);
    assert.equal(tg.sends.length, 1);
    assert.equal(tg.sends[0].chatId, '123');
    assert.equal(tg.sends[0].opts.replyToMessageId, 5);
    assert.match(tg.sends[0].text, /Friday/);
    // The turn was persisted for continuity (transcript saved under the conv tag).
    assert.ok(ctx.logs.some((l) => l.message?.includes('inbox-buddy.context') && l.message?.includes('transport=telegram')));
  } finally {
    restoreMountRoot();
    rmSync(mount, { recursive: true, force: true });
  }
});

test('inbox-buddy (telegram): skips the bot\'s own messages (loop guard)', async () => {
  const ctx = makeCtx();
  const tg = makeTelegram();
  await inboxHandle(
    { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '123' }, inputSpecs: {} } },
    telegramEvent({ chatId: '123', messageId: '6', text: 'echo', fromIsBot: true }),
    { complete: async () => 'should not run', telegram: tg }
  );
  assert.equal(tg.sends.length, 0);
});

test('inbox-buddy (telegram): fails closed when TELEGRAM_CHAT is unset', async () => {
  const ctx = makeCtx();
  const tg = makeTelegram();
  let completeCalls = 0;
  await inboxHandle(
    ctx,
    telegramEvent({ chatId: '123', messageId: '7', text: 'a human message' }),
    { complete: async () => { completeCalls++; return 'should not run'; }, telegram: tg }
  );
  assert.equal(completeCalls, 0);
  assert.equal(tg.sends.length, 0);
  assert.ok(
    ctx.logs.some((l) => l.message.includes('reason=not-the-configured-chat') && l.message.includes('configured=unset'))
  );
});

// ── joke-bot (Telegram transport of the unified dual-transport agent) ──────────

test('joke-bot (telegram): replies with a joke and saves the turn', async () => {
  const ctx = makeCtx();
  const tg = makeTelegram();
  await handleTelegramMention(
    { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '77' }, inputSpecs: {} } },
    telegramEvent({ chatId: '77', messageId: '8', text: 'joke about cron jobs' }),
    { complete: async () => 'Why did the cron job cross the road? At 0 0 * * *.', telegram: tg }
  );
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.sends[0].chatId, '77');
  assert.equal(tg.sends[0].opts.replyToMessageId, 8);
  assert.match(tg.sends[0].text, /cron/);
  // Conversation turn saved for callback humor.
  const saved = await ctx.memory.recall('x', { tags: ['joke-convo:telegram:77'] });
  assert.equal(saved.length, 1);
});

test('joke-bot (telegram): replays memory oldest-first', async () => {
  const ctx = makeCtx();
  const tg = makeTelegram();
  await ctx.memory.save('User: first\njoke-bot: first reply', { tags: ['joke-convo:telegram:77'], scope: 'workspace' });
  await ctx.memory.save('User: second\njoke-bot: second reply', { tags: ['joke-convo:telegram:77'], scope: 'workspace' });
  let prompt = '';
  await handleTelegramMention(
    { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '77' }, inputSpecs: {} } },
    telegramEvent({ chatId: '77', messageId: '9', text: 'callback?' }),
    { complete: async (p) => { prompt = p; return 'A callback joke.'; }, telegram: tg }
  );
  assert.ok(prompt.indexOf('User: first') < prompt.indexOf('User: second'));
});

test('joke-bot (telegram): sends a fallback when joke generation fails', async () => {
  const ctx = makeCtx();
  const tg = makeTelegram();
  await handleTelegramMention(
    { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '77' }, inputSpecs: {} } },
    telegramEvent({ chatId: '77', messageId: '10', text: 'joke about outages' }),
    { complete: async () => { throw new Error('llm unavailable'); }, telegram: tg }
  );
  assert.equal(tg.sends.length, 1);
  assert.match(tg.sends[0].text, /dead mic/);
  const saved = await ctx.memory.recall('x', { tags: ['joke-convo:telegram:77'] });
  assert.equal(saved.length, 1);
});

test('joke-bot (telegram): joke of the day posts to the configured chat', async () => {
  const ctx = makeCtx();
  const tg = makeTelegram();
  await handleJokeOfTheDay(
    { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '77__general' }, inputSpecs: {} } },
    { complete: async () => 'A daily zinger.', telegram: tg }
  );
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.sends[0].chatId, '77');
  assert.match(tg.sends[0].text, /Joke of the day/);
});

// ── spotify-releases (Telegram transport of the unified dual-transport agent) ──

test('spotify-releases (telegram): missing SPOTIFY_TOKEN fails loudly', async () => {
  const ctx = makeCtx();
  await assert.rejects(
    () => checkReleases({ ...ctx, persona: { inputs: { TELEGRAM_CHAT: '5' }, inputSpecs: {} } }, { telegram: makeTelegram() }),
    /SPOTIFY_TOKEN is required/
  );
});

test('spotify-releases (telegram): missing both transports fails loudly', async () => {
  const ctx = makeCtx();
  await assert.rejects(
    () => checkReleases({ ...ctx, persona: { inputs: { SPOTIFY_TOKEN: 'tok' }, inputSpecs: {} } }, { telegram: makeTelegram() }),
    /At least one of SLACK_USER or TELEGRAM_CHAT/
  );
});

test('spotify-releases (telegram): sends same-day releases once and advances only after delivery', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = makeCtx();
  const tg = makeTelegram();
  await ctx.memory.save('2026-06-10', { tags: ['spotify-releases:last-check'], scope: 'workspace' });
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/me/following')) {
      return Response.json({ artists: { items: [{ id: 'a1', name: 'Artist One' }] } });
    }
    return Response.json({
      items: [{ name: 'Same Day Single', release_date: '2026-06-10', external_urls: { spotify: 'https://open.spotify.com/album/1' } }]
    });
  };
  try {
    await checkReleases(
      { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '5', SPOTIFY_TOKEN: 'tok' }, inputSpecs: {} } },
      { telegram: tg }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(tg.sends.length, 1);
  assert.match(tg.sends[0].text, /Same Day Single/);
  const notified = await ctx.memory.recall('x', { tags: ['spotify-releases:notified'] });
  assert.deepEqual(JSON.parse(notified[0].content), ['https://open.spotify.com/album/1']);
});

test('spotify-releases (telegram): does not checkpoint after a Telegram no-receipt send', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = makeCtx();
  const tg = { sends: [], async send(chatId, text, opts) { this.sends.push({ chatId, text, opts }); return { ok: false }; } };
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/me/following')) {
      return Response.json({ artists: { items: [{ id: 'a1', name: 'Artist One' }] } });
    }
    return Response.json({
      items: [{ name: 'Undelivered Single', release_date: '2026-06-10', external_urls: { spotify: 'https://open.spotify.com/album/2' } }]
    });
  };
  try {
    await checkReleases(
      { ...ctx, persona: { inputs: { TELEGRAM_CHAT: '5', SPOTIFY_TOKEN: 'tok' }, inputSpecs: {} } },
      { telegram: tg }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(tg.sends.length, 1);
  assert.equal((await ctx.memory.recall('x', { tags: ['spotify-releases:last-check'] })).length, 0);
  assert.equal((await ctx.memory.recall('x', { tags: ['spotify-releases:notified'] })).length, 0);
});

// ── Slack side of the unified agents (dual-transport dispatch + fan-out) ───────

/** A fake Slack client capturing post/reply/dm calls. */
function makeSlack() {
  const calls = [];
  return {
    calls,
    async post(channel, text) { calls.push({ kind: 'post', channel, text }); return { ts: `${calls.length}.1` }; },
    async reply(channel, threadTs, text) { calls.push({ kind: 'reply', channel, threadTs, text }); return { ts: `${calls.length}.1` }; },
    async dm(userId, text) { calls.push({ kind: 'dm', userId, text }); return { ok: true }; }
  };
}

function slackMentionEvent({ channel = 'C_CHAT', ts = '1', text = '<@U_BOT> hi', threadTs, isBot = false } = {}) {
  const resource = { channel, ts, text, user: 'U_HUMAN' };
  if (threadTs) resource.thread_ts = threadTs;
  if (isBot) resource.is_bot = true;
  return envelopeToAgentEvent({
    id: `evt_${ts}`,
    workspace: 'ws-test',
    type: 'slack.message.created',
    occurredAt: '2026-06-10T12:00:00.000Z',
    resource
  });
}

test('joke-bot (slack): declares its own Slack user id as deployment configuration', () => {
  assert.deepEqual(jokeBotPersona.inputs?.SLACK_BOT_USER_ID, {
    description:
      'Slack user id of the connected bot (the id in its <@...> mention). Required when SLACK_CHANNEL is set so joke-bot only answers messages addressed to it.',
    env: 'SLACK_BOT_USER_ID',
    optional: true
  });
});

test('joke-bot (slack): replies in-thread to an @mention in the configured channel', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  let prompt = '';
  await handleSlackMention(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C_CHAT', SLACK_BOT_USER_ID: 'U_BOT' }, inputSpecs: {} } },
    slackMentionEvent({ channel: 'C_CHAT', ts: '5', threadTs: '4', text: '<@U_BOT> joke about yaml' }),
    { complete: async (value) => { prompt = value; return 'YAML walks into a bar. The bar is also valid YAML.'; }, slack }
  );
  assert.equal(slack.calls.length, 1);
  assert.equal(slack.calls[0].kind, 'reply');
  assert.equal(slack.calls[0].threadTs, '4');
  assert.match(slack.calls[0].text, /YAML/);
  assert.doesNotMatch(prompt, /<@U_BOT>/);
});

test('joke-bot (slack): ignores an @mention in a different channel (fail closed)', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  await handleSlackMention(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C_CHAT', SLACK_BOT_USER_ID: 'U_BOT' }, inputSpecs: {} } },
    slackMentionEvent({ channel: 'C_OTHER', ts: '6', text: '<@U_BOT> joke' }),
    { complete: async () => 'nope', slack }
  );
  assert.equal(slack.calls.length, 0);
});

test('joke-bot (slack): ignores a message that mentions only another user', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  let completed = false;
  await handleSlackMention(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C_CHAT', SLACK_BOT_USER_ID: 'U_BOT' }, inputSpecs: {} } },
    slackMentionEvent({ channel: 'C_CHAT', ts: '7', text: '<@U_ALICE> hey' }),
    { complete: async () => { completed = true; return 'nope'; }, slack }
  );
  assert.equal(completed, false);
  assert.equal(slack.calls.length, 0);
});

test('joke-bot (slack): preserves another leading mention when the bot mention is later', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  let prompt = '';
  await handleSlackMention(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C_CHAT', SLACK_BOT_USER_ID: 'U_BOT' }, inputSpecs: {} } },
    slackMentionEvent({ channel: 'C_CHAT', ts: '8', text: '<@U_ALICE> ask <@U_BOT> for a joke' }),
    { complete: async (value) => { prompt = value; return 'A joke for Alice.'; }, slack }
  );
  assert.equal(slack.calls.length, 1);
  assert.match(prompt, /The user just said: <@U_ALICE> ask <@U_BOT> for a joke/);
});

test('joke-bot (slack): fails closed when its Slack user id is not configured', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  await handleSlackMention(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C_CHAT' }, inputSpecs: {} } },
    slackMentionEvent({ channel: 'C_CHAT', ts: '9', text: '<@U_BOT> joke' }),
    { complete: async () => 'nope', slack }
  );
  assert.equal(slack.calls.length, 0);
});

test('joke-bot: joke of the day fans out to BOTH transports when both configured', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  const tg = makeTelegram();
  await handleJokeOfTheDay(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C_CHAT', TELEGRAM_CHAT: '77' }, inputSpecs: {} } },
    { complete: async () => 'A daily zinger.', slack, telegram: tg }
  );
  assert.equal(slack.calls.length, 1);
  assert.equal(slack.calls[0].kind, 'post');
  assert.match(slack.calls[0].text, /Joke of the day/);
  assert.equal(tg.sends.length, 1);
  assert.equal(tg.sends[0].chatId, '77');
  assert.match(tg.sends[0].text, /Joke of the day/);
});

test('spotify-releases (slack): DMs releases to SLACK_USER, advances checkpoint', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = makeCtx();
  const slack = makeSlack();
  await ctx.memory.save('2026-06-10', { tags: ['spotify-releases:last-check'], scope: 'workspace' });
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/me/following')) return Response.json({ artists: { items: [{ id: 'a1', name: 'Artist One' }] } });
    return Response.json({
      items: [{ name: 'Slack Single', release_date: '2026-06-11', external_urls: { spotify: 'https://open.spotify.com/album/9' } }]
    });
  };
  try {
    await checkReleases(
      { ...ctx, persona: { inputs: { SLACK_USER: 'U_ME', SPOTIFY_TOKEN: 'tok' }, inputSpecs: {} } },
      { slack }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(slack.calls.length, 1);
  assert.equal(slack.calls[0].kind, 'dm');
  assert.equal(slack.calls[0].userId, 'U_ME');
  assert.match(slack.calls[0].text, /Slack Single/);
  const notified = await ctx.memory.recall('x', { tags: ['spotify-releases:notified'] });
  assert.deepEqual(JSON.parse(notified[0].content), ['https://open.spotify.com/album/9']);
});
