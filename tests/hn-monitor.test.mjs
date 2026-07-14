import assert from 'node:assert/strict';
import test from 'node:test';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import {
  fetchHackerNewsFeeds,
  handleQaMessage,
  postFreshStories,
  renderDigest,
  retryPendingThreadBody,
  selectQuestionStories,
  selectRelevantStories,
} from '../.test-build/hn-monitor/agent.js';

// ── helpers ──────────────────────────────────────────────────────────────

function fakeCtx({ llm } = {}) {
  const events = [];
  const saved = [];
  return {
    ctx: {
      log() {},
      persona: {
        inputs: { SLACK_CHANNEL: 'C123' },
        inputSpecs: {
          SLACK_CHANNEL: { env: 'SLACK_CHANNEL', description: '', optional: true },
          TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', description: '', optional: true },
          TOPICS: { env: 'TOPICS', description: '', default: 'agents,ai' },
        },
      },
      memory: {
        async save(content, opts) {
          events.push('save');
          saved.push({ content, opts });
        },
        async recall() {
          return [];
        },
      },
      llm: llm ?? {
        async complete() {
          events.push('llm');
          return 'digest body';
        },
      },
    },
    events,
    saved,
  };
}

function fakeDelivery(posts) {
  return {
    targets: ['slack'],
    async publish(text) {
      return this.send(text, { nonBlocking: true });
    },
    async send(text, opts) {
      const ref = {
        provider: 'slack',
        channel: 'C123',
        ts: opts?.nonBlocking ? '' : `1710000000.${posts.length + 1}`,
        draftRef: `ref-${posts.length + 1}`,
      };
      if (opts?.replyTo) {
        posts.push({ text, replyTo: opts.replyTo.refs[0].draftRef, nonBlocking: opts.nonBlocking });
      } else {
        posts.push({ text, nonBlocking: opts?.nonBlocking });
      }
      return { ok: true, refs: [ref] };
    },
  };
}

function savedSeenIds(entry) {
  return JSON.parse(entry.content).ids;
}

function isClearedPending(entry) {
  if (!entry?.opts?.tags?.includes('hn-monitor:pending-thread-body')) return false;
  try {
    return JSON.parse(entry.content).cleared === true;
  } catch {
    return false;
  }
}

const STORY = { id: 20, title: 'Agent Workforce cron leases', url: 'https://example.com/20', points: 42 };

// ── feed discovery + relevance tests ───────────────────────────────────────

