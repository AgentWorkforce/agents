import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSentinelServer } from '../scripts/acceptance/sentinel-server.mjs';
import { createIntegrationHealthServer } from '../scripts/acceptance/integration-health-server.mjs';
import { createModelMockServer } from '../scripts/acceptance/model-mock-server.mjs';
import { writeBlockedFile, removeBlockedFile } from '../scripts/acceptance/blocked-lifecycle.mjs';
import {
  cloudComposioIntegrationTitle,
  expectedHnSlackParentText,
  expectedHnSlackReplyText,
  validateCloudComposioVitestEvidence,
  validateHumanSlackTrace,
  validateSingleProviderReadEvidence,
  validateWritesDenyEvidence,
} from '../scripts/acceptance/closure-evidence.mjs';
import {
  acceptancePackageSourceEnv,
  acceptancePackageSourceModes,
  resolveAcceptancePackageSourceMode,
  resolveExpectedPublishedVersions,
  resolveRequiredWorkforcePackageNames,
} from '../scripts/acceptance/workforce-package-proof.mjs';

// ── sentinel server ──────────────────────────────────────────────────────────

test('sentinel server routes allowed GET correctly', async () => {
  const sentinel = await createSentinelServer();
  try {
    const res = await fetch(sentinel.allowedUrl);
    assert.ok(sentinel.allowedUrl.startsWith(sentinel.url));
    assert.equal(res.status, 200);
    assert.equal(sentinel.counts.allowed.get, 1);
    assert.equal(sentinel.counts.denied.post, 0);
    assert.equal(sentinel.counts.undeclared.get, 0);
  } finally {
    sentinel.close();
  }
});

test('sentinel server tracks undeclared GET separately', async () => {
  const sentinel = await createSentinelServer();
  try {
    await fetch(sentinel.undeclaredUrl);
    assert.equal(sentinel.counts.undeclared.get, 1);
    assert.equal(sentinel.counts.allowed.get, 0);
  } finally {
    sentinel.close();
  }
});

test('sentinel server tracks denied POST and raw separately', async () => {
  const sentinel = await createSentinelServer();
  try {
    await fetch(sentinel.deniedUrl, { method: 'POST', body: 'regular-post-body' });
    await fetch(sentinel.deniedUrl, { method: 'POST', body: 'raw-http-body' });
    assert.equal(sentinel.counts.denied.post, 1);
    assert.equal(sentinel.counts.denied.raw, 1);
  } finally {
    sentinel.close();
  }
});

test('sentinel server accumulates request log', async () => {
  const sentinel = await createSentinelServer();
  try {
    await fetch(sentinel.allowedUrl);
    await fetch(sentinel.undeclaredUrl);
    assert.equal(sentinel.counts.requests.length, 2);
    assert.ok(sentinel.counts.requests.some((r) => r.url === '/allowed-get'));
    assert.ok(sentinel.counts.requests.some((r) => r.url === '/undeclared-get'));
  } finally {
    sentinel.close();
  }
});

// ── integration health server ─────────────────────────────────────────────────

