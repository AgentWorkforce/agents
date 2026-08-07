import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATCH_SWEEP_CRON,
  createWatch,
  handleRelayMessage,
  parseCommand,
  queryListen,
  renderListenAnswer,
  watchIsDue,
} from '../.test-build/askable-gtm/agent.js';
import { ASKABLE_GTM_CAPABILITY } from '../.test-build/askable-gtm/capabilities.js';
import { envelopeToAgentEvent } from '@agentworkforce/runtime';

test('machine-readable capability manifest is versioned and honest about live access', () => {
  assert.equal(ASKABLE_GTM_CAPABILITY.schema, 'agentrelay.askable.v1');
  assert.equal(ASKABLE_GTM_CAPABILITY.status, 'prototype-blocked');
  assert.equal(ASKABLE_GTM_CAPABILITY.credentials.personaInput, false);
  assert.equal(ASKABLE_GTM_CAPABILITY.provider.liveResultVerification, 'blocked-op-cli-unavailable');
  assert.equal(WATCH_SWEEP_CRON, '*/15 * * * *');
});

test('conversation commands cover self-description and durable watch management', () => {
  assert.deepEqual(parseCommand('capabilities --json'), { kind: 'capabilities-json' });
  assert.deepEqual(parseCommand('what can you tell me?'), { kind: 'capabilities-human' });
  assert.deepEqual(parseCommand('watches'), { kind: 'list-watches' });
  assert.deepEqual(parseCommand('unwatch watch-abc1234'), {
    kind: 'remove-watch',
    id: 'watch-abc1234',
  });
  assert.deepEqual(parseCommand('watch Acme migration pain every 6h'), {
    kind: 'create-watch',
    query: 'Acme migration pain',
    cadence: '6h',
  });
  assert.deepEqual(parseCommand('What are developers saying about Acme?'), {
    kind: 'question',
    query: 'What are developers saying about Acme?',
  });
});

test('watch definitions are stable per owner/query and evaluated at their requested cadence', () => {
  const created = new Date('2026-08-07T10:00:00.000Z');
  const watch = createWatch('  Acme   migration pain ', '6h', 'requester', created);
  const duplicate = createWatch('Acme migration pain', '1h', 'requester', created);
  assert.equal(watch.id, duplicate.id);
  assert.equal(watch.query, 'Acme migration pain');
  assert.equal(watchIsDue(watch, created), true);

  watch.lastRunAt = created.toISOString();
  assert.equal(watchIsDue(watch, new Date('2026-08-07T15:59:59.999Z')), false);
  assert.equal(watchIsDue(watch, new Date('2026-08-07T16:00:00.000Z')), true);
});

test('relay watch utterance persists durable state and returns the scheduling truth', async () => {
  const saved = [];
  const sent = [];
  const event = envelopeToAgentEvent({
    id: 'evt-watch',
    workspace: 'workspace-test',
    type: 'relaycast.message',
    occurredAt: '2026-08-07T10:00:00Z',
    summary: { actor: { id: 'requester' } },
    resource: { text: 'watch Acme migration pain every 6h' },
  });
  assert.ok(event);

  const ctx = {
    log() {},
    memory: {
      async recall() { return []; },
      async save(content, opts) { saved.push({ content, opts }); },
    },
    relay: {
      async dm(to, text) { sent.push({ to, text }); return { ok: true, messageId: 'message-test' }; },
    },
  };

  await handleRelayMessage(ctx, event);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].opts.tags, ['askable-gtm:watch-state']);
  const state = JSON.parse(saved[0].content);
  assert.equal(state.watches.length, 1);
  assert.equal(state.watches[0].query, 'Acme migration pain');
  assert.equal(state.watches[0].cadence, '6h');
  assert.equal(state.watches[0].owner, 'requester');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'requester');
  assert.match(sent[0].text, /shared 15-minute recurring sweep/);
  assert.match(sent[0].text, /did not create a per-watch Relaycron schedule/);
  assert.match(sent[0].text, /Live execution is currently blocked/);
});

test('Listen client sends one bounded Reddit request and never serializes the key', async () => {
  const calls = [];
  const response = await queryListen('developer tool migration pain', 'test-only-key', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      meta: { query: 'developer tool migration pain', fetched_at: '2026-08-07T12:00:00Z' },
      results: [],
      source_status: { reddit: { status: 'ok', count: 0 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.revternal.com/social/listen');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-api-key'], 'test-only-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.sources[0].platform, 'reddit');
  assert.equal(body.page, 1);
  assert.equal(body.per_page, 20);
  assert.doesNotMatch(calls[0].init.body, /test-only-key/);
  assert.equal(response.source_status.reddit.status, 'ok');
});

test('answers expose freshness, coverage, engagement, and source URL', () => {
  const answer = renderListenAnswer('Acme migration pain', {
    meta: { fetched_at: '2026-08-07T12:00:00Z' },
    source_status: { reddit: { status: 'ok', count: 1 } },
  }, [{
    source_id: 'p1',
    platform: 'reddit',
    title: 'Migration took longer than expected',
    url: 'https://example.invalid/post',
    score_count: 42,
    comment_count: 9,
    community: { name: 'example-community' },
  }]);

  assert.match(answer, /Fetched: 2026-08-07T12:00:00Z/);
  assert.match(answer, /reddit:ok \(1\)/);
  assert.match(answer, /score 42 · comments 9/);
  assert.match(answer, /https:\/\/example\.invalid\/post/);
  assert.match(answer, /themes or intent require separate inference/);
});

test('Listen errors expose status only and do not include response bodies', async () => {
  await assert.rejects(
    queryListen('query', 'test-only-key', async () => new Response('sensitive upstream detail', { status: 401 })),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /sensitive upstream detail/);
      return true;
    },
  );
});
