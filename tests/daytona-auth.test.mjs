import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getDaytonaAccessToken,
  getDaytonaOrgId,
  refreshAccessToken,
} from '../.test-build/daytona-monitor/lib/daytona-auth.js';

const FIXED_NOW = 1_800_000_000_000; // deterministic clock

async function writeConfig(token, overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'daytona-auth-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify(
      overrides.config ?? {
        activeProfile: 'initial',
        profiles: [
          {
            id: 'initial',
            name: 'initial',
            api: { url: 'https://app.daytona.io/api', key: null, token },
            activeOrganizationId: 'org-123',
          },
        ],
      },
      null,
      2,
    ),
  );
  return configPath;
}

test('returns the cached token untouched when it is still fresh', async () => {
  const configPath = await writeConfig({
    accessToken: 'fresh-access',
    refreshToken: 'rt-1',
    expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(), // +1h
  });
  let fetchCalls = 0;
  const token = await getDaytonaAccessToken('org-123', {
    configPath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('should not refresh a fresh token');
    },
  });
  assert.equal(token, 'fresh-access');
  assert.equal(fetchCalls, 0);
});

test('refreshes an expiring token and persists the rotated refresh token', async () => {
  const configPath = await writeConfig({
    accessToken: 'old-access',
    refreshToken: 'rt-old',
    expiresAt: new Date(FIXED_NOW + 60 * 1000).toISOString(), // +1m → inside 5m buffer
  });

  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'rt-new', // Auth0 rotation
        expires_in: 86400,
        token_type: 'Bearer',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const token = await getDaytonaAccessToken('org-123', {
    configPath,
    now: () => FIXED_NOW,
    fetchImpl,
  });

  // Returned a fresh access token.
  assert.equal(token, 'new-access');

  // Hit the exact Auth0 token endpoint with the required form params.
  assert.equal(captured.url, 'https://daytonaio.us.auth0.com/oauth/token');
  assert.equal(captured.init.method, 'POST');
  assert.equal(
    captured.init.headers['Content-Type'],
    'application/x-www-form-urlencoded',
  );
  const body = new URLSearchParams(captured.init.body.toString());
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('client_id'), 'kOJeeyZoCe0YiTJQQOJjItqpoogxIjWw');
  assert.ok(body.get('client_secret'), 'client_secret must be present (the crack)');
  assert.equal(body.get('refresh_token'), 'rt-old');
  // audience/scope must NOT be resent on refresh.
  assert.equal(body.get('audience'), null);
  assert.equal(body.get('scope'), null);

  // Persisted the rotation to disk.
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  const persisted = saved.profiles[0].api.token;
  assert.equal(persisted.accessToken, 'new-access');
  assert.equal(persisted.refreshToken, 'rt-new');
  assert.equal(persisted.expiresAt, new Date(FIXED_NOW + 86400 * 1000).toISOString());
});

test('uses profiles[].api.token from the configured active profile', async () => {
  const configPath = await writeConfig(null, {
    config: {
      activeProfile: 'work',
      profiles: [
        {
          id: 'personal',
          api: {
            url: 'https://app.daytona.io/api',
            key: null,
            token: {
              accessToken: 'personal-access',
              refreshToken: 'personal-refresh',
              expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
            },
          },
        },
        {
          id: 'work',
          api: {
            url: 'https://app.daytona.io/api',
            key: null,
            token: {
              accessToken: 'work-access',
              refreshToken: 'work-refresh',
              expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
            },
          },
        },
      ],
    },
  });

  const token = await getDaytonaAccessToken(undefined, {
    configPath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      throw new Error('should not refresh a fresh active-profile token');
    },
  });

  assert.equal(token, 'work-access');
});