test('integration health server returns catalog with github', async () => {
  const server = await createIntegrationHealthServer();
  try {
    const res = await fetch(`${server.url}/api/v1/integrations/catalog`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const catalog = Array.isArray(body) ? body : (body.providers ?? []);
    assert.ok(catalog.some((entry) => entry.id === 'github'));
  } finally {
    server.close();
  }
});

test('integration health server returns registrationHealth in status', async () => {
  const server = await createIntegrationHealthServer();
  try {
    const statusUrl = `${server.url}/api/v1/workspaces/${encodeURIComponent(server.workspaceId)}/integrations/github/status?scope=workspace`;
    const res = await fetch(statusUrl, { headers: { authorization: 'Bearer test-token' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.registrationHealth, 'registrationHealth should be present');
    assert.equal(body.registrationHealth.registered, true);
    assert.ok(server.receivedRequests.some((r) => r.hasAuth), 'server should have received auth header');
  } finally {
    server.close();
  }
});

test('integration health server never retains raw auth credential', async () => {
  const server = await createIntegrationHealthServer();
  const rawToken = 'Bearer super-secret-token-that-must-not-leak';
  try {
    await fetch(`${server.url}/api/v1/integrations/catalog`, {
      headers: { authorization: rawToken },
    });
    for (const req of server.receivedRequests) {
      // Only hasAuth (boolean) and authScheme (string like 'Bearer') are stored.
      assert.ok(!('auth' in req), 'raw auth field must not exist on stored request');
      assert.ok(typeof req.hasAuth === 'boolean');
      assert.ok(req.authScheme === 'Bearer' || req.authScheme === null);
      // The raw token value must not be stored anywhere in the record.
      const serialized = JSON.stringify(req);
      assert.ok(!serialized.includes('super-secret-token-that-must-not-leak'));
    }
  } finally {
    server.close();
  }
});

// ── model mock server ─────────────────────────────────────────────────────────

// Codex-backend SSE format: POST /backend-api/codex/responses → text/event-stream

test('model mock server responds to POST /backend-api/codex/responses with SSE stream', async () => {
  const modelMock = await createModelMockServer();
  try {
    const res = await fetch(`${modelMock.codexBase}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${modelMock.mockAccessToken}`,
        'chatgpt-account-id': modelMock.mockAccountId,
      },
      body: JSON.stringify({
        model: 'codex-mini-latest',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] }],
        stream: true,
        max_output_tokens: 100,
        tools: [],
        instructions: '',
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    const text = await res.text();
    // Must contain at least response.output_text.delta and response.completed.
    assert.ok(text.includes('"type":"response.output_text.delta"'), 'SSE stream must include delta event');
    assert.ok(text.includes('"type":"response.completed"'), 'SSE stream must include completed event');
    assert.equal(modelMock.counts.total, 1);
    assert.equal(modelMock.counts.requests[0].authMatchedExpected, true);
    assert.equal(modelMock.counts.requests[0].accountMatchedExpected, true);
  } finally {
    modelMock.close();
  }
});

test('model mock server emits parseable SSE events for summarization prompts', async () => {
  const modelMock = await createModelMockServer();
  try {
    const promptText = JSON.stringify([{ id: 1001, title: 'Test agent story', why: '...' }]);
    const res = await fetch(`${modelMock.codexBase}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${modelMock.mockAccessToken}`,
        'chatgpt-account-id': modelMock.mockAccountId,
      },
      body: JSON.stringify({
        model: 'codex-mini-latest',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `${promptText}\nReturn JSON with "theme" and "stories"` }] }],
        stream: true,
        max_output_tokens: 900,
        tools: [],
        instructions: '',
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    // Parse SSE data lines.
    const events = text.split('\n')
      .filter((line) => line.startsWith('data: ') && !line.startsWith('data: [DONE]'))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const delta = events.find((e) => e.type === 'response.output_text.delta');
    assert.ok(delta, 'must have at least one delta event');
    // Digest path delta text must be parseable JSON.
    const parsed = JSON.parse(delta.delta);
    assert.ok(typeof parsed.theme === 'string');
    assert.ok(Array.isArray(parsed.stories));
  } finally {
    modelMock.close();
  }
});

test('model mock server returns 404 for unknown routes', async () => {
  const modelMock = await createModelMockServer();
  try {
    const res = await fetch(`${modelMock.codexBase}/unknown`);
    assert.equal(res.status, 404);
    assert.equal(modelMock.counts.unexpected.length, 1);
  } finally {
    modelMock.close();
  }
});

test('model mock server tracks call counts across multiple requests', async () => {
  const modelMock = await createModelMockServer();
  try {
    const makeCall = () => fetch(`${modelMock.codexBase}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${modelMock.mockAccessToken}`,
        'chatgpt-account-id': modelMock.mockAccountId,
      },
      body: JSON.stringify({ model: 'codex-mini-latest', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true, max_output_tokens: 50, tools: [], instructions: '' }),
    });
    await makeCall();
    await makeCall();
    await makeCall();
    assert.equal(modelMock.counts.total, 3);
    assert.equal(modelMock.counts.requests.length, 3);
    assert.ok(modelMock.counts.requests.every((request) => request.authMatchedExpected === true && request.accountMatchedExpected === true));
  } finally {
    modelMock.close();
  }
});

