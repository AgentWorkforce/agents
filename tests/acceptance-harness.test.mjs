import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSentinelServer } from '../scripts/acceptance/sentinel-server.mjs';
import { createIntegrationHealthServer } from '../scripts/acceptance/integration-health-server.mjs';
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
