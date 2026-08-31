import assert from 'node:assert/strict';
import test from 'node:test';

import { parseIntegrations } from '@agentworkforce/persona-kit';
import {
  WATCH_SWEEP_CRON,
  WATCH_STATE_PATH,
  ListenGatewayError,
  createCloudApiListenGateway,
  createWatch,
  createRelayfileWatchStateStore,
  deliverToOwner,
  handleRelayMessage,
  handleSlackMessage,
  parseCommand,
  queryListen,
  renderCapabilities,
  renderListenAnswer,
  runWatchSweep,
  watchIsDue,
} from '../.test-build/askable-gtm/agent.js';
import askableGtmAgent from '../.test-build/askable-gtm/agent.js';
import { ASKABLE_GTM_CAPABILITY } from '../.test-build/askable-gtm/capabilities.js';
import askableGtmPersona from '../.test-build/askable-gtm/persona.js';
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

function slackEvent(id, text, { channel = 'C_CHAT', user = 'U_HUMAN', ts = '100.1', threadTs } = {}) {
  const resource = { channel, ts, text, user };
  if (threadTs) resource.thread_ts = threadTs;
  const event = envelopeToAgentEvent({
    id,
    workspace: 'workspace-test',
    type: 'slack.message.created',
    occurredAt: '2026-08-07T10:00:00Z',
    resource,
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
  assert.equal(
    ASKABLE_GTM_CAPABILITY.provider.operation,
    'POST /api/v1/workspaces/:workspaceId/integrations/revternal/actions/social-listen',
  );
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

test('configured capability advertisement uses workspace integration wording', () => {
  const rendered = renderCapabilities('configured');
  assert.match(rendered, /Cloud integration action gateway is configured/);
  assert.doesNotMatch(rendered, /Nango gateway configured/);
});

test('persona and agent expose a gated Slack chat surface', () => {
  const parsed = parseIntegrations(askableGtmPersona.integrations, 'integrations');
  const slack = parsed?.slack;
  assert.equal(slack?.optional, true);
  assert.equal(slack?.enabledByInput, 'SLACK_CHANNEL');
  assert.deepEqual(slack?.scope, { paths: '/slack/channels/**' });
  assert.equal(askableGtmPersona.inputs?.SLACK_CHANNEL?.picker?.provider, 'slack');
  assert.equal(askableGtmAgent.triggers?.slack?.[0]?.on, 'message.created');
  assert.equal(askableGtmAgent.triggers?.slack?.[0]?.match, '@mention');
  assert.deepEqual(askableGtmAgent.triggers?.slack?.[0]?.paths, ['/slack/channels/${SLACK_CHANNEL}/**']);
});

test('persona prompt includes the full public-post evidence contract', () => {
  const prompt = askableGtmPersona.systemPrompt;
  assert.match(prompt, /source URL/);
  assert.match(prompt, /source timestamp/);
  assert.match(prompt, /fetched_at/);
  assert.match(prompt, /source coverage/);
  assert.match(prompt, /community/);
  assert.match(prompt, /public author handle/);
  assert.match(prompt, /title\/body excerpt/);
  assert.match(prompt, /score and comment counts/);
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
  assert.equal(state.watches[0].owner, 'relay:requester');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'requester');
  assert.match(sent[0].text, /shared 15-minute recurring sweep/);
  assert.match(sent[0].text, /did not create a per-watch Relaycron schedule/);
  assert.match(sent[0].text, /Live execution is unavailable in this runtime/);
  assert.match(sent[0].text, /connected Revternal integration/);
});

test('relay list-watches still sees legacy unprefixed owners', async () => {
  const sent = [];
  const cas = createCasStore(emptyWatchState([
    createWatch('legacy query', '6h', 'requester', new Date('2026-08-07T10:00:00.000Z')),
  ]));
  const ctx = {
    log() {},
    relay: {
      async dm(to, text) { sent.push({ to, text }); return { ok: true, messageId: 'message-test' }; },
    },
  };

  await handleRelayMessage(ctx, relayEvent('evt-watches', 'watches'), undefined, cas.store);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /legacy query/);
});

test('slack question replies in Slack and never falls back to relay dm', async () => {
  let relayDmCalls = 0;
  const slackCalls = [];
  const ctx = {
    persona: { inputs: { SLACK_CHANNEL: 'C_CHAT' } },
    log() {},
    relay: {
      async dm() {
        relayDmCalls += 1;
        return { ok: true, messageId: 'relay-should-not-be-used' };
      },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      return {
        data: {
          meta: { fetched_at: '2026-08-07T12:00:00Z' },
          results: [{
            source_id: 'post-1',
            title: 'Acme migration complaints',
            url: 'https://example.invalid/post-1',
            score_count: 12,
            comment_count: 4,
            community: { name: 'sales' },
          }],
          source_status: { reddit: { status: 'ok', count: 1 } },
        },
        access: { credentialSource: 'user', endpointHost: 'api.revternal.com' },
      };
    },
  };
  const slack = {
    async post(channel, text) {
      slackCalls.push({ kind: 'post', channel, text });
      return { channel, ts: '200.1' };
    },
    async reply(channel, threadTs, text) {
      slackCalls.push({ kind: 'reply', channel, threadTs, text });
      return { channel, ts: '200.2' };
    },
  };

  await handleSlackMessage(
    ctx,
    slackEvent('evt-slack-question', '<@U_BOT> what are developers saying about Acme?', {
      channel: 'C_CHAT',
      user: 'U_HUMAN',
    }),
    gateway,
    undefined,
    { slack },
  );

  assert.equal(relayDmCalls, 0);
  assert.equal(slackCalls.length, 1);
  assert.deepEqual(slackCalls[0].kind, 'post');
  assert.match(slackCalls[0].text, /Public-signal evidence for “what are developers saying about Acme\?”/);
  assert.match(slackCalls[0].text, /https:\/\/example\.invalid\/post-1/);
});

test('slack-created watches persist a Slack owner and future deliveries use Slack dm', async () => {
  const cas = createCasStore();
  const slackReplies = [];
  const ctx = {
    persona: { inputs: { SLACK_CHANNEL: 'C_CHAT' } },
    log() {},
    relay: {
      async dm() {
        throw new Error('relay dm must not be used for Slack watch delivery');
      },
    },
  };
  const slack = {
    async post(channel, text) {
      slackReplies.push({ kind: 'post', channel, text });
      return { channel, ts: '300.1' };
    },
    async reply(channel, threadTs, text) {
      slackReplies.push({ kind: 'reply', channel, threadTs, text });
      return { channel, ts: '300.2' };
    },
  };

  await handleSlackMessage(
    ctx,
    slackEvent('evt-slack-watch', '<@U_BOT> watch Acme migration pain every 6h', {
      channel: 'C_CHAT',
      user: 'U_WATCHER',
    }),
    { status: 'blocked', async listen() { throw new Error('not used'); } },
    cas.store,
    { slack },
  );

  const persisted = cas.state().watches[0];
  assert.equal(persisted.owner, 'slack:U_WATCHER');

  const slackDmCalls = [];
  await deliverToOwner(
    ctx,
    persisted.owner,
    'watch update',
    {
      slack: {
        async dm(user, text) {
          slackDmCalls.push({ user, text });
          return { ts: '300.3' };
        },
      },
    },
  );

  assert.deepEqual(slackDmCalls, [{ user: 'U_WATCHER', text: 'watch update' }]);
});

test('cloud API listen gateway calls the workspace integration action route with cloud credentials', async () => {
  const requests = [];
  let seenSignal;
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
    seenSignal = init?.signal;
    requests.push(new Request(input, init));
    return Response.json({
      ok: true,
      provider: 'revternal',
      action: 'social-listen',
      backend: 'nango',
      access: {
        credentialSource: 'user',
      },
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
  assert.equal(typeof seenSignal?.addEventListener, 'function');
  assert.equal(seenSignal?.aborted, false);
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
  assert.equal(result.access.credentialSource, 'user');
  assert.equal(result.access.endpointHost, 'api.revternal.com');
  assert.equal(result.data.meta.query, 'developer tool migration pain');
});

test('cloud API listen gateway preserves unknown access source when the gateway omits metadata', async () => {
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
  }, async () => Response.json({
    ok: true,
    provider: 'revternal',
    action: 'social-listen',
    backend: 'nango',
    result: {
      meta: { query: 'developer tool migration pain' },
      results: [],
      source_status: { reddit: { status: 'ok', count: 0 } },
    },
  }));

  const result = await gateway.listen({
    query: 'developer tool migration pain',
    sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
    filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
    sort_by: 'relevance_score',
    page: 1,
    per_page: 20,
  });

  assert.equal(result.access.credentialSource, 'unknown');
  assert.equal(result.access.endpointHost, 'api.revternal.com');
});

test('cloud API listen gateway normalizes workspace access metadata to the user disclosure bucket', async () => {
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
  }, async () => Response.json({
    ok: true,
    provider: 'revternal',
    action: 'social-listen',
    backend: 'nango',
    access: {
      credentialSource: 'workspace',
    },
    result: {
      meta: { query: 'developer tool migration pain' },
      results: [],
      source_status: { reddit: { status: 'ok', count: 0 } },
    },
  }));

  const result = await gateway.listen({
    query: 'developer tool migration pain',
    sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
    filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
    sort_by: 'relevance_score',
    page: 1,
    per_page: 20,
  });

  assert.equal(result.access.credentialSource, 'user');
  assert.equal(result.access.endpointHost, 'api.revternal.com');
});

