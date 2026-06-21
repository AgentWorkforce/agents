import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';
import { parseIntegrations } from '@agentworkforce/persona-kit';

import {
  selectThreads,
  sortThreadsByRecencyDesc,
  isThreadRecord,
  queryTokens,
  loadRecentThreads
} from '../.test-build/inbox-buddy/lib/gmail.js';
import { buildPrompt, focusedThreadIds } from '../.test-build/inbox-buddy/lib/prompt.js';
import { renderTranscript } from '../.test-build/inbox-buddy/lib/conversation.js';
import {
  readSlackMessage,
  skipReason,
  conversationKeyForSlack,
  stripLeadingMention
} from '../.test-build/inbox-buddy/lib/slack.js';
import { handleSlackMessage } from '../.test-build/inbox-buddy/agent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEEDS = path.join(HERE, '..', 'evals', 'seeds');

const THREAD_FILES = {
  T_alice_export: 'gmail-thread-alice-export.json',
  T_github_pr: 'gmail-thread-github-pr.json',
  T_bob_lunch: 'gmail-thread-bob-lunch.json',
  T_newsletter: 'gmail-thread-newsletter.json'
};

function loadSeedThreads() {
  return Object.values(THREAD_FILES).map((f) => JSON.parse(readFileSync(path.join(SEEDS, f), 'utf8')));
}

/** Temp mount with /google-mail/threads/*.json so loadRecentThreads can read it. */
function seedMount() {
  const mount = mkdtempSync(path.join(tmpdir(), 'inbox-buddy-'));
  const dir = path.join(mount, 'google-mail', 'threads');
  mkdirSync(dir, { recursive: true });
  for (const [id, file] of Object.entries(THREAD_FILES)) {
    writeFileSync(path.join(dir, `${id}.json`), readFileSync(path.join(SEEDS, file), 'utf8'));
  }
  writeFileSync(path.join(dir, '_index.json'), JSON.stringify({ rows: [] }));
  return mount;
}

/** In-memory ctx: newest-first recall by tag, capturing logs. */
function makeCtx() {
  const store = [];
  let seq = 0;
  return {
    logs: [],
    log(level, message, data) {
      this.logs.push({ level, message, data });
    },
    memory: {
      async save(content, opts = {}) {
        store.push({ content, tags: opts.tags ?? [], scope: opts.scope, seq: seq++ });
        return { id: `m${seq}` };
      },
      async recall(_query, opts = {}) {
        const tags = opts.tags ?? [];
        const limit = opts.limit ?? 50;
        return store
          .filter((r) => tags.every((t) => r.tags.includes(t)))
          .sort((a, b) => b.seq - a.seq)
          .slice(0, limit)
          .map((r) => ({ id: `m${r.seq}`, content: r.content, tags: r.tags, scope: r.scope, createdAt: '' }));
      }
    },
    llm: {
      async complete() {
        throw new Error('ctx.llm.complete should be injected in tests');
      }
    }
  };
}

/** A fake Slack poster capturing post/reply calls. */
function makeSlack() {
  const calls = [];
  return {
    calls,
    async post(channel, text) {
      calls.push({ kind: 'post', channel, text });
      return { channel, ts: `${calls.length}.1` };
    },
    async reply(channel, threadTs, text) {
      calls.push({ kind: 'reply', channel, threadTs, text });
      return { channel, ts: `${calls.length}.1` };
    }
  };
}

function slackEvent({ channel = 'C_CHAT', ts, text, user = 'U_HUMAN', threadTs, isBot = false, subtype }) {
  const resource = { channel, ts, text, user };
  if (threadTs) resource.thread_ts = threadTs;
  if (isBot) resource.is_bot = true;
  if (subtype) resource.subtype = subtype;
  return envelopeToAgentEvent({
    id: `evt_${ts}`,
    workspace: 'ws-test',
    type: 'slack.app_mention',
    occurredAt: '2026-06-10T12:00:00.000Z',
    resource
  });
}

// ── pure helpers ──────────────────────────────────────────────────────────────

test('isThreadRecord accepts real thread records, rejects index/junk', () => {
  const [alice] = loadSeedThreads();
  assert.equal(isThreadRecord(alice), true);
  assert.equal(isThreadRecord({ rows: [] }), false);
  assert.equal(isThreadRecord(null), false);
  assert.equal(isThreadRecord({ id: 'x' }), false);
});

