import assert from 'node:assert/strict';
import test from 'node:test';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import { handleInboxMessage, postFreshStories } from '../.test-build/hn-monitor/agent.js';

function makeCtx({ llm } = {}) {
  const events = [];
  const saved = [];
  const ctx = {
    log() {},
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

function inboxEvent(text) {
  return envelopeToAgentEvent({
    id: 'evt-hn-inbox',
    workspace: 'ws-test',
    type: 'relaycast.message',
    occurredAt: '2026-06-18T12:00:00.000Z',
    resource: { text },
  });
}

const STORY = { id: 20, title: 'Agent Workforce cron leases', url: 'https://example.com/20', points: 42 };

test('postFreshStories claims fresh ids before summarizing, then threads the digest under a header on success', async () => {
  const { ctx, events, saved } = makeCtx();
  const posts = [];
  const client = {
    async post(channel, text, opts) {
      posts.push({ channel, text, opts });
      return { ts: `1710000000.${posts.length}`, ref: `ref-${posts.length}` };
    },
  };

  await postFreshStories(ctx, 'C123', [10], [STORY], client);

  // Claim happens before the LLM summary; on success we also persist the post.
  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(saved[0], {
    content: JSON.stringify([10, 20]),
    opts: { tags: ['hn-monitor:seen'], scope: 'workspace' },
  });
  // Two posts: a compact count header (top-level) then the digest body threaded
  // under it via `replyTo: <header ref>` (server-side threading).
  assert.equal(posts.length, 2);
  assert.equal(posts[0].channel, 'C123');
  assert.match(posts[0].text, /Hacker News/);
  assert.equal(posts[0].opts, undefined);
  assert.match(posts[1].text, /digest body/);
  assert.deepEqual(posts[1].opts, { replyTo: 'ref-1' });

  // A successful post writes an `hn-monitor:post` record for the Q&A path.
  assert.deepEqual(saved[1].opts, { tags: ['hn-monitor:post'], scope: 'workspace' });
  const record = JSON.parse(saved[1].content);
  assert.match(record.digest, /digest body/);
  assert.ok(typeof record.postedAt === 'string' && !Number.isNaN(Date.parse(record.postedAt)));
  assert.deepEqual(record.stories, [{ title: STORY.title, url: STORY.url, points: STORY.points }]);
});

test('postFreshStories posts a plain fallback digest when the LLM throws, and still saves the post record', async () => {
  const { ctx, events, saved } = makeCtx({
    llm: { async complete() { events.push('llm'); throw new Error('llm exploded'); } },
  });
  const posts = [];
  const client = {
    async post(channel, text, opts) {
      posts.push({ channel, text, opts });
      return { ts: `1710000000.${posts.length}`, ref: `ref-${posts.length}` };
    },
  };

  // summarize() no longer throws on an LLM failure — it falls back to a plain
  // digest built from the story lines, so the post still lands and is retained.
  await postFreshStories(ctx, 'C123', [10], [STORY], client);

  assert.deepEqual(events, ['save', 'llm', 'save']);
  // The claim is kept (post succeeded), not rolled back.
  assert.equal(saved[0].content, JSON.stringify([10, 20]));
  // Header (top-level) + fallback digest threaded under it; the fallback body
  // carries the actual story title/url.
  assert.equal(posts.length, 2);
  assert.match(posts[0].text, /Hacker News/);
  assert.equal(posts[0].opts, undefined);
  assert.match(posts[1].text, /Agent Workforce cron leases/);
  assert.match(posts[1].text, /example\.com\/20/);
  assert.deepEqual(posts[1].opts, { replyTo: 'ref-1' });
  // The post record is still persisted for the Q&A path.
  assert.deepEqual(saved[1].opts, { tags: ['hn-monitor:post'], scope: 'workspace' });
  const record = JSON.parse(saved[1].content);
  assert.match(record.digest, /Agent Workforce cron leases/);
  assert.deepEqual(record.stories, [{ title: STORY.title, url: STORY.url, points: STORY.points }]);
});

test('postFreshStories treats a no-receipt Slack post as a failure and releases the claim', async () => {
  const { ctx, events, saved } = makeCtx();
  // Writeback timed out: post resolves with ts:'' (silent drop), not a throw.
  const client = { async post() { return { ts: '' }; } };

  await assert.rejects(() => postFreshStories(ctx, 'C123', [10], [STORY], client), /no writeback receipt/);

  // claim → llm ok → post drops → rollback so the digest isn't lost forever.
  // The post record is NOT written, since the post never landed.
  assert.deepEqual(events, ['save', 'llm', 'save']);
  assert.deepEqual(saved.map((s) => s.content), [
    JSON.stringify([10, 20]),
    JSON.stringify([10]),
  ]);
});

test('handleInboxMessage recalls posted digests and answers the question', async () => {
  const recallCalls = [];
  const posts = [];
  let recalledContext = '';
  const ctx = {
    log() {},
    memory: {
      async recall(query, opts) {
        recallCalls.push({ query, opts });
        return [
          {
            content: JSON.stringify({
              postedAt: '2026-06-17T09:00:00.000Z',
              digest: ':newspaper: *Hacker News* — typescript 5.6 released',
              stories: [{ title: 'TypeScript 5.6', url: 'https://ex.com/ts', points: 200 }],
            }),
            createdAt: '2026-06-17T09:00:00.000Z',
            id: 'p1',
          },
        ];
      },
      async save() {},
    },
    llm: {
      async complete(prompt) {
        recalledContext = prompt;
        return 'TypeScript 5.6 was posted yesterday.';
      },
    },
  };

  const client = { async post(channel, text) { posts.push({ channel, text }); return { ts: '99.1' }; } };
  // slackClient() is the default poster; inject via a global mock is overkill —
  // handleInboxMessage uses the module's slackClient, so exercise the real path
  // by overriding the relay mount. Instead, assert through the prompt + a stub.
  await handleInboxMessage(
    { ...ctx, persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} } },
    inboxEvent('what typescript news did you post?'),
    client,
  );

  // Recalls the `hn-monitor:post` tag with a generous limit.
  assert.equal(recallCalls.length, 1);
  assert.deepEqual(recallCalls[0].opts.tags, ['hn-monitor:post']);
  assert.equal(recallCalls[0].opts.limit, 60);
  // The recalled digest is fed into the prompt and the question is included.
  assert.match(recalledContext, /typescript 5\.6 released/);
  assert.match(recalledContext, /what typescript news did you post\?/);
  // The answer is posted back to the channel.
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C123');
  assert.match(posts[0].text, /TypeScript 5\.6 was posted yesterday\./);
});

test('handleInboxMessage with no question text logs and returns without posting', async () => {
  let recalled = false;
  const posts = [];
  const ctx = {
    log() {},
    persona: { inputs: { SLACK_CHANNEL: 'C123' }, inputSpecs: {} },
    memory: { async recall() { recalled = true; return []; }, async save() {} },
    llm: { async complete() { return 'should not be called'; } },
  };
  const client = { async post(channel, text) { posts.push({ channel, text }); return { ts: '1' }; } };

  await handleInboxMessage(ctx, inboxEvent('   '), client);

  assert.equal(recalled, false);
  assert.equal(posts.length, 0);
});