test('cloud API listen gateway does not misclassify cloud auth failures as provider auth failures', async () => {
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
    code: 'unauthorized',
    error: 'Unauthorized',
  }), {
    status: 401,
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
      && error.code === 'request-failed'
      && error.message === 'Unauthorized',
  );
});

test('cloud API listen gateway maps upstream rate limits into provider rate limits', async () => {
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
    code: 'action_rate_limited',
    error: 'Rate limited',
    upstream: {
      status: 429,
      message: 'rate limit exceeded',
    },
  }), {
    status: 429,
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
      && error.code === 'provider-rate-limited',
  );
});

test('cloud API listen gateway maps upstream auth failures into provider auth failures', async () => {
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
    code: 'action_failed',
    error: 'Forbidden',
    upstream: {
      status: 401,
      type: 'authentication_error',
      message: 'unauthorized upstream',
    },
  }), {
    status: 502,
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
      && error.code === 'provider-auth-failed',
  );
});

test('cloud API listen gateway rejects malformed success payloads', async () => {
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
  }, async () => Response.json({
    ok: true,
    provider: 'revternal',
    action: 'social-listen',
    backend: 'nango',
    result: {
      meta: { query: 'developer tool migration pain' },
      results: null,
    },
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
      && error.code === 'invalid-response',
  );
});

