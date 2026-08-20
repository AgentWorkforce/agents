import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATCH_SWEEP_CRON,
  WATCH_STATE_PATH,
  ListenGatewayError,
  createCloudApiListenGateway,
  createWatch,
  createRelayfileWatchStateStore,
  handleRelayMessage,
  parseCommand,
  queryListen,
  renderCapabilities,
  renderListenAnswer,
  runWatchSweep,
  watchIsDue,
} from '../.test-build/askable-gtm/agent.js';
import { ASKABLE_GTM_CAPABILITY } from '../.test-build/askable-gtm/capabilities.js';
import { envelopeToAgentEvent } from '@agentworkforce/runtime';

function emptyWatchState(watches = []) {
  return {
    kind: 'askable-gtm watch state',
    version: 1,
    updatedAt: new Date(0).toISOString(),
    watches,
  };
}

function createCasStore(initialState = emptyWatchState()) {
  let state = structuredClone(initialState);
  let revision = 0;
  const store = {
    async read() {
      return { state: structuredClone(state), revision: `rev-${revision}` };
    },
    async compareAndSet(expectedRevision, nextState) {
      await Promise.resolve();
      if (expectedRevision !== `rev-${revision}`) return false;
      state = structuredClone(nextState);
      revision += 1;
      return true;
    },
  };
  return {
    store,
    state: () => structuredClone(state),
  };
}

function relayEvent(id, text, sender = 'requester') {
  const event = envelopeToAgentEvent({
    id,
    workspace: 'workspace-test',
    type: 'relaycast.message',
    occurredAt: '2026-08-07T10:00:00Z',
    summary: { actor: { id: sender } },
    resource: { text },
  });
  assert.ok(event);
  return event;
}