test('sortThreadsByRecencyDesc orders by latest message activity', () => {
  const sorted = sortThreadsByRecencyDesc(loadSeedThreads());
  assert.deepEqual(sorted.map((t) => t.id), ['T_alice_export', 'T_github_pr', 'T_bob_lunch', 'T_newsletter']);
});

test('queryTokens drops stopwords and short tokens', () => {
  assert.deepEqual(queryTokens('what is that thread with Alice about the export'), ['alice', 'export']);
});

test('selectThreads resolves "that thread with Alice about the export" to the right thread', () => {
  const hits = selectThreads(loadSeedThreads(), 'summarize that thread with Alice about the export');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'T_alice_export');
});

test('selectThreads returns nothing for an unmatched reference', () => {
  assert.deepEqual(selectThreads(loadSeedThreads(), 'spaceship telemetry from mars'), []);
});

test('buildPrompt expands a referenced thread to its FULL message list (email threading)', () => {
  const threads = sortThreadsByRecencyDesc(loadSeedThreads());
  const prompt = buildPrompt({ question: 'what did Alice say in the Q3 export thread?', transcript: [], threads });
  assert.match(prompt, /Threads in focus/);
  assert.match(prompt, /m_ax1/);
  assert.match(prompt, /m_ax2/);
  assert.match(prompt, /m_ax3/);
});

// ── slack parsing / gating ──────────────────────────────────────────────────

test('readSlackMessage parses a slack.message.created payload', async () => {
  const ev = slackEvent({ ts: '1', text: 'hi there', threadTs: '0.9' });
  const msg = readSlackMessage((await ev.expand('full')).data);
  assert.equal(msg.channel, 'C_CHAT');
  assert.equal(msg.ts, '1');
  assert.equal(msg.threadTs, '0.9');
  assert.equal(msg.text, 'hi there');
  assert.equal(msg.isBot, false);
});

test('skipReason: loop guard on bot messages, channel filter, empty text', () => {
  assert.equal(skipReason({ channel: 'C_CHAT', ts: '1', text: 'hi', isBot: true }, 'C_CHAT'), 'bot message');
  assert.match(skipReason({ channel: 'C_CHAT', ts: '1', text: 'hi', isBot: false, subtype: 'message_changed' }, 'C_CHAT'), /subtype/);
  assert.equal(skipReason({ channel: 'C_OTHER', ts: '1', text: 'hi', isBot: false }, 'C_CHAT'), 'not the chat channel');
  assert.equal(skipReason({ channel: 'C_CHAT', ts: '1', text: '   ', isBot: false }, 'C_CHAT'), 'empty message text');
  assert.equal(skipReason({ channel: 'C_CHAT', ts: '1', text: 'real question', isBot: false }, 'C_CHAT'), null);
});

test('conversationKeyForSlack: thread keys on thread, top-level keys on channel', () => {
  assert.equal(conversationKeyForSlack({ channel: 'C1', ts: '2' }), 'C1');
  assert.equal(conversationKeyForSlack({ channel: 'C1', ts: '2', threadTs: '1' }), 'C1:1');
});

test('stripLeadingMention removes a leading @mention', () => {
  assert.equal(stripLeadingMention('<@U123> what is up'), 'what is up');
});

test('renderTranscript is empty on the first turn', () => {
  assert.equal(renderTranscript([]), '');
});

// ── conversational continuity (the forcing-function) ──────────────────────────

test('multi-turn: turn 2 prompt replays turn 1 (continuity across messages)', async () => {
  const mount = seedMount();
  process.env.RELAYFILE_MOUNT_ROOT = mount;
  try {
    const ctx = makeCtx();
    const slack = makeSlack();
    const prompts = [];

    const turn1Answer = 'Alice will send the final Q3 export numbers by Friday and is looping in finance.';
    await handleSlackMessage(
      ctx,
      slackEvent({ ts: '1', text: "What's the latest on the Q3 export thread with Alice?" }),
      { complete: async (p) => { prompts.push(p); return turn1Answer; }, slack }
    );

    const turn2Answer = 'She looped in finance@acme.com for sign-off.';
    await handleSlackMessage(
      ctx,
      slackEvent({ ts: '2', text: 'Who did she loop in?' }),
      { complete: async (p) => { prompts.push(p); return turn2Answer; }, slack }
    );

    assert.equal(prompts.length, 2);
    const turn2Prompt = prompts[1];
    // The prior user turn AND assistant answer must be replayed so "she" resolves.
    assert.match(turn2Prompt, /Conversation so far/);
    assert.match(turn2Prompt, /Q3 export thread with Alice/);
    assert.match(turn2Prompt, /final Q3 export numbers by Friday/);
    // Both turns answered into the chat channel.
    assert.equal(slack.calls.length, 2);
    assert.equal(slack.calls[0].text, turn1Answer);
    assert.equal(slack.calls[1].text, turn2Answer);
  } finally {
    delete process.env.RELAYFILE_MOUNT_ROOT;
    rmSync(mount, { recursive: true, force: true });
  }
});

