import assert from 'node:assert/strict';
import test from 'node:test';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import { handleQaMessage, postFreshStories, retryPendingThreadBody } from '../.test-build/hn-monitor/agent.js';

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

const STORY = { id: 20, title: 'Agent Workforce cron leases', url: 'https://example.com/20', points: 42 };

// ── posting tests ─────────────────────────────────────────────────────────

test('postFreshStories claims fresh ids before summarizing, then threads the digest under a header', async () => {
  const { ctx, events, saved } = fakeCtx();
  const posts = [];
  const delivery = fakeDelivery(posts);

  await postFreshStories(ctx, delivery, [10], [STORY]);

  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(saved[0], {
    content: JSON.stringify([10, 20]),
    opts: { tags: ['hn-monitor:seen'], scope: 'workspace' },
  });
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /Hacker News/);
  assert.match(posts[1].text, /digest body/);
  assert.equal(posts[1].replyTo, 'ref-1');

  assert.deepEqual(saved[1].opts, { tags: ['hn-monitor:post'], scope: 'workspace' });
  const record = JSON.parse(saved[1].content);
  assert.match(record.digest, /digest body/);
  assert.ok(typeof record.postedAt === 'string' && !Number.isNaN(Date.parse(record.postedAt)));
  assert.deepEqual(record.stories, [{ title: STORY.title, url: STORY.url, points: STORY.points }]);
});

test('postFreshStories falls back to plain digest when LLM throws', async () => {
  const { ctx, events, saved } = fakeCtx({
    llm: { async complete() { events.push('llm'); throw new Error('llm exploded'); } },
  });
  const posts = [];
  const delivery = fakeDelivery(posts);

  await postFreshStories(ctx, delivery, [10], [STORY]);

  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.equal(saved[0].content, JSON.stringify([10, 20]));
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /Hacker News/);
  assert.match(posts[1].text, /Agent Workforce cron leases/);
  assert.match(posts[1].text, /example\.com\/20/);
  assert.equal(posts[1].replyTo, 'ref-1');

  const record = JSON.parse(saved[1].content);
  assert.match(record.digest, /Agent Workforce cron leases/);
  assert.deepEqual(record.stories, [{ title: STORY.title, url: STORY.url, points: STORY.points }]);
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
  assert.deepEqual(saved.map((s) => s.content), [
    JSON.stringify([10, 20]),
    JSON.stringify([10]),
  ]);
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
  assert.equal(seenSave?.content, JSON.stringify([10, 20]));

  const pendingSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:pending-thread-body'));
  assert.ok(pendingSave, 'pending thread body should be saved on partial failure');
  const pending = JSON.parse(pendingSave.content);
  assert.equal(pending.header, ':newspaper: *Hacker News* — 1 new match(es)');
  assert.equal(pending.body, 'digest body');
  assert.equal(pending.targets, 'slack,telegram');
  assert.deepEqual(pending.headerRefs, [
    { provider: 'slack', channel: 'C123', draftRef: 'ref-slack' },
    { provider: 'telegram', chatId: '456', draftRef: 'msg-1' }
  ]);
  assert.deepEqual(pending.stories, [{ title: STORY.title, url: STORY.url, points: STORY.points }]);

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
  const clearCall = saved.find((s) => s.content === 'null' && s.opts?.tags?.includes('hn-monitor:pending-thread-body'));
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
  const clearCall = saved.find((s) => s.content === 'null' && s.opts?.tags?.includes('hn-monitor:pending-thread-body'));
  assert.ok(clearCall, 'orphaned pending body should be cleared when targets change');
});