test('cloud API listen gateway stays blocked without cloud runtime credentials', async () => {
  const gateway = createCloudApiListenGateway({
    credentials: {
      tryRequire() {
        return {
          relayfile: {
            url: 'https://relayfile.example',
            token: 'relay-token-test',
            workspaceId: 'rw_workspace',
          },
        };
      },
    },
  });

  assert.equal(gateway.status, 'blocked');
  await assert.rejects(
    () => gateway.listen({
      query: 'developer tool migration pain',
      sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
      filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
      sort_by: 'relevance_score',
      page: 1,
      per_page: 20,
    }),
    /Cloud API credentials or Relayfile workspace context are unavailable in this runtime/,
  );
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
  assert.match(answer, /Documented endpoint: managed\.provider\.example/);
});

test('answers suppress unsafe host metadata', () => {
  const answer = renderListenAnswer('query', { results: [] }, [], {
    credentialSource: 'unknown',
    endpointHost: 'user:secret@internal.example/path?token=value',
  });

  assert.match(answer, /Documented endpoint: not disclosed/);
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

test('an all-sources-failed response is reported as a source outage, not an empty market', () => {
  const answer = renderListenAnswer(
    'Acme migration pain',
    {
      meta: { fetched_at: '2026-08-31T21:11:12.491874Z', total_results: 0 },
      results: [],
      source_status: {
        reddit: { status: 'error', count: 0, error: "Client error '403 Blocked' for url ..." },
      },
    },
    [],
    { credentialSource: 'user', endpointHost: 'api.revternal.com' },
  );

  assert.match(answer, /every queried source failed \(reddit\)/);
  assert.match(answer, /source outage, not a finding that nothing was posted/);
  // The misleading empty-market phrasing must not survive a total outage, and
  // an outage carries no source facts to reason over.
  assert.doesNotMatch(answer, /No results were returned\./);
  assert.doesNotMatch(answer, /themes or intent require separate inference/);
});

test('a partially-failed response flags the missing source alongside the evidence it did get', () => {
  const answer = renderListenAnswer(
    'Acme migration pain',
    {
      meta: { fetched_at: '2026-08-31T21:11:12.491874Z', total_results: 1 },
      results: [],
      source_status: {
        reddit: { status: 'ok', count: 1 },
        hackernews: { status: 'error', count: 0, error: 'unsupported_platform' },
      },
    },
    [{ platform: 'reddit', source_id: 'post-1', title: 'Result', url: 'https://example.test/1' }],
    { credentialSource: 'user', endpointHost: 'api.revternal.com' },
  );

  assert.match(answer, /Partial coverage: hackernews failed this request/);
  assert.match(answer, /1\. Result/);
  assert.match(answer, /themes or intent require separate inference/);
});

test('a genuine empty result set is still reported as no results', () => {
  const answer = renderListenAnswer(
    'Acme migration pain',
    {
      meta: { fetched_at: '2026-08-31T21:11:12.491874Z', total_results: 0 },
      results: [],
      source_status: { reddit: { status: 'ok', count: 0 } },
    },
    [],
    { credentialSource: 'user', endpointHost: 'api.revternal.com' },
  );

  assert.match(answer, /No results were returned\./);
  assert.doesNotMatch(answer, /source outage/);
});

test('a sweep run whose sources all failed releases its claim and retries the same window', async () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const watch = createWatch('Acme migration pain', '15m', 'requester', now);
  const cas = createCasStore(emptyWatchState([watch]));
  const sent = [];
  const logs = [];
  let gatewayCalls = 0;
  const ctx = {
    log(level, message, fields) { logs.push({ level, message, fields }); },
    relay: {
      async dm(to, text) { sent.push({ to, text }); return { ok: true, messageId: 'message-ok' }; },
    },
  };
  const gateway = {
    status: 'configured',
    async listen() {
      gatewayCalls += 1;
      // First sweep sees the outage; the second sees the post that was
      // published during the window the outage would otherwise have consumed.
      if (gatewayCalls === 1) {
        return {
          data: {
            meta: { fetched_at: '2026-08-07T12:00:01.000Z' },
            results: [],
            source_status: { reddit: { status: 'error', count: 0, error: '403 Blocked' } },
          },
          access: { credentialSource: 'user', endpointHost: 'provider.example' },
        };
      }
      return {
        data: {
          meta: { fetched_at: '2026-08-07T12:00:02.000Z' },
          results: [{ platform: 'reddit', source_id: 'post-1', title: 'Posted during the outage' }],
          source_status: { reddit: { status: 'ok', count: 1 } },
        },
        access: { credentialSource: 'user', endpointHost: 'provider.example' },
      };
    },
  };

  await runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-outage');
  let persisted = cas.state().watches[0];
  assert.equal(persisted.lastRunAt, undefined, 'an outage must not consume the window');
  assert.deepEqual(persisted.seenIds, []);
  assert.equal(persisted.runClaim, undefined, 'the claim must be released for the retry');
  assert.equal(sent.length, 0, 'an outage is not a delivery');
  assert.ok(logs.some((entry) => entry.message === 'askable-gtm.watch-source-outage'));

  await runWatchSweep(ctx, now, gateway, cas.store, () => 'claim-recovered');
  persisted = cas.state().watches[0];
  assert.deepEqual(persisted.seenIds, ['reddit:post-1']);
  assert.equal(persisted.lastRunAt, now.toISOString());
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Posted during the outage/);
});

test('a Slack watch delivery with no receipt does not consume results', async () => {
  // Relay delivery already throws on `ok: false` so the sweep can retry. Slack
  // must behave the same way: a missing `ts` means Slack never acknowledged
  // the write, and committing seenIds would drop evidence the user never saw.
  const now = new Date('2026-08-07T12:00:00.000Z');
  const watch = createWatch('Acme migration pain', '15m', 'slack:U_WATCHER', now);
  const cas = createCasStore(emptyWatchState([watch]));
  let dmAttempts = 0;
  const ctx = {
    log() {},
    relay: {
      async dm() { throw new Error('relay dm must not be used for a Slack owner'); },
    },
  };
  const slack = {
    async dm() {
      dmAttempts += 1;
      // First write is dropped by Slack, second is acknowledged.
      return dmAttempts === 1 ? {} : { ts: '400.4' };
    },
  };

  await assert.rejects(
    () => deliverToOwner(ctx, watch.owner, 'watch update', { slack }),
    /Slack DM delivery failed for U_WATCHER/,
  );
  assert.equal(dmAttempts, 1);

  await deliverToOwner(ctx, watch.owner, 'watch update', { slack });
  assert.equal(dmAttempts, 2);
});
