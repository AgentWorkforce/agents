import assert from 'node:assert/strict';
import test from 'node:test';

import { postFreshStories } from '../.test-build/hn-monitor/agent.js';

function makeCtx({ llm } = {}) {
  const events = [];
  const saved = [];
  const ctx = {
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
  };
  return { ctx, events, saved };
}

const STORY = { id: 20, title: 'Agent Workforce cron leases', url: 'https://example.com/20', points: 42 };

test('postFreshStories claims fresh ids before summarizing, then keeps them on a successful post', async () => {
  const { ctx, events, saved } = makeCtx();
  const posts = [];
  const client = { async post(channel, text) { posts.push({ channel, text }); return { ts: '1710000000.1' }; } };

  await postFreshStories(ctx, 'C123', [10], [STORY], client);

  // Claim happens before the LLM summary; no rollback on success.
  assert.deepEqual(events, ['save', 'llm']);
  assert.deepEqual(saved, [{
    content: JSON.stringify([10, 20]),
    opts: { tags: ['hn-monitor:seen'], scope: 'workspace' },
  }]);
  // summarize() wraps the LLM output in a header before posting.
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C123');
  assert.match(posts[0].text, /Hacker News/);
  assert.match(posts[0].text, /digest body/);
});

test('postFreshStories releases the claim when summarizing fails, so the next tick retries', async () => {
  const { ctx, events, saved } = makeCtx({
    llm: { async complete() { events.push('llm'); throw new Error('summary failed'); } },
  });
  const client = { async post() { throw new Error('should not post when summary fails'); } };

  await assert.rejects(() => postFreshStories(ctx, 'C123', [10], [STORY], client), /summary failed/);

  // claim ([10,20]) → llm throws → rollback to the prior seen set ([10]).
  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(saved.map((s) => s.content), [
    JSON.stringify([10, 20]),
    JSON.stringify([10]),
  ]);
});

test('postFreshStories treats a no-receipt Slack post as a failure and releases the claim', async () => {
  const { ctx, events, saved } = makeCtx();
  // Writeback timed out: post resolves with ts:'' (silent drop), not a throw.
  const client = { async post() { return { ts: '' }; } };

  await assert.rejects(() => postFreshStories(ctx, 'C123', [10], [STORY], client), /no writeback receipt/);

  // claim → llm ok → post drops → rollback so the digest isn't lost forever.
  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(saved.map((s) => s.content), [
    JSON.stringify([10, 20]),
    JSON.stringify([10]),
  ]);
});