test('handleSlackMessage loads threads from the mount and focuses the right one', async () => {
  const mount = seedMount();
  process.env.RELAYFILE_MOUNT_ROOT = mount;
  try {
    const ctx = makeCtx();
    let seenPrompt = '';
    await handleSlackMessage(
      ctx,
      slackEvent({ ts: '1', text: 'recap the Alice export thread' }),
      { complete: async (p) => { seenPrompt = p; return 'ok'; }, slack: makeSlack() }
    );
    const ctxLog = ctx.logs.find((l) => l.message.startsWith('inbox-buddy.context'));
    assert.ok(ctxLog, 'expected a context log');
    assert.equal(ctxLog.data.threadsLoaded, 4);
    assert.equal(ctxLog.data.focusedThreads[0], 'T_alice_export');
    assert.match(seenPrompt, /Threads in focus/);
  } finally {
    delete process.env.RELAYFILE_MOUNT_ROOT;
    rmSync(mount, { recursive: true, force: true });
  }
});

test('handleSlackMessage ignores bot messages (no model call, no reply) — loop guard', async () => {
  const ctx = makeCtx();
  const slack = makeSlack();
  let completeCalls = 0;
  await handleSlackMessage(
    ctx,
    slackEvent({ ts: '1', text: 'a bot reply', isBot: true }),
    { complete: async () => { completeCalls++; return 'x'; }, slack }
  );
  assert.equal(completeCalls, 0);
  assert.equal(slack.calls.length, 0);
  assert.ok(ctx.logs.some((l) => l.message.startsWith('inbox-buddy.skip') && l.message.includes('reason=bot-message')));
});

test('handleSlackMessage replies in-thread when the message is threaded', async () => {
  const mount = seedMount();
  process.env.RELAYFILE_MOUNT_ROOT = mount;
  try {
    const ctx = makeCtx();
    const slack = makeSlack();
    await handleSlackMessage(
      ctx,
      slackEvent({ ts: '5', threadTs: '4', text: 'anything from Bob?' }),
      { complete: async () => 'Bob wants lunch Thursday.', slack }
    );
    assert.equal(slack.calls.length, 1);
    assert.equal(slack.calls[0].kind, 'reply');
    assert.equal(slack.calls[0].threadTs, '4');
  } finally {
    delete process.env.RELAYFILE_MOUNT_ROOT;
    rmSync(mount, { recursive: true, force: true });
  }
});

test('loadRecentThreads ignores _index.json and non-thread files', async () => {
  const mount = seedMount();
  try {
    const threads = await loadRecentThreads({ relayfileMountRoot: mount });
    assert.equal(threads.length, 4);
    assert.ok(threads.every((t) => isThreadRecord(t)));
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

// ── persona config invariant (§1 scope trap) ──────────────────────────────────

test('compiled persona scopes the REAL gmail mount (/google-mail, not legacy /gmail) + slack', async () => {
  const persona = JSON.parse(readFileSync(path.join(HERE, '..', 'inbox-buddy', 'persona.json'), 'utf8'));
  const parsed = parseIntegrations(persona.integrations ?? {}, 'inbox-buddy.integrations') ?? {};

  const gmailScope = parsed['google-mail']?.scope;
  assert.ok(gmailScope && Object.keys(gmailScope).length > 0, 'google-mail must carry a non-empty scope');
  assert.equal(gmailScope.paths, '/google-mail/**');
  assert.notEqual(gmailScope.paths, '/gmail/**');

  // Slack is the human chat channel and is WRITTEN to → needs a non-empty scope
  // (a trigger only mirrors the display-labelled read path, not the writeback path).
  const slackScope = parsed.slack?.scope;
  assert.ok(slackScope && Object.keys(slackScope).length > 0, 'slack must carry a non-empty scope');
});