test('fetchHackerNewsFeeds scans Front Page, Show HN, and New HN and merges feed provenance', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    const hits = value.includes('front_page')
      ? [{ objectID: '101', title: 'Agent orchestration reaches the front page', url: 'https://example.com/agent', points: 90, num_comments: 30 }]
      : value.includes('show_hn')
        ? [{ objectID: '102', title: 'Show HN: Memory for coding agents', url: 'https://example.com/memory', points: 12, num_comments: 4 }]
        : [
            { objectID: '101', title: 'Agent orchestration reaches the front page', url: 'https://example.com/agent', points: 91, num_comments: 31 },
            { objectID: '103', title: 'A completely unrelated gardening post', url: 'https://example.com/garden', points: 1, num_comments: 0 },
          ];
    return new Response(JSON.stringify({ hits }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const stories = await fetchHackerNewsFeeds(24);
    assert.equal(urls.length, 3);
    assert.ok(urls.some((url) => url.includes('front_page')));
    assert.ok(urls.some((url) => url.includes('show_hn')));
    assert.ok(urls.some((url) => url.includes('tags=story')));
    assert.equal(stories.length, 3);
    const merged = stories.find((story) => story.id === 101);
    assert.deepEqual(merged.feeds.sort(), ['front_page', 'new']);
    assert.equal(merged.points, 91);
    assert.equal(merged.comments, 31);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selectRelevantStories favors repo-aligned agentic signals and rejects broad keyword noise', () => {
  const stories = [
    { id: 1, title: 'Show HN: Durable memory for long-running coding agents', url: 'https://ex.com/1', points: 20, comments: 5, feeds: ['show_hn', 'new'] },
    { id: 2, title: 'A protocol for multi-agent coordination and handoffs', url: 'https://ex.com/2', points: 8, comments: 2, feeds: ['new'] },
    { id: 3, title: 'Claude Code adds background subagents', url: 'https://ex.com/3', points: 100, comments: 40, feeds: ['front_page'] },
    { id: 4, title: 'TypeScript 6.0 beta is available', url: 'https://ex.com/4', points: 300, comments: 90, feeds: ['front_page'] },
    { id: 5, title: 'Ask HN: Recommendations for travel agents?', url: 'https://ex.com/5', points: 400, comments: 200, feeds: ['front_page'] },
    { id: 6, title: 'A generic AI image generator', url: 'https://ex.com/6', points: 500, comments: 300, feeds: ['front_page'] },
  ];

  const selected = selectRelevantStories(stories, ['agents', 'ai', 'typescript', 'developer tools'], 8);
  assert.deepEqual(selected.map((story) => story.id).sort(), [1, 2, 3]);
  assert.ok(selected.every((story) => story.relevanceScore >= 4));
  assert.ok(selected.some((story) => story.category === 'Agent coordination'));
  assert.ok(selected.some((story) => story.category === 'Coding agents'));
});

test('renderDigest produces a compact channel header and richly formatted story details', () => {
  const story = {
    id: 88,
    title: 'Show HN: Relay for coding agents',
    url: 'https://example.com/relay',
    hnUrl: 'https://news.ycombinator.com/item?id=88',
    points: 72,
    comments: 19,
    domain: 'example.com',
    category: 'Agent coordination',
    feeds: ['front_page', 'show_hn', 'new'],
  };
  const digest = renderDigest([story], {
    theme: 'Agent communication is becoming a first-class infrastructure layer.',
    whyById: new Map([[88, 'Directly relevant to reliable handoffs and shared context between coding agents.']]),
  });

  assert.match(digest.header, /HN agentic radar — 1 fresh signal/);
  assert.match(digest.header, /1 Front Page · 1 Show HN · 1 New/);
  assert.match(digest.body, /What stands out/);
  assert.match(digest.body, /<https:\/\/example\.com\/relay\|Show HN: Relay for coding agents>/);
  assert.match(digest.body, /72 points/);
  assert.match(digest.body, /19 comments/);
  assert.match(digest.body, /HN discussion/);
  assert.match(digest.body, /@mention me/);
  assert.equal(digest.stories[0].rank, 1);
  assert.match(digest.stories[0].why, /reliable handoffs/);
});

test('selectQuestionStories resolves story numbers, HN ids, and title fragments from recent findings', () => {
  const stories = [
    { id: 501, rank: 1, title: 'Memory for coding agents', url: 'https://ex.com/501', points: 10, why: 'memory' },
    { id: 502, rank: 2, title: 'Multi-agent handoff protocol', url: 'https://ex.com/502', points: 9, why: 'handoffs' },
  ];
  const posts = [{ postedAt: '2026-07-14T10:00:00Z', digest: 'digest', stories }];
  assert.equal(selectQuestionStories('tell me more about story 2', posts)[0].id, 502);
  assert.equal(selectQuestionStories('what are people saying about the memory one?', posts)[0].id, 501);
  assert.equal(selectQuestionStories('details on https://news.ycombinator.com/item?id=502', posts)[0].id, 502);
});

// ── posting tests ─────────────────────────────────────────────────────────

test('postFreshStories claims fresh ids before summarizing, then threads the digest under a header', async () => {
  const { ctx, events, saved } = fakeCtx();
  const posts = [];
  const delivery = fakeDelivery(posts);

  await postFreshStories(ctx, delivery, [10], [STORY]);

  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(savedSeenIds(saved[0]), [10, 20]);
  assert.deepEqual(saved[0].opts, { tags: ['hn-monitor:seen'], scope: 'workspace' });
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /HN agentic radar/);
  assert.match(posts[1].text, /What stands out/);
  assert.match(posts[1].text, /Agent Workforce cron leases/);
  assert.match(posts[1].text, /HN discussion/);
  assert.equal(posts[1].replyTo, 'ref-1');

  assert.deepEqual(saved[1].opts, { tags: ['hn-monitor:post'], scope: 'workspace' });
  const record = JSON.parse(saved[1].content);
  assert.match(record.digest, /HN agentic radar/);
  assert.ok(typeof record.postedAt === 'string' && !Number.isNaN(Date.parse(record.postedAt)));
  assert.equal(record.stories[0].id, STORY.id);
  assert.equal(record.stories[0].title, STORY.title);
  assert.equal(record.stories[0].rank, 1);
  assert.match(record.stories[0].why, /agent ecosystem/i);
});

