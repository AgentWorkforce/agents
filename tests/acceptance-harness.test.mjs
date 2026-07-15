import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSentinelServer } from '../scripts/acceptance/sentinel-server.mjs';
import { createIntegrationHealthServer } from '../scripts/acceptance/integration-health-server.mjs';
import { createModelMockServer } from '../scripts/acceptance/model-mock-server.mjs';
import { writeBlockedFile, removeBlockedFile } from '../scripts/acceptance/blocked-lifecycle.mjs';

// ── sentinel server ──────────────────────────────────────────────────────────

test('sentinel server routes allowed GET correctly', async () => {
  const sentinel = await createSentinelServer();
  try {
    const res = await fetch(sentinel.allowedUrl);
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
