import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATCH_SWEEP_CRON,
  ListenGatewayError,
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
  assert.equal(ASKABLE_GTM_CAPABILITY.credentials.canonicalStore, 'nango');
  assert.equal(ASKABLE_GTM_CAPABILITY.credentials.retrieval, 'single-nango-action');
  assert.equal(ASKABLE_GTM_CAPABILITY.provider.endpointSource, 'nango-connection');
  assert.equal(ASKABLE_GTM_CAPABILITY.operations[2].availability, 'blocked');
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
  assert.match(sent[0].text, /Live execution is blocked/);
  assert.match(sent[0].text, /Revternal Nango action bridge/);
});

test('Listen gateway receives one bounded request with no credential or endpoint field', async () => {
  const requests = [];
  const result = await queryListen('developer tool migration pain', {
    status: 'configured',
    async listen(request) {
      requests.push(request);
      return {
        data: {
          meta: {
            query: 'developer tool migration pain',
            fetched_at: '2026-08-07T12:00:00Z',
          },
          results: [],
          source_status: { reddit: { status: 'ok', count: 0 } },
        },
        access: { credentialSource: 'user', endpointHost: 'provider.example' },
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].sources[0].platform, 'reddit');
  assert.equal(requests[0].page, 1);
  assert.equal(requests[0].per_page, 20);
  assert.equal('credential' in requests[0], false);
  assert.equal('apiKey' in requests[0], false);
  assert.equal('endpoint' in requests[0], false);
  assert.equal('baseUrl' in requests[0], false);
  assert.equal(result.data.source_status.reddit.status, 'ok');
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

test('answers disclose managed fallback and the connection-provided host', () => {
  const answer = renderListenAnswer('query', { results: [] }, [], {
    credentialSource: 'managed',
    endpointHost: 'managed.provider.example',
  });

  assert.match(answer, /Agent Workforce managed Revternal access/);
  assert.match(answer, /paid allowance/);
  assert.match(answer, /Host: managed\.provider\.example/);
});

test('answers suppress unsafe host metadata', () => {
  const answer = renderListenAnswer('query', { results: [] }, [], {
    credentialSource: 'user',
    endpointHost: 'user:secret@internal.example/path?token=value',
  });

  assert.match(answer, /Host: not disclosed/);
  assert.doesNotMatch(answer, /secret|internal\.example|token=value/);
});

test('gateway failures expose only an allowlisted code to logs and the user', async () => {
  const logs = [];
  const sent = [];
  const event = envelopeToAgentEvent({
    id: 'evt-question',
    workspace: 'workspace-test',
    type: 'relaycast.message',
    occurredAt: '2026-08-07T10:00:00Z',
    summary: { actor: { id: 'requester' } },
    resource: { text: 'What are developers saying about Acme?' },
  });
  assert.ok(event);

  const ctx = {
    log(level, message, fields) { logs.push({ level, message, fields }); },
    memory: { async recall() { return []; }, async save() {} },
    relay: {
      async dm(to, text) { sent.push({ to, text }); return { ok: true, messageId: 'message-test' }; },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      const error = new ListenGatewayError('provider-auth-failed');
      error.cause = new Error('upstream body with credential-shaped sensitive detail');
      throw error;
    },
  };

  await handleRelayMessage(ctx, event, gateway);

  const observable = JSON.stringify({ logs, sent });
  assert.match(observable, /provider-auth-failed/);
  assert.doesNotMatch(observable, /upstream body|credential-shaped|sensitive detail/);
});
