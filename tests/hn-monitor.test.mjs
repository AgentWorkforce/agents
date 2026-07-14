import assert from 'node:assert/strict';
import test from 'node:test';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import {
  fetchHackerNewsFeeds,
  findStoryByExactTitle,
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
  const logs = [];
  const files = new Map();
  return {
    ctx: {
      log(level, message, attrs) { logs.push({ level, message, attrs }); },
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
      files: {
        async read(path) {
          if (!files.has(path)) {
            const error = new Error(`ENOENT: ${path}`);
            error.code = 'ENOENT';
            throw error;
          }
          return files.get(path);
        },
        async write(path, contents) { files.set(path, contents); },
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
    logs,
    files,
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

test('postFreshStories persists exact digest state and warns when semantic memory returns no receipt', async () => {
  const { ctx, files, logs } = fakeCtx();
  const posts = [];
  const story = {
    id: 4242,
    title: 'European Parliament MCP Server – Political Intelligence for AI Agents',
    url: 'https://example.com/eu-parliament-mcp',
    hnUrl: 'https://news.ycombinator.com/item?id=4242',
    points: 51,
    comments: 17,
    category: 'Agent infrastructure',
    feeds: ['new'],
  };

  await postFreshStories(ctx, fakeDelivery(posts), [], [story]);

  const path = '/slack/channels/C123/hn-monitor/recent-digests.json';
  assert.ok(files.has(path), 'exact state should be written inside the mounted Slack subtree');
  const state = JSON.parse(files.get(path));
  assert.equal(state.kind, 'hn-monitor exact recent digests');
  assert.equal(state.version, 1);
  assert.equal(state.posts[0].stories[0].id, 4242);
  assert.equal(state.posts[0].stories[0].rank, 1);
  assert.equal(state.posts[0].threadRefs[0].channel, 'C123');
  assert.ok(state.posts[0].threadRefs[0].threadTs, 'delivered Slack timestamp should be retained for thread correlation');
  assert.ok(logs.some((entry) => entry.message === 'hn-monitor.post-state-saved'));
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.message === 'hn-monitor.post-memory-unavailable'));
  assert.equal(posts.length, 2, 'memory unavailability must not break Slack posting');
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

test('postFreshStories keeps its claim after a partial multi-target header to avoid duplicates', async () => {
  const { ctx, saved, logs } = fakeCtx();
  let sends = 0;
  const delivery = {
    targets: ['slack', 'telegram'],
    async send() {
      sends += 1;
      return { ok: true, refs: [{ provider: 'slack', channel: 'C123', ts: '1.1', draftRef: 'ref-slack' }] };
    },
    async publish() { throw new Error('not simulated'); },
  };

  await postFreshStories(ctx, delivery, [10], [STORY]);

  assert.equal(sends, 1, 'body must not be sent when one header target is missing');
  const seenSaves = saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:seen'));
  assert.deepEqual(seenSaves.map(savedSeenIds), [[10, 20]], 'partial header must not release the dedupe claim');
  assert.ok(logs.some((entry) => entry.message === 'hn-monitor.thread-incomplete'));
});

test('postFreshStories saves pending state with headerRefs when header publishes but body fails', async () => {
  const { ctx, saved } = fakeCtx();
  let sends = 0;
  const delivery = {
    targets: ['slack', 'telegram'],
    async send() {
      sends += 1;
      if (sends > 1) return { ok: true, refs: [] };  // fewer refs than targets = partial body failure
      return {
        ok: true,
        refs: [
          { provider: 'slack', channel: 'C123', ts: '1710000000.100', draftRef: 'ref-slack' },
          { provider: 'telegram', chatId: '456', messageId: 'msg-1' }
        ]
      };
    },
    async publish() { throw new Error('header should use receipt-backed send'); },
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
    { provider: 'slack', channel: 'C123', draftRef: 'ref-slack', threadTs: '1710000000.100' },
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

test('handleQaMessage uses exact persisted state when memory recall is empty, then hydrates the selected story', async () => {
  const { ctx, files, logs } = fakeCtx();
  const delivered = [];
  const story = {
    id: 4242,
    title: 'European Parliament MCP Server – Political Intelligence for AI Agents',
    url: 'https://example.com/eu-parliament-mcp',
    hnUrl: 'https://news.ycombinator.com/item?id=4242',
    points: 51,
    comments: 17,
    category: 'Agent infrastructure',
    feeds: ['new'],
  };
  await postFreshStories(ctx, fakeDelivery(delivered), [], [story]);
  assert.ok(files.size > 0);
  ctx.memory.recall = async () => { throw new Error('semantic memory unavailable'); };

  const event = envelopeToAgentEvent({
    id: 'evt-hn-slack-exact-state',
    workspace: 'ws-test',
    type: 'slack.app_mention',
    occurredAt: '2026-07-14T12:00:00.000Z',
    resource: {
      channel: 'C123',
      ts: '1710000000.200',
      thread_ts: '1710000000.050',
      user: 'U1',
      text: '<@UBOT> European Parliament MCP Server – Political Intelligence for AI Agents -> give me more info on this',
    },
  });
  let prompt = '';
  let lookupCalled = false;
  const replies = [];
  await handleQaMessage(ctx, event, 'slack', {
    complete: async (value) => {
      prompt = value;
      return '<https://example.com/eu-parliament-mcp|Article> · <https://news.ycombinator.com/item?id=4242|HN discussion>';
    },
    searchByTitle: async () => { lookupCalled = true; return null; },
    fetchDetails: async (id) => ({
      id,
      title: story.title,
      url: story.url,
      hnUrl: story.hnUrl,
      points: 55,
      commentsCount: 18,
      author: 'eubuilder',
      topComments: [{ author: 'hn-reader', text: 'The useful part is traceable parliamentary source data.', points: 8 }],
    }),
    slackReply: async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); },
  });

  assert.equal(lookupCalled, false, 'exact state should win before Algolia fallback');
  assert.match(prompt, /grounding source is exact_state/);
  assert.match(prompt, /traceable parliamentary source data/);
  assert.match(prompt, /community reactions/);
  assert.equal(replies[0].threadTs, '1710000000.050');
  const selectedLog = logs.findLast((entry) => entry.message === 'hn-monitor.qa.selected');
  assert.equal(selectedLog.attrs.source, 'exact_state');
  const hydratedLog = logs.findLast((entry) => entry.message === 'hn-monitor.qa.hydrated');
  assert.equal(hydratedLog.attrs.hydrated, 1);
});

test('handleQaMessage falls back from empty state and memory to strict Algolia title lookup and live comments', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.includes('/api/v1/search?')) {
      return new Response(JSON.stringify({
        hits: [
          {
            objectID: '4242',
            title: 'European Parliament MCP Server – Political Intelligence for AI Agents',
            url: 'https://example.com/eu-parliament-mcp',
            points: 51,
            num_comments: 17,
            author: 'eubuilder',
          },
          { objectID: '9998', title: 'European Parliament MCP Server', url: 'https://example.com/shorter', points: 600 },
          { objectID: '9999', title: 'An unrelated MCP tutorial', url: 'https://example.com/other', points: 500 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (value.includes('/api/v1/items/4242')) {
      return new Response(JSON.stringify({
        id: 4242,
        title: 'European Parliament MCP Server – Political Intelligence for AI Agents',
        url: 'https://example.com/eu-parliament-mcp',
        points: 55,
        author: 'eubuilder',
        children: [{ id: 5001, author: 'hn-reader', points: 8, text: 'The provenance model matters more than the chat interface.', children: [] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${value}`);
  };

  try {
    const { ctx, logs } = fakeCtx();
    const event = envelopeToAgentEvent({
      id: 'evt-hn-slack-algolia',
      workspace: 'ws-test',
      type: 'slack.app_mention',
      occurredAt: '2026-07-14T12:00:00.000Z',
      resource: {
        channel: 'C123',
        ts: '1710000000.300',
        thread_ts: '1710000000.050',
        user: 'U1',
        text: '<@UBOT> European Parliament MCP Server – Political Intelligence for AI Agents -> give me more info on this',
      },
    });
    let prompt = '';
    const replies = [];
    await handleQaMessage(ctx, event, 'slack', {
      complete: async (value) => {
        prompt = value;
        return 'I matched that title on HN. <https://example.com/eu-parliament-mcp|Article> · <https://news.ycombinator.com/item?id=4242|HN discussion>';
      },
      slackReply: async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); },
    });

    assert.ok(urls.some((url) => url.includes('restrictSearchableAttributes=title')));
    assert.ok(urls.some((url) => url.includes('/api/v1/items/4242')));
    assert.match(prompt, /grounding source is algolia/);
    assert.match(prompt, /live HN title lookup/);
    assert.match(prompt, /provenance model matters more/);
    assert.match(prompt, /https:\/\/example\.com\/eu-parliament-mcp/);
    assert.match(prompt, /https:\/\/news\.ycombinator\.com\/item\?id=4242/);
    assert.doesNotMatch(replies[0].text, /provide.*(?:id|link)/i);
    assert.equal(logs.findLast((entry) => entry.message === 'hn-monitor.qa.selected').attrs.source, 'algolia');
    assert.equal(logs.findLast((entry) => entry.message === 'hn-monitor.qa.hydrated').attrs.hydrated, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('findStoryByExactTitle rejects unrelated and ambiguous near-title matches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify({
    hits: String(url).includes('European')
      ? [
          { objectID: '11', title: 'European Parliament MCP Server – Political Intelligence for AI Agents', points: 20 },
          { objectID: '12', title: 'European Parliament MCP Server – Political Intelligence for AI Agents', points: 19 },
        ]
      : [
          { objectID: '1', title: 'Durable memory context system for long running coding agents', points: 20 },
          { objectID: '2', title: 'Durable memory context systems for long running coding agent', points: 19 },
        ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    assert.equal(await findStoryByExactTitle('weather dashboard'), null, 'short unrelated text should not even be searched');
    assert.equal(
      await findStoryByExactTitle('Durable memory context systems for long running coding agents'),
      null,
      'two equally plausible near matches must be treated as ambiguous',
    );
    assert.equal(
      await findStoryByExactTitle('European Parliament MCP Server – Political Intelligence for AI Agents'),
      null,
      'duplicate exact-title submissions must be treated as ambiguous',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('handleQaMessage preserves exact-title grounding and both links when answer generation fails', async () => {
  const { ctx } = fakeCtx({ llm: { async complete() { throw new Error('model unavailable'); } } });
  const event = envelopeToAgentEvent({
    id: 'evt-hn-slack-model-fallback',
    workspace: 'ws-test',
    type: 'slack.app_mention',
    occurredAt: '2026-07-14T12:00:00.000Z',
    resource: {
      channel: 'C123',
      ts: '1710000000.350',
      thread_ts: '1710000000.050',
      user: 'U1',
      text: '<@UBOT> European Parliament MCP Server – Political Intelligence for AI Agents -> give me more info on this',
    },
  });
  const story = {
    id: 4242,
    rank: 1,
    title: 'European Parliament MCP Server – Political Intelligence for AI Agents',
    url: 'https://example.com/eu-parliament-mcp',
    hnUrl: 'https://news.ycombinator.com/item?id=4242',
    points: 51,
    comments: 17,
  };
  const replies = [];

  await handleQaMessage(ctx, event, 'slack', {
    searchByTitle: async () => story,
    fetchDetails: async () => ({
      id: 4242,
      title: story.title,
      url: story.url,
      hnUrl: story.hnUrl,
      points: 55,
      commentsCount: 18,
      topComments: [],
    }),
    slackReply: async (_channel, _threadTs, text) => { replies.push(text); },
  });

  assert.match(replies[0], /European Parliament MCP Server/);
  assert.match(replies[0], /https:\/\/example\.com\/eu-parliament-mcp/);
  assert.match(replies[0], /https:\/\/news\.ycombinator\.com\/item\?id=4242/);
  assert.doesNotMatch(replies[0], /don't have any recent posts/i);
});

test('handleQaMessage does not let incomplete semantic memory resolve an exact-state ambiguity', async () => {
  const exactPosts = [{
    postedAt: '2026-07-14T10:00:00Z',
    digest: 'exact digest',
    stories: [
      { id: 4301, rank: 1, title: 'European Parliament agent intelligence', url: 'https://ex.com/4301', hnUrl: 'https://news.ycombinator.com/item?id=4301' },
      { id: 4302, rank: 2, title: 'European Parliament workflow analysis', url: 'https://ex.com/4302', hnUrl: 'https://news.ycombinator.com/item?id=4302' },
    ],
  }];
  const memoryPost = { ...exactPosts[0], stories: [exactPosts[0].stories[0]] };
  const logs = [];
  const ctx = {
    log(level, message, attrs) { logs.push({ level, message, attrs }); },
    persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} },
    memory: {
      async recall() { return [{ id: 'm1', createdAt: memoryPost.postedAt, content: JSON.stringify(memoryPost) }]; },
      async save() {},
    },
    llm: { async complete() { throw new Error('use injected completion'); } },
  };
  const event = envelopeToAgentEvent({
    id: 'evt-hn-ambiguous-memory', workspace: 'ws-test', type: 'slack.app_mention', occurredAt: '2026-07-14T12:00:00Z',
    resource: { channel: 'C123', ts: '5.2', thread_ts: '5.1', user: 'U1', text: '<@UBOT> tell me more about the European Parliament story' },
  });
  let hydrated = false;
  await handleQaMessage(ctx, event, 'slack', {
    loadExactPosts: async () => exactPosts,
    searchByTitle: async () => null,
    fetchDetails: async () => { hydrated = true; return null; },
    complete: async () => 'Please specify the exact story title.',
    slackReply: async () => {},
  });

  assert.equal(hydrated, false);
  assert.equal(logs.findLast((entry) => entry.message === 'hn-monitor.qa.selected').attrs.source, 'none');
});

test('handleQaMessage uses delivered Slack thread-parent context to disambiguate a generic follow-up', async () => {
  const stories = [
    { id: 501, rank: 1, title: 'Memory for coding agents', url: 'https://ex.com/501', hnUrl: 'https://news.ycombinator.com/item?id=501', points: 10, why: 'memory' },
    { id: 502, rank: 2, title: 'Multi-agent handoff protocol', url: 'https://ex.com/502', hnUrl: 'https://news.ycombinator.com/item?id=502', points: 9, why: 'handoffs' },
  ];
  const memoryPosts = [{ postedAt: '2026-07-14T10:00:00Z', digest: 'digest', stories }];
  const logs = [];
  const ctx = {
    log(level, message, attrs) { logs.push({ level, message, attrs }); },
    persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} },
    memory: {
      async recall() { return memoryPosts.map((post, index) => ({ id: `p${index}`, createdAt: post.postedAt, content: JSON.stringify(post) })); },
      async save() {},
    },
    llm: { async complete() { throw new Error('use injected completion'); } },
  };
  const event = envelopeToAgentEvent({
    id: 'evt-hn-slack-thread-parent',
    workspace: 'ws-test',
    type: 'slack.app_mention',
    occurredAt: '2026-07-14T12:00:00.000Z',
    resource: {
      channel: 'C123',
      ts: '2.2',
      thread_ts: '2.1',
      text: '<@UBOT> give me more info on this',
      user: 'U1',
      parent_message: { text: 'Digest parent: Multi-agent handoff protocol' },
    },
  });
  let prompt = '';
  await handleQaMessage(ctx, event, 'slack', {
    loadExactPosts: async () => [],
    searchByTitle: async () => null,
    fetchDetails: async (id) => ({ id, title: stories[1].title, url: stories[1].url, hnUrl: stories[1].hnUrl, points: 12, commentsCount: 3, topComments: [] }),
    complete: async (value) => { prompt = value; return 'Grounded thread answer.'; },
    slackReply: async () => {},
  });

  assert.match(prompt, /Digest parent: Multi-agent handoff protocol/);
  assert.match(prompt, /grounding source is thread_context/);
  assert.equal(logs.findLast((entry) => entry.message === 'hn-monitor.qa.thread-context').attrs.source, 'event');
  assert.equal(logs.findLast((entry) => entry.message === 'hn-monitor.qa.selected').attrs.selected[0].id, 502);
});

test('handleQaMessage resolves an ordinal against the referenced older digest, not the newest digest', async () => {
  const older = {
    postedAt: '2026-07-13T10:00:00Z',
    digest: 'older digest',
    stories: [{ id: 701, rank: 1, title: 'Older digest agent runtime', url: 'https://ex.com/701', hnUrl: 'https://news.ycombinator.com/item?id=701' }],
    threadRefs: [{ provider: 'slack', channel: 'C123', draftRef: '/slack/channels/C123/messages/draft-older.json', threadTs: '3.1' }],
  };
  const newer = {
    postedAt: '2026-07-14T10:00:00Z',
    digest: 'newer digest',
    stories: [{ id: 702, rank: 1, title: 'Newer digest coding agent', url: 'https://ex.com/702', hnUrl: 'https://news.ycombinator.com/item?id=702' }],
    threadRefs: [{ provider: 'slack', channel: 'C123', draftRef: '/slack/channels/C123/messages/draft-newer.json', threadTs: '9.1' }],
  };
  const ctx = {
    log() {},
    persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} },
    memory: { async recall() { return []; }, async save() {} },
    llm: { async complete() { throw new Error('use injected completion'); } },
  };
  const event = envelopeToAgentEvent({
    id: 'evt-hn-slack-old-ordinal', workspace: 'ws-test', type: 'slack.app_mention', occurredAt: '2026-07-14T12:00:00Z',
    resource: {
      channel: 'C123', ts: '3.2', thread_ts: '3.1', user: 'U1', text: '<@UBOT> tell me more about story 1',
    },
  });
  let selectedId;
  await handleQaMessage(ctx, event, 'slack', {
    loadExactPosts: async () => [newer, older],
    fetchDetails: async (id) => { selectedId = id; return { id, title: older.stories[0].title, url: older.stories[0].url, hnUrl: older.stories[0].hnUrl, points: 1, commentsCount: 0, topComments: [] }; },
    complete: async () => 'Grounded older digest answer.',
    slackReply: async () => {},
  });
  assert.equal(selectedId, 701);
});

test('handleQaMessage reads a thread parent through the mounted channel alias path', async () => {
  const { ctx, files, logs } = fakeCtx();
  files.set('/slack/channels/C123__agent-radar/messages/4_1/meta.json', JSON.stringify({ text: 'Digest parent: Multi-agent handoff protocol' }));
  const posts = [{
    postedAt: '2026-07-14T10:00:00Z',
    digest: 'digest',
    stories: [
      { id: 801, rank: 1, title: 'Memory for coding agents', url: 'https://ex.com/801', hnUrl: 'https://news.ycombinator.com/item?id=801' },
      { id: 802, rank: 2, title: 'Multi-agent handoff protocol', url: 'https://ex.com/802', hnUrl: 'https://news.ycombinator.com/item?id=802' },
    ],
  }];
  const event = envelopeToAgentEvent({
    id: 'evt-hn-slack-aliased-parent', workspace: 'ws-test', type: 'slack.app_mention', occurredAt: '2026-07-14T12:00:00Z',
    paths: ['/slack/channels/C123__agent-radar/messages/4_2/meta.json'],
    resource: { channel: 'C123', ts: '4.2', thread_ts: '4.1', user: 'U1', text: '<@UBOT> give me more info on this' },
  });
  let selectedId;
  await handleQaMessage(ctx, event, 'slack', {
    loadExactPosts: async () => posts,
    fetchDetails: async (id) => { selectedId = id; return { id, title: posts[0].stories[1].title, url: posts[0].stories[1].url, hnUrl: posts[0].stories[1].hnUrl, points: 1, commentsCount: 0, topComments: [] }; },
    complete: async () => 'Grounded aliased-parent answer.',
    slackReply: async () => {},
  });
  assert.equal(selectedId, 802);
  assert.equal(logs.findLast((entry) => entry.message === 'hn-monitor.qa.thread-context').attrs.source, 'relayfile');
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