test('postFreshStories falls back to plain digest when LLM throws', async () => {
  const { ctx, events, saved } = fakeCtx({
    llm: { async complete() { events.push('llm'); throw new Error('llm exploded'); } },
  });
  const posts = [];
  const delivery = fakeDelivery(posts);

  await postFreshStories(ctx, delivery, [10], [STORY]);

  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(savedSeenIds(saved[0]), [10, 20]);
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /HN agentic radar/);
  assert.match(posts[1].text, /Agent Workforce cron leases/);
  assert.match(posts[1].text, /example\.com\/20/);
  assert.equal(posts[1].replyTo, 'ref-1');

  const record = JSON.parse(saved[1].content);
  assert.match(record.digest, /Agent Workforce cron leases/);
  assert.equal(record.stories[0].id, STORY.id);
  assert.equal(record.stories[0].rank, 1);
});

test('postFreshStories releases claim when header publish fails', async () => {
  const { ctx, events, saved } = fakeCtx();
  const delivery = {
    targets: ['slack'],
    async publish() {
      return { ok: true, refs: [] };
    },
    async send() {
      return { ok: false, refs: [] };
    },
  };

  await assert.rejects(
    () => postFreshStories(ctx, delivery, [10], [STORY]),
    /Header publish failed/,
  );

  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(saved.map(savedSeenIds), [[10, 20], [10]]);
});

test('postFreshStories saves pending state with headerRefs when header publishes but body fails', async () => {
  const { ctx, saved } = fakeCtx();
  const delivery = {
    targets: ['slack', 'telegram'],
    async publish() {
      return {
        ok: true,
        refs: [
          { provider: 'slack', channel: 'C123', ts: '', draftRef: 'ref-slack' },
          { provider: 'telegram', chatId: '456', messageId: 'msg-1' }
        ]
      };
    },
    async send() {
      return { ok: true, refs: [] };  // fewer refs than targets = partial failure
    },
  };

  await postFreshStories(ctx, delivery, [10], [STORY]);

  const seenSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:seen'));
  assert.deepEqual(savedSeenIds(seenSave), [10, 20]);

  const pendingSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:pending-thread-body'));
  assert.ok(pendingSave, 'pending thread body should be saved on partial failure');
  const pending = JSON.parse(pendingSave.content);
  assert.match(pending.header, /HN agentic radar/);
  assert.match(pending.body, /Agent Workforce cron leases/);
  assert.equal(pending.targets, 'slack,telegram');
  assert.deepEqual(pending.headerRefs, [
    { provider: 'slack', channel: 'C123', draftRef: 'ref-slack' },
    { provider: 'telegram', chatId: '456', draftRef: 'msg-1' }
  ]);
  assert.equal(pending.stories[0].id, STORY.id);
  assert.equal(pending.stories[0].rank, 1);

  const postSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:post'));
  assert.equal(postSave, undefined);
});

// ── Q&A tests ────────────────────────────────────────────────────────────

test('handleQaMessage recalls posted digests and answers via relay inbox', async () => {
  const recallCalls = [];
  let llmPrompt = '';
  const published = [];
  const ctx = {
    log() {},
    persona: {
      inputs: { SLACK_CHANNEL: 'C123' },
      inputSpecs: {
        SLACK_CHANNEL: { env: 'SLACK_CHANNEL', description: '', optional: true },
        TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', description: '', optional: true },
      }
    },
    memory: {
      async recall(query, opts) {
        recallCalls.push({ query, opts });
        return [{
          content: JSON.stringify({
            postedAt: '2026-06-17T09:00:00.000Z',
            digest: ':newspaper: *Hacker News* — typescript 5.6 released',
            stories: [{ title: 'TypeScript 5.6', url: 'https://ex.com/ts', points: 200 }],
          }),
          createdAt: '2026-06-17T09:00:00.000Z',
          id: 'p1',
        }];
      },
      async save() {},
    },
    llm: {
      async complete(prompt) {
        llmPrompt = prompt;
        return 'TypeScript 5.6 was posted yesterday.';
      },
    },
  };

  const event = envelopeToAgentEvent({
    id: 'evt-hn-inbox',
    workspace: 'ws-test',
    type: 'relaycast.message',
    occurredAt: '2026-06-18T12:00:00.000Z',
    resource: { text: 'what typescript news did you post?' },
  });

  // Inject a mock delivery so the test doesn't hit real writeback.
  const mockDelivery = {
    targets: ['slack'],
    async publish(text) { published.push(text); return { ok: true, refs: [] }; },
    async send(text, opts) { published.push(text); return { ok: true, refs: [] }; },
  };

  await handleQaMessage(ctx, event, 'relay', { delivery: mockDelivery });

  assert.equal(recallCalls.length, 1);
  assert.deepEqual(recallCalls[0].opts.tags, ['hn-monitor:post']);
  assert.equal(recallCalls[0].opts.limit, 60);
  assert.match(llmPrompt, /typescript 5\.6 released/);
  assert.match(llmPrompt, /what typescript news did you post\?/);
  assert.equal(published.length, 1);
  assert.match(published[0], /TypeScript 5\.6 was posted yesterday\./);
});