test('persists the original refresh token when Auth0 returns the same token or omits rotation', async () => {
  const configPath = await writeConfig({
    accessToken: 'old-access',
    refreshToken: 'rt-stable',
    expiresAt: new Date(FIXED_NOW - 60 * 1000).toISOString(),
  });

  const token = await getDaytonaAccessToken('org-123', {
    configPath,
    now: () => FIXED_NOW,
    fetchImpl: async () =>
      new Response(JSON.stringify({ access_token: 'new-access', expires_in: 60 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  assert.equal(token, 'new-access');
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.profiles[0].api.token.refreshToken, 'rt-stable');
});

test('coalesces concurrent refreshes so one process spends the refresh token once', async () => {
  const configPath = await writeConfig({
    accessToken: 'old-access',
    refreshToken: 'rt-once',
    expiresAt: new Date(FIXED_NOW - 60 * 1000).toISOString(),
  });

  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(
      JSON.stringify({ access_token: 'shared-access', refresh_token: 'rt-new', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const [a, b] = await Promise.all([
    getDaytonaAccessToken('org-1', { configPath, now: () => FIXED_NOW, fetchImpl }),
    getDaytonaAccessToken('org-2', { configPath, now: () => FIXED_NOW, fetchImpl }),
  ]);

  assert.equal(a, 'shared-access');
  assert.equal(b, 'shared-access');
  assert.equal(fetchCalls, 1);
});

test('rejects expired access tokens that have no refresh token', async () => {
  const configPath = await writeConfig({
    accessToken: 'expired-access',
    expiresAt: new Date(FIXED_NOW - 60 * 1000).toISOString(),
  });

  await assert.rejects(
    getDaytonaAccessToken('org-123', { configPath, now: () => FIXED_NOW }),
    /expired and no refresh token/,
  );
});

test('refreshAccessToken keeps the old refresh token if none is returned', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ access_token: 'a2', expires_in: 100 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const result = await refreshAccessToken('rt-keep', fetchImpl);
  assert.equal(result.accessToken, 'a2');
  assert.equal(result.refreshToken, 'rt-keep');
  assert.equal(result.expiresInSec, 100);
});

test('refreshAccessToken surfaces an Auth0 error body on failure', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  await assert.rejects(
    refreshAccessToken('rt-bad', fetchImpl),
    /HTTP 403.*invalid_grant/s,
  );
});

// ── Deployed-persona path: cloud-injected env is preferred over the local file ──

test('prefers the cloud-injected DAYTONA_ACCESS_TOKEN over reading the config', async () => {
  // configPath points nowhere and fetch throws: if either is touched the test
  // fails, proving the injected env short-circuits the local config + refresh.
  const token = await getDaytonaAccessToken('org-x', {
    env: { DAYTONA_ACCESS_TOKEN: 'cloud-injected-access' },
    configPath: '/nonexistent/daytona/config.json',
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      throw new Error('must not refresh when env token is injected');
    },
  });
  assert.equal(token, 'cloud-injected-access');
});

test('falls back to the local config when DAYTONA_ACCESS_TOKEN is absent', async () => {
  const configPath = await writeConfig({
    accessToken: 'local-access',
    refreshToken: 'rt-local',
    expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
  });
  const token = await getDaytonaAccessToken('org-123', {
    env: {}, // no DAYTONA_ACCESS_TOKEN → local path
    configPath,
    now: () => FIXED_NOW,
    fetchImpl: async () => {
      throw new Error('should not refresh a fresh local token');
    },
  });
  assert.equal(token, 'local-access');
});

test('getDaytonaOrgId prefers DAYTONA_ORG_ID, then config, then undefined', async () => {
  // injected env wins (no config read needed)
  assert.equal(
    await getDaytonaOrgId({
      env: { DAYTONA_ORG_ID: 'org-injected' },
      configPath: '/nonexistent/daytona/config.json',
    }),
    'org-injected',
  );

  // falls back to the active profile's activeOrganizationId
  const configPath = await writeConfig({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(await getDaytonaOrgId({ env: {}, configPath }), 'org-123');

  // undefined when neither env nor a readable config provides one
  assert.equal(
    await getDaytonaOrgId({ env: {}, configPath: '/nonexistent/daytona/config.json' }),
    undefined,
  );
});