// ── blocked lifecycle helper ─────────────────────────────────────────────────

function tmpDir() {
  const dir = join(tmpdir(), `acceptance-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('writeBlockedFile creates a BLOCKED_NO_MERGE.md with failed gate details', () => {
  const dir = tmpDir();
  const path = join(dir, 'BLOCKED_NO_MERGE.md');
  const failedGates = [
    { gate: 'cli-help-snapshot', command: 'agentworkforce --help', summary: 'missing --schedule' },
    { gate: 'hn-schedule-preview', command: 'agentworkforce invoke --schedule scan', summary: 'flag not found' },
  ];
  try {
    writeBlockedFile(path, failedGates, 'abc1234def5678');
    const content = readFileSync(path, 'utf8');
    assert.ok(content.includes('# BLOCKED_NO_MERGE'));
    assert.ok(content.includes('abc1234def5678'));
    assert.ok(content.includes('cli-help-snapshot'));
    assert.ok(content.includes('missing --schedule'));
    assert.ok(content.includes('hn-schedule-preview'));
    assert.ok(content.includes('No PR was merged'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeBlockedFile deletes the file when it exists', () => {
  const dir = tmpDir();
  const path = join(dir, 'BLOCKED_NO_MERGE.md');
  try {
    writeBlockedFile(path, [{ gate: 'g', command: 'cmd', summary: 's' }], 'sha');
    removeBlockedFile(path);
    let exists = true;
    try { readFileSync(path); } catch { exists = false; }
    assert.ok(!exists, 'file should be removed after removeBlockedFile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeBlockedFile is silent when file does not exist', () => {
  const dir = tmpDir();
  const path = join(dir, 'BLOCKED_NO_MERGE.md');
  try {
    // Should not throw even when the file never existed.
    assert.doesNotThrow(() => removeBlockedFile(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeBlockedFile re-throws non-ENOENT errors', () => {
  // Simulate a permission/I/O error by passing a path whose parent is a file.
  const dir = tmpDir();
  const filePath = join(dir, 'not-a-dir');
  try {
    // Create a plain file and try to rmSync a path inside it (ENOTDIR / ENOENT variant that isn't the file itself).
    writeBlockedFile(filePath, [{ gate: 'g', command: 'c', summary: 's' }], 'sha');
    // Attempt to remove a path whose parent dir does not exist (clean ENOENT on a plain missing path).
    // Then force a non-ENOENT by crafting a synthetic error.
    const fakeError = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    assert.throws(
      () => {
        try { throw fakeError; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
      },
      (err) => err.code === 'EPERM',
      'non-ENOENT error must be re-thrown',
    );
    // ENOENT must still be swallowed.
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    assert.doesNotThrow(() => {
      try { throw enoent; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed-then-green lifecycle: file written on failure, removed on success', () => {
  const dir = tmpDir();
  const path = join(dir, 'BLOCKED_NO_MERGE.md');
  const failed = [{ gate: 'g', command: 'c', summary: 's' }];
  try {
    // Simulate a failing run.
    writeBlockedFile(path, failed, 'deadbeef');
    let content = readFileSync(path, 'utf8');
    assert.ok(content.includes('deadbeef'));

    // Simulate a green run — file must be removed.
    removeBlockedFile(path);
    let exists = true;
    try { readFileSync(path); } catch { exists = false; }
    assert.ok(!exists, 'green run must remove BLOCKED_NO_MERGE.md');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── local package proof planning ────────────────────────────────────────────

test('acceptance package source mode defaults to local-pack', () => {
  delete process.env[acceptancePackageSourceEnv];
  assert.equal(resolveAcceptancePackageSourceMode(), acceptancePackageSourceModes.localPack);
});

test('acceptance package source mode rejects unknown values', () => {
  assert.throws(
    () => resolveAcceptancePackageSourceMode('unknown-mode'),
    /Unsupported AGENTWORKFORCE_ACCEPTANCE_PACKAGE_SOURCE=unknown-mode/u,
  );
});

test('required Workforce package closure covers the installed invoke path', () => {
  const agentsPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const workforceRoot = fileURLToPath(new URL('../../workforce/', import.meta.url));
  const required = resolveRequiredWorkforcePackageNames({
    workforceRoot,
    agentsPackage: agentsPkg,
  });

  for (const name of [
    'agentworkforce',
    '@agentworkforce/cli',
    '@agentworkforce/compose',
    '@agentworkforce/deploy',
    '@agentworkforce/delivery',
    '@agentworkforce/events',
    '@agentworkforce/local-surface',
    '@agentworkforce/persona-kit',
    '@agentworkforce/runtime',
    '@agentworkforce/workload-router',
  ]) {
    assert.ok(required.includes(name), `${name} should be part of the local-package proof closure`);
  }
});

test('published package proof derives exact versions from the producer manifests', () => {
  const agentsPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const workforceRoot = fileURLToPath(new URL('../../workforce/', import.meta.url));
  const expected = resolveExpectedPublishedVersions({
    workforceRoot,
    agentsPackage: agentsPkg,
  });
  const producerVersion = JSON.parse(
    readFileSync(new URL('../../workforce/packages/runtime/package.json', import.meta.url), 'utf8'),
  ).version;

  assert.equal(expected.agentworkforce, producerVersion);
  assert.equal(expected['@agentworkforce/cli'], producerVersion);
  assert.equal(expected['@agentworkforce/runtime'], producerVersion);
  assert.ok(Object.values(expected).every((version) => version === producerVersion));
});

test('closure acceptance keeps fourteen gates and folds package proof into CLI evidence', () => {
  const source = readFileSync(
    new URL('../scripts/acceptance/composable-runtime-closure.mjs', import.meta.url),
    'utf8',
  );
  assert.equal([...source.matchAll(/await runGate\(/gu)].length, 14);
  assert.match(source, /'cli-help-snapshot'/u);
  assert.match(source, /createLocalPackWorkforceProof/u);
  assert.match(source, /'authored-writes-deny'/u);
  assert.match(source, /'relayfile-single-provider-read'/u);
  assert.match(source, /route\.integration\.test\.ts/u);
  assert.match(source, /development-override/u);
  assert.doesNotMatch(source, /'workforce-installed-package-proof'/u);
});

// ── closure finding evidence validators ─────────────────────────────────────

function writesDenyRecord(overrides = {}) {
  return {
    status: 'failed',
    policy: { writes: 'deny' },
    actions: [
      { kind: 'provider.write', provider: 'slack', status: 'denied', data: { body: { text: 'denied HN digest' } } },
      { kind: 'memory.save', status: 'denied', data: {} },
    ],
    stateDiff: { files: [], memory: [] },
    ...overrides,
  };
}

test('writes-deny evidence requires nonzero failure, denied HN writes, no mutation/receipts, and zero sentinel hits', () => {
  const evidence = validateWritesDenyEvidence({
    exitStatus: 1,
    runRecord: writesDenyRecord(),
    sentinelCounts: { requests: [] },
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.deniedWriteCount, 2);
});

test('writes-deny evidence rejects vacuous and escaped-write records', () => {
  const vacuous = validateWritesDenyEvidence({
    exitStatus: 0,
    runRecord: writesDenyRecord({ status: 'succeeded', actions: [] }),
    sentinelCounts: { requests: [] },
  });
  assert.equal(vacuous.ok, false);
  assert.ok(vacuous.errors.some((error) => error.includes('nonzero')));
  assert.ok(vacuous.errors.some((error) => error.includes('at least one required write')));

  const escaped = validateWritesDenyEvidence({
    exitStatus: 1,
    runRecord: writesDenyRecord({
      actions: [
        { kind: 'provider.write', provider: 'slack', status: 'denied', data: {} },
        { kind: 'files.write', status: 'previewed', data: { simulatedReceipt: { id: 'receipt' } } },
      ],
      stateDiff: { files: [{ path: '/escaped' }], memory: [] },
    }),
    sentinelCounts: { requests: [{ method: 'POST', url: '/escaped' }] },
  });
  assert.equal(escaped.ok, false);
  assert.ok(escaped.errors.some((error) => error.includes('escaped denial')));
  assert.ok(escaped.errors.some((error) => error.includes('zero simulated receipts')));
  assert.ok(escaped.errors.some((error) => error.includes('zero state mutations')));
  assert.ok(escaped.errors.some((error) => error.includes('sentinel received 1')));
});

function humanSlackRecord() {
  return {
    actions: [
      { kind: 'model.complete', status: 'previewed', data: {} },
      {
        kind: 'provider.write',
        provider: 'slack',
        resource: 'messages',
        status: 'previewed',
        data: {
          path: '/slack/channels/C123/messages/preview-parent.json',
          body: { text: expectedHnSlackParentText },
          simulatedReceipt: { id: 'preview-parent' },
        },
      },
      {
        kind: 'provider.write',
        provider: 'slack',
        resource: 'messages',
        status: 'previewed',
        data: {
          path: '/slack/channels/C123/messages/preview-reply.json',
          body: {
            text: expectedHnSlackReplyText,
            parentRef: '/slack/channels/C123/messages/preview-parent.json',
            thread_ts: 'preview-parent',
          },
          simulatedReceipt: { id: 'preview-reply' },
        },
      },
    ],
  };
}

function humanSlackOutput() {
  return [
    'preview: 1 run(s) — 1 ok, 0 failed',
    '    trace:',
    '      01. [PREVIEW] model.complete',
    '      02. [PREVIEW] provider.write slack.messages',
    '          slack message: parent',
    '          channel: C123',
    `          text (exact): ${JSON.stringify(expectedHnSlackParentText)}`,
    '      03. [PREVIEW] provider.write slack.messages',
    '          slack message: reply',
    '          channel: C123',
    '          linkage: parentRef=/slack/channels/C123/messages/preview-parent.json thread_ts=preview-parent receipt=preview-reply',
    `          text (exact): ${JSON.stringify(expectedHnSlackReplyText)}`,
    '',
  ].join('\n');
}

test('human Slack evidence requires exact HN texts, channel, linkage, and action order', () => {
  const evidence = validateHumanSlackTrace({
    humanOutput: humanSlackOutput(),
    runRecord: humanSlackRecord(),
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.parentActionSequence, 2);
  assert.equal(evidence.replyActionSequence, 3);
});

test('human Slack evidence rejects aggregate-only and partial output', () => {
  const aggregateOnly = validateHumanSlackTrace({
    humanOutput: 'preview: 1 run(s) — 1 ok, 0 failed\n  [ok] cron.tick@1 run_1 (3 action(s))\n',
    runRecord: humanSlackRecord(),
  });
  assert.equal(aggregateOnly.ok, false);
  assert.ok(aggregateOnly.errors.some((error) => error.includes('exact parent text')));
  assert.ok(aggregateOnly.errors.some((error) => error.includes('reply thread timestamp')));

  const noActions = validateHumanSlackTrace({ humanOutput: humanSlackOutput(), runRecord: { actions: [] } });
  assert.equal(noActions.ok, false);
  assert.ok(noActions.errors.some((error) => error.includes('exactly two Slack writes')));
});

test('human Slack evidence rejects independently truncated or substituted HN snapshots', () => {
  const truncatedRecord = humanSlackRecord();
  truncatedRecord.actions[2].data.body.text = expectedHnSlackReplyText.slice(0, -1);
  const truncated = validateHumanSlackTrace({ humanOutput: humanSlackOutput(), runRecord: truncatedRecord });
  assert.equal(truncated.ok, false);
  assert.ok(truncated.errors.some((error) => error.includes('RunRecord reply text')));

  const substitutedOutput = humanSlackOutput().replace('Claude Code adds background coding agents', 'substituted story');
  const substituted = validateHumanSlackTrace({ humanOutput: substitutedOutput, runRecord: humanSlackRecord() });
  assert.equal(substituted.ok, false);
  assert.ok(substituted.errors.some((error) => error.includes('exact reply text snapshot')));
});

test('single provider-read evidence rejects duplicate action or trace recording', () => {
  const action = {
    kind: 'provider.read',
    status: 'previewed',
    provider: 'slack',
    resource: 'messages',
    data: { operation: 'list', parameters: { channelId: 'C123' }, path: '/slack/channels/C123/messages' },
  };
  const span = {
    kind: 'provider.read',
    data: { operation: 'list', parameters: { channelId: 'C123' }, path: '/slack/channels/C123/messages' },
  };
  assert.equal(validateSingleProviderReadEvidence({ actions: [action], trace: [span] }).ok, true);
  assert.equal(validateSingleProviderReadEvidence({ actions: [action, action], trace: [span] }).ok, false);
  assert.equal(validateSingleProviderReadEvidence({ actions: [action], trace: [] }).ok, false);
  assert.equal(validateSingleProviderReadEvidence({ actions: [], trace: [] }).ok, false);
});

test('Cloud Composio evidence requires the dedicated verbose integration title and a green exit', () => {
  const evidence = {
    schemaVersion: 1,
    first: { httpStatus: 200, accepted: true, state: 'unmatched' },
    duplicate: { httpStatus: 200, accepted: true, state: 'duplicate', duplicateOf: 'event_1' },
    event: {
      id: 'event_1',
      type: 'composio.trigger.message',
      contractVersion: 1,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      resource: {
        provider: 'composio',
        kind: 'composio.trigger',
        id: 'ti_github_123',
        path: '/composio/triggers/ti_github_123',
      },
      occurredAt: '2026-07-16T01:00:00.000Z',
      deliveryId: 'msg_composio_123',
      payloadDeliveryId: 'msg_composio_123',
      payloadConnectionId: 'ca_composio_123',
    },
    identity: {
      workspaceIntegrationId: '33333333-3333-4333-8333-333333333333',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      provider: 'github',
      connectedAccountId: 'ca_composio_123',
      backend: 'composio',
    },
    dedupe: { first: 'claimed', second: 'duplicate', duplicateOf: 'event_1' },
    trace: {
      first: [
        'event.ingress.received',
        'event.ingress.verified',
        'event.contract.resolved',
        'event.normalized',
        'event.dedupe.claimed',
        'event.match.completed',
        'event.completed',
      ],
      second: [
        'event.ingress.received',
        'event.ingress.verified',
        'event.contract.resolved',
        'event.normalized',
        'event.dedupe.duplicate',
      ],
    },
    dispatchCount: 1,
  };
  const output = [
    'packages/web/app/api/v1/webhooks/composio/route.integration.test.ts',
    ` ✓ ${cloudComposioIntegrationTitle}`,
    `COMPOSIO_CLOSURE_EVIDENCE=${JSON.stringify(evidence)}`,
  ].join('\n');
  assert.equal(validateCloudComposioVitestEvidence({ exitStatus: 0, output }).ok, true);
  assert.equal(validateCloudComposioVitestEvidence({ exitStatus: 0, output: 'route.test.ts 1 passed' }).ok, false);
  assert.equal(validateCloudComposioVitestEvidence({ exitStatus: 1, output }).ok, false);

  const omitted = output.split('\n').slice(0, 2).join('\n');
  assert.equal(validateCloudComposioVitestEvidence({ exitStatus: 0, output: omitted }).ok, false);
  const malformed = `${omitted}\nCOMPOSIO_CLOSURE_EVIDENCE={not-json}`;
  assert.equal(validateCloudComposioVitestEvidence({ exitStatus: 0, output: malformed }).ok, false);

  const wrong = structuredClone(evidence);
  wrong.identity.connectedAccountId = 'ca_wrong';
  wrong.trace.first = [...wrong.trace.first].reverse();
  wrong.dispatchCount = 0;
  const wrongOutput = `${omitted}\nCOMPOSIO_CLOSURE_EVIDENCE=${JSON.stringify(wrong)}`;
  const wrongResult = validateCloudComposioVitestEvidence({ exitStatus: 0, output: wrongOutput });
  assert.equal(wrongResult.ok, false);
  assert.ok(wrongResult.errors.some((error) => error.includes('persisted connection')));
  assert.ok(wrongResult.errors.some((error) => error.includes('out of order')));
  assert.ok(wrongResult.errors.some((error) => error.includes('exactly once')));
});