test('handleQaMessage replies over the relay to the sender when resolvable (A2A round-trip)', async () => {
  const dms = [];
  const published = [];
  const ctx = {
    log() {},
    persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} },
    memory: {
      async recall() {
        return [{ content: JSON.stringify({ postedAt: '2026-06-17T09:00:00.000Z', digest: 'd', stories: [] }), createdAt: '2026-06-17T09:00:00.000Z', id: 'p1' }];
      },
      async save() {},
    },
    llm: { async complete() { return 'Here is your answer.'; } },
    relay: {
      async dm(to, text) { dms.push({ to, text }); return { ok: true, messageId: 'm1' }; },
      async post() { return { ok: true }; },
    },
  };
  const event = envelopeToAgentEvent({
    id: 'evt-hn-sender',
    workspace: 'ws-test',
    type: 'relaycast.message',
    occurredAt: '2026-06-18T12:00:00.000Z',
    resource: { text: 'recap the typescript news' },
    summary: { actor: { id: 'local-tester' } },
  });
  const mockDelivery = {
    targets: ['slack'],
    async publish(t) { published.push(t); return { ok: true, refs: [] }; },
    async send(t) { published.push(t); return { ok: true, refs: [] }; },
  };

  await handleQaMessage(ctx, event, 'relay', { delivery: mockDelivery });

  // Replied over the relay to the inbound sender; did NOT fall back to Slack.
  assert.equal(dms.length, 1);
  assert.equal(dms[0].to, 'local-tester');
  assert.match(dms[0].text, /Here is your answer\./);
  assert.equal(published.length, 0);
});

test('handleQaMessage answers a Slack mention in-thread with live HN details and comments', async () => {
  let prompt = '';
  const replies = [];
  const ctx = {
    log() {},
    persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} },
    memory: {
      async recall() {
        return [{
          id: 'post-1',
          createdAt: '2026-07-14T10:00:00.000Z',
          content: JSON.stringify({
            postedAt: '2026-07-14T10:00:00.000Z',
            digest: ':satellite_antenna: HN agentic radar\n1. Memory for coding agents',
            stories: [{
              id: 777,
              rank: 1,
              title: 'Memory for coding agents',
              url: 'https://example.com/memory',
              hnUrl: 'https://news.ycombinator.com/item?id=777',
              points: 80,
              comments: 22,
              why: 'Durable context is a core agent-runtime problem.',
            }],
          }),
        }];
      },
      async save() {},
    },
    llm: { async complete() { throw new Error('use injected completion'); } },
  };
  const event = envelopeToAgentEvent({
    id: 'evt-hn-slack',
    workspace: 'ws-test',
    type: 'slack.app_mention',
    occurredAt: '2026-07-14T12:00:00.000Z',
    resource: {
      channel: 'C123',
      ts: '1710000000.100',
      thread_ts: '1710000000.050',
      user: 'U1',
      text: '<@UBOT> tell me more about the memory story and what commenters think',
    },
  });

  await handleQaMessage(ctx, event, 'slack', {
    complete: async (value) => {
      prompt = value;
      return '*Why it matters:* it explores durable context. <https://example.com/memory|Article> · <https://news.ycombinator.com/item?id=777|HN discussion>';
    },
    fetchDetails: async (id) => ({
      id,
      title: 'Memory for coding agents',
      url: 'https://example.com/memory',
      hnUrl: 'https://news.ycombinator.com/item?id=777',
      points: 85,
      commentsCount: 24,
      author: 'builder',
      topComments: [{ author: 'hn-user', text: 'The hard part is deciding what context to forget.', points: 12 }],
    }),
    slackReply: async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); },
  });

  assert.match(prompt, /The hard part is deciding what context to forget/);
  assert.match(prompt, /community reactions/);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].channel, 'C123');
  assert.equal(replies[0].threadTs, '1710000000.050');
  assert.match(replies[0].text, /HN discussion/);
});

