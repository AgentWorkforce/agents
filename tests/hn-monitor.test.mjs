import assert from 'node:assert/strict';
import test from 'node:test';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import { postFreshStories } from '../.test-build/hn-monitor/agent.js';

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

// ── tests ────────────────────────────────────────────────────────────────

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
      return { ok: false, refs: [] };
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

test('postFreshStories saves pending state when header publishes but body fails', async () => {
  const { ctx, saved } = fakeCtx();
  let callCount = 0;
  const delivery = {
    targets: ['slack'],
    async publish() {
      callCount++;
      return { ok: true, refs: [{ provider: 'slack', channel: 'C123', ts: '', draftRef: 'ref-1' }] };
    },
    async send(text, opts) {
      callCount++;
      // Body send — simulate partial failure
      return { ok: false, refs: [] };
    },
  };

  // When the header publishes but the threaded body fails, postFreshStories
  // saves pending state and returns gracefully (does NOT throw).
  await postFreshStories(ctx, delivery, [10], [STORY]);

  // Claim was kept (header already posted — no rollback).
  const seenSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:seen'));
  assert.equal(seenSave?.content, JSON.stringify([10, 20]));

  // Pending thread body was saved for recovery on next tick.
  const pendingSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:pending-thread-body'));
  assert.ok(pendingSave, 'pending thread body should be saved on partial failure');
  const pending = JSON.parse(pendingSave.content);
  assert.equal(pending.header, ':newspaper: *Hacker News* — 1 new match(es)');
  assert.equal(pending.body, 'digest body');
  assert.deepEqual(pending.stories, [{ title: STORY.title, url: STORY.url, points: STORY.points }]);

  // Post record was NOT saved (body never landed).
  const postSave = saved.find((s) => s.opts?.tags?.includes('hn-monitor:post'));
  assert.equal(postSave, undefined);
});