test('machine-readable capability manifest is versioned and honest about live access', () => {
  assert.equal(ASKABLE_GTM_CAPABILITY.schema, 'agentrelay.askable.v1');
  assert.equal(ASKABLE_GTM_CAPABILITY.status, 'prototype-gated');
  assert.equal(ASKABLE_GTM_CAPABILITY.credentials.personaInput, false);
  assert.equal(ASKABLE_GTM_CAPABILITY.credentials.canonicalStore, 'nango');
  assert.equal(ASKABLE_GTM_CAPABILITY.credentials.retrieval, 'single-nango-action');
  assert.equal(ASKABLE_GTM_CAPABILITY.provider.endpointSource, 'nango-connection');
  assert.equal(ASKABLE_GTM_CAPABILITY.operations[2].availability, 'implemented_unverified');
  assert.equal(ASKABLE_GTM_CAPABILITY.provider.liveResultVerification, 'not-yet-live-verified');
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

test('human capability advertisement is rendered from the machine manifest', () => {
  const rendered = renderCapabilities('blocked');
  const watchOperation = ASKABLE_GTM_CAPABILITY.operations.find(
    (operation) => operation.id === 'manage-watch-definitions',
  );
  assert.match(rendered, new RegExp(watchOperation.accepts[0].replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')));
  assert.match(rendered, new RegExp(watchOperation.recurrence.sweepCron.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')));
  for (const question of ASKABLE_GTM_CAPABILITY.questions) {
    assert.match(rendered, new RegExp(question.example.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')));
  }
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
  const sent = [];
  const event = relayEvent('evt-watch', 'watch Acme migration pain every 6h');
  const cas = createCasStore();

  const ctx = {
    log() {},
    relay: {
      async dm(to, text) { sent.push({ to, text }); return { ok: true, messageId: 'message-test' }; },
    },
  };

  await handleRelayMessage(ctx, event, undefined, cas.store);
  const state = cas.state();
  assert.equal(state.watches.length, 1);
  assert.equal(state.watches[0].query, 'Acme migration pain');
  assert.equal(state.watches[0].cadence, '6h');
  assert.equal(state.watches[0].owner, 'requester');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'requester');
  assert.match(sent[0].text, /shared 15-minute recurring sweep/);
  assert.match(sent[0].text, /did not create a per-watch Relaycron schedule/);
  assert.match(sent[0].text, /Live execution is unavailable in this runtime/);
  assert.match(sent[0].text, /connected Revternal integration/);
});

test('cloud API listen gateway calls the workspace integration action route with cloud credentials', async () => {
  const requests = [];
  const gateway = createCloudApiListenGateway({
    credentials: {
      tryRequire() {
        return {
          relayfile: {
            url: 'https://relayfile.example',
            token: 'relay-token-test',
            workspaceId: 'rw_workspace',
          },
          cloudApi: {
            url: 'https://cloud.example/',
            token: 'cloud-token-test',
          },
        };
      },
    },
  }, async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({
      ok: true,
      provider: 'revternal',
      action: 'social-listen',
      backend: 'nango',
      result: {
        meta: { query: 'developer tool migration pain' },
        results: [],
        source_status: { reddit: { status: 'ok', count: 0 } },
      },
    });
  });

  const result = await gateway.listen({
    query: 'developer tool migration pain',
    sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
    filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
    sort_by: 'relevance_score',
    page: 1,
    per_page: 20,
  });

  assert.equal(gateway.status, 'configured');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://cloud.example/api/v1/workspaces/rw_workspace/integrations/revternal/actions/social-listen',
  );
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer cloud-token-test');
  assert.deepEqual(await requests[0].json(), {
    input: {
      query: 'developer tool migration pain',
      sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
      filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
      sort_by: 'relevance_score',
      page: 1,
      per_page: 20,
    },
  });
  assert.equal(result.access.endpointHost, 'api.revternal.com');
  assert.equal(result.data.meta.query, 'developer tool migration pain');
});

test('cloud API listen gateway maps allowlisted route errors into gateway errors', async () => {
  const gateway = createCloudApiListenGateway({
    credentials: {
      tryRequire() {
        return {
          relayfile: {
            url: 'https://relayfile.example',
            token: 'relay-token-test',
            workspaceId: 'rw_workspace',
          },
          cloudApi: {
            url: 'https://cloud.example',
            token: 'cloud-token-test',
          },
        };
      },
    },
  }, async () => new Response(JSON.stringify({
    ok: false,
    code: 'integration_not_found',
    error: 'No revternal integration is connected for this workspace',
  }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }));

  await assert.rejects(
    () => gateway.listen({
      query: 'developer tool migration pain',
      sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
      filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
      sort_by: 'relevance_score',
      page: 1,
      per_page: 20,
    }),
    (error) =>
      error instanceof ListenGatewayError
      && error.code === 'connection-required'
      && /not connected/i.test(error.message),
  );
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

test('interactive queries are normalized and validated before the gateway is called', async () => {
  const requests = [];
  const gateway = {
    status: 'configured',
    async listen(request) {
      requests.push(request);
      return {
        data: { results: [] },
        access: { credentialSource: 'user', endpointHost: 'provider.example' },
      };
    },
  };

  await assert.rejects(() => queryListen('', gateway), /between 2 and 500 characters/);
  await assert.rejects(() => queryListen('x', gateway), /between 2 and 500 characters/);
  await queryListen('  ok  ', gateway);
  await queryListen('x'.repeat(500), gateway);
  await assert.rejects(() => queryListen('x'.repeat(501), gateway), /between 2 and 500 characters/);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].query, 'ok');
  assert.equal(requests[1].query.length, 500);
});

test('invalid interactive query returns an error without invoking the gateway', async () => {
  let gatewayCalls = 0;
  const sent = [];
  const ctx = {
    log() {},
    relay: {
      async dm(to, text) { sent.push({ to, text }); return { ok: true }; },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      gatewayCalls += 1;
      throw new Error('must not be called');
    },
  };

  await handleRelayMessage(ctx, relayEvent('evt-short', 'x'), gateway);

  assert.equal(gatewayCalls, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /between 2 and 500 characters/);
});

test('Relayfile watch store uses creation-only and revision-matched writes', async () => {
  const requests = [];
  const responses = [
    new Response('', { status: 404 }),
    new Response('', { status: 200, headers: { etag: 'rev-1' } }),
  ];
  const store = createRelayfileWatchStateStore({
    credentials: {
      tryRequire() {
        return {
          relayfile: {
            url: 'https://relayfile.example',
            token: 'test-token-placeholder',
            workspaceId: 'workspace-test',
          },
        };
      },
    },
  }, async (input, init) => {
    requests.push(new Request(input, init));
    return responses.shift();
  });

  const snapshot = await store.read();
  assert.equal(snapshot.revision, '0');
  assert.equal(await store.compareAndSet(snapshot.revision, snapshot.state), true);
  assert.equal(requests[0].method, 'GET');
  assert.equal(new URL(requests[0].url).searchParams.get('path'), WATCH_STATE_PATH);
  assert.equal(requests[1].method, 'PUT');
  assert.equal(requests[1].headers.get('if-match'), '0');
});

test('failed watch delivery does not consume results and the next sweep retries them', async () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const watch = createWatch('Acme migration pain', '15m', 'requester', now);
  const cas = createCasStore(emptyWatchState([watch]));
  let deliveryAttempts = 0;
  let gatewayCalls = 0;
  const ctx = {
    log() {},
    relay: {
      async dm() {
        deliveryAttempts += 1;
        return deliveryAttempts === 1 ? { ok: false } : { ok: true, messageId: 'message-ok' };
      },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      gatewayCalls += 1;
      return {
        data: {
          meta: { fetched_at: '2026-08-07T12:00:01.000Z' },
          results: [{ platform: 'reddit', source_id: 'post-1', title: 'Result' }],
          source_status: { reddit: { status: 'ok', count: 1 } },
        },
        access: { credentialSource: 'user', endpointHost: 'provider.example' },
      };
    },
  };

  await runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-first');
  let persisted = cas.state().watches[0];
  assert.deepEqual(persisted.seenIds, []);
  assert.equal(persisted.lastRunAt, undefined);
  assert.equal(persisted.runClaim, undefined);

  await runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-second');
  persisted = cas.state().watches[0];
  assert.deepEqual(persisted.seenIds, ['reddit:post-1']);
  assert.equal(persisted.lastRunAt, now.toISOString());
  assert.equal(persisted.runClaim, undefined);
  assert.equal(deliveryAttempts, 2);
  assert.equal(gatewayCalls, 2);
});

test('CAS preserves concurrent create, remove, and sweep mutations without duplicate delivery', async () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const removeTarget = createWatch('remove me', '15m', 'requester', now);
  removeTarget.lastRunAt = now.toISOString();
  const sweepTarget = createWatch('sweep me', '15m', 'requester', now);
  const cas = createCasStore(emptyWatchState([removeTarget, sweepTarget]));
  const sent = [];
  let gatewayCalls = 0;
  const ctx = {
    log() {},
    relay: {
      async dm(to, text) {
        sent.push({ to, text });
        return { ok: true, messageId: `message-${sent.length}` };
      },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      gatewayCalls += 1;
      await Promise.resolve();
      return {
        data: {
          meta: { fetched_at: '2026-08-07T12:00:01.000Z' },
          results: [{ platform: 'reddit', source_id: 'post-2', title: 'Concurrent result' }],
          source_status: { reddit: { status: 'ok', count: 1 } },
        },
        access: { credentialSource: 'user', endpointHost: 'provider.example' },
      };
    },
  };

  await Promise.all([
    handleRelayMessage(
      ctx,
      relayEvent('evt-create-concurrent', 'watch keep me every 1h'),
      gateway,
      cas.store,
    ),
    handleRelayMessage(
      ctx,
      relayEvent('evt-remove-concurrent', `unwatch ${removeTarget.id}`),
      gateway,
      cas.store,
    ),
    runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-concurrent'),
  ]);

  const state = cas.state();
  assert.equal(state.watches.some((watch) => watch.id === removeTarget.id), false);
  assert.equal(state.watches.some((watch) => watch.query === 'keep me'), true);
  const swept = state.watches.find((watch) => watch.id === sweepTarget.id);
  assert.deepEqual(swept.seenIds, ['reddit:post-2']);
  assert.equal(swept.runClaim, undefined);
  assert.equal(gatewayCalls, 1);
  assert.equal(sent.filter(({ text }) => text.includes('Concurrent result')).length, 1);
});

test('a CAS run claim fences concurrent sweeps for the same work unit', async () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const watch = createWatch('one delivery', '15m', 'requester', now);
  const cas = createCasStore(emptyWatchState([watch]));
  let gatewayCalls = 0;
  let deliveries = 0;
  let releaseGateway;
  const gatewayBarrier = new Promise((resolve) => { releaseGateway = resolve; });
  const ctx = {
    log() {},
    relay: {
      async dm() { deliveries += 1; return { ok: true }; },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      gatewayCalls += 1;
      await gatewayBarrier;
      return {
        data: { results: [{ platform: 'reddit', source_id: 'post-3' }] },
        access: { credentialSource: 'user', endpointHost: 'provider.example' },
      };
    },
  };

  const first = runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-a');
  const second = runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-b');
  await new Promise((resolve) => setImmediate(resolve));
  releaseGateway();
  await Promise.all([first, second]);

  assert.equal(gatewayCalls, 1);
  assert.equal(deliveries, 1);
  assert.deepEqual(cas.state().watches[0].seenIds, ['reddit:post-3']);
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