test('handleQaMessage with no text logs and returns without answering', async () => {
  let recalled = false;
  let llmCalled = false;
  const ctx = {
    log() {},
    persona: {
      inputs: { SLACK_CHANNEL: 'C123' },
      inputSpecs: {
        SLACK_CHANNEL: { env: 'SLACK_CHANNEL', description: '', optional: true },
        TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', description: '', optional: true },
      }
    },
    memory: {
      async recall() { recalled = true; return []; },
      async save() {},
    },
    llm: {
      async complete() { llmCalled = true; return 'should not be called'; },
    },
  };

  const event = envelopeToAgentEvent({
    id: 'evt-hn-inbox',
    workspace: 'ws-test',
    type: 'relaycast.message',
    occurredAt: '2026-06-18T12:00:00.000Z',
    resource: { text: '   ' },
  });

  await handleQaMessage(ctx, event, 'relay');

  assert.equal(recalled, false);
  assert.equal(llmCalled, false);
});

// ── recovery tests ──────────────────────────────────────────────────────

test('retryPendingThreadBody retries threaded body using saved headerRefs', async () => {
  const saved = [];
  const ctx = {
    log() {},
    persona: {
      inputs: { SLACK_CHANNEL: 'C123' },
      inputSpecs: {
        SLACK_CHANNEL: { env: 'SLACK_CHANNEL', description: '', optional: true },
        TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', description: '', optional: true },
      }
    },
    memory: {
      async save(content, opts) {
        saved.push({ content, opts });
      },
      async recall(query, opts) {
        if (opts?.tags?.includes('hn-monitor:pending-thread-body')) {
          // Pre-saved pending body from a prior partial failure
          return [{
            id: 'p1',
            content: JSON.stringify({
              targets: 'slack',
              header: ':newspaper: *Hacker News* — 1 new match(es)',
              body: 'digest body',
              createdAt: '2026-06-17T09:00:00.000Z',
              stories: [{ title: 'Agent Workforce cron leases', url: 'https://example.com/20', points: 42 }],
              headerRefs: [
                { provider: 'slack', channel: 'C123', draftRef: 'ref-original' }
              ],
            }),
          }];
        }
        return [];
      },
    },
  };

  let sentText = null;
  let sentOpts = null;
  const delivery = {
    targets: ['slack'],
    async send(text, opts) {
      sentText = text;
      sentOpts = opts;
      return { ok: true, refs: [{ provider: 'slack', channel: 'C123', ts: '', draftRef: 'ref-retry' }] };
    },
    async publish() {
      return { ok: true, refs: [] };
    },
  };

  const result = await retryPendingThreadBody(ctx, delivery);

  assert.equal(result, true, 'retry should succeed');
  assert.equal(sentText, 'digest body');
  // Should be non-blocking with replyTo reconstructed from headerRefs
  assert.equal(sentOpts.nonBlocking, true);
  assert.ok(sentOpts.replyTo, 'replyTo should be reconstructed from headerRefs');
  assert.equal(sentOpts.replyTo.refs.length, 1);
  assert.equal(sentOpts.replyTo.refs[0].draftRef, 'ref-original');
  assert.equal(sentOpts.replyTo.refs[0].messageId, undefined, 'Slack ref has no messageId field');

  // Pending state should be cleared AND post saved
  const clearCall = saved.find(isClearedPending);
  assert.ok(clearCall, 'pending state should be cleared after successful retry');
  const postCall = saved.find((s) => s.opts?.tags?.includes('hn-monitor:post'));
  assert.ok(postCall, 'post should be saved after successful retry');
});

test('retryPendingThreadBody clears orphaned pending body when targets change', async () => {
  const saved = [];
  const ctx = {
    log() {},
    persona: {
      inputs: { SLACK_CHANNEL: 'C123' },
      inputSpecs: {
        SLACK_CHANNEL: { env: 'SLACK_CHANNEL', description: '', optional: true },
        TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', description: '', optional: true },
      }
    },
    memory: {
      async save(content, opts) { saved.push({ content, opts }); },
      async recall(query, opts) {
        if (opts?.tags?.includes('hn-monitor:pending-thread-body')) {
          return [{
            id: 'p1',
            content: JSON.stringify({
              targets: 'slack',  // saved when only slack was configured
              header: 'old header',
              body: 'old body',
              createdAt: '2026-06-17T09:00:00.000Z',
              stories: [],
              headerRefs: [],
            }),
          }];
        }
        return [];
      },
    },
  };

  const delivery = {
    targets: ['slack', 'telegram'],  // now both are configured — mismatch
    async send() { return { ok: false, refs: [] }; },
    async publish() { return { ok: true, refs: [] }; },
  };

  const result = await retryPendingThreadBody(ctx, delivery);

  assert.equal(result, false, 'retry should bail when targets mismatch');
  const clearCall = saved.find(isClearedPending);
  assert.ok(clearCall, 'orphaned pending body should be cleared when targets change');
});
