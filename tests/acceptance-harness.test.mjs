import assert from 'node:assert/strict';
import test from 'node:test';
import { createSentinelServer } from '../scripts/acceptance/sentinel-server.mjs';
import { createIntegrationHealthServer } from '../scripts/acceptance/integration-health-server.mjs';

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
