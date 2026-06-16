import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';
import { parseIntegrations } from '@agentworkforce/persona-kit';

import agent, { evaluateSignals } from '../.test-build/daytona-monitor/agent.js';
import persona from '../.test-build/daytona-monitor/persona.js';

const ORG_ID = 'd9efb08e-7f53-4fe0-b37e-d1a281622bc0';
const FIXED_NOW = Date.parse('2026-06-12T12:00:00.000Z');

async function writeDaytonaConfig() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'daytona-monitor-config-'));
  await writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        activeProfile: 'default',
        profiles: [
          {
            id: 'default',
            api: {
              url: 'https://app.daytona.io/api',
              key: null,
              token: {
                accessToken: 'cached-daytona-access',
                refreshToken: 'cached-refresh-token',
                expiresAt: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
              },
            },
          },
        ],
      },
      null,
      2,
    ),
  );
  return dir;
}

function cronEvent() {
  return envelopeToAgentEvent({
    id: 'evt-daytona-monitor',
    workspace: 'ws-test',
    type: 'cron.tick',
    occurredAt: new Date(FIXED_NOW).toISOString(),
    name: 'usage-scan',
    cron: '0 * * * *',
  });
}

// A Daytona sandbox-lifecycle webhook as the runtime delivers it: the provider
// payload rides in `resource` and surfaces through `event.expand('full')`.
function sandboxWebhookEvent(resource, type = 'daytona.sandbox.state.updated') {
  return envelopeToAgentEvent({
    id: `evt-${resource.id}`,
    workspace: 'ws-test',
    type,
    provider: 'daytona',
    occurredAt: new Date(FIXED_NOW).toISOString(),
    paths: [`/daytona/sandboxes/${resource.id}.json`],
    resource,
  });
}

function ctx(memorySaves, inputs = {}) {
  return {
    persona: {
      inputs: {
        SLACK_CHANNEL: 'C-daytona-alerts',
        DAYTONA_ORG_ID: ORG_ID,
        QUOTA_ALERT_PCT: '80',
        STALE_HOURS: '12',
        ...inputs,
      },
      inputSpecs: {},
    },
    memory: {
      recall: async () => [
        {
          content: JSON.stringify({
            running: 1,
            signature: ':old-alert:',
          }),
        },
      ],
      save: async (content, opts) => {
        memorySaves.push({ content, opts });
        return { id: 'snapshot-1' };
      },
    },
  };
}

function mockDaytonaFetch(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, headers: init.headers });

    assert.equal(init.headers.Authorization, 'Bearer cached-daytona-access');
    assert.equal(init.headers['X-Daytona-Organization-ID'], ORG_ID);

    if (href === `https://app.daytona.io/api/organizations/${ORG_ID}/usage`) {
      return Response.json({
        regionUsage: [
          {
            regionId: 'us',
            sandboxClass: 'large',
            totalCpuQuota: 10,
            currentCpuUsage: 9,
            totalMemoryQuota: 100,
            currentMemoryUsage: 85,
            totalDiskQuota: 1000,
            currentDiskUsage: 200,
          },
        ],
      });
    }

    if (href === 'https://app.daytona.io/api/sandbox') {
      return Response.json({
        items: Array.from({ length: 100 }, (_, i) => ({
          id: `stopped-${i}`,
          name: `stopped-${i}`,
          state: 'stopped',
        })),
        nextCursor: 'page-2',
      });
    }

    if (href === 'https://app.daytona.io/api/sandbox?cursor=page-2') {
      return Response.json({
        items: [
          { id: 'err-1', name: 'build-failed', state: 'error', errorReason: 'image pull failed' },
          {
            id: 'stale-1',
            name: 'old-runner',
            state: 'started',
            createdAt: new Date(FIXED_NOW - 13 * 60 * 60 * 1000).toISOString(),
          },
          ...Array.from({ length: 5 }, (_, i) => ({
            id: `started-${i}`,
            name: `fresh-runner-${i}`,
            state: 'started',
            createdAt: new Date(FIXED_NOW - 30 * 60 * 1000).toISOString(),
          })),
        ],
      });
    }

    assert.fail(`unexpected fetch: ${href}`);
  });
  return calls;
}

async function answerSlackWriteback(mountRoot) {
  const dir = path.join(mountRoot, 'slack/channels/C-daytona-alerts/messages');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const files = await readdir(dir).catch(() => []);
    const draft = files.find((file) => file.endsWith('.json'));
    if (draft) {
      const draftPath = path.join(dir, draft);
      const payload = JSON.parse(await readFile(draftPath, 'utf8'));
      await writeFile(draftPath, JSON.stringify({ created: '1700000000.000001' }), 'utf8');
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Slack draft was not written');
}

test('evaluateSignals detects quota, error, stale, and allocation spike deterministically', () => {
  const result = evaluateSignals(
    {
      regionUsage: [
        {
          regionId: 'us',
          sandboxClass: 'large',
          totalCpuQuota: 10,
          currentCpuUsage: 8,
          totalMemoryQuota: 100,
          currentMemoryUsage: 79,
        },
      ],
    },
    [
      { id: 'err-1', name: 'build-failed', state: 'error', errorReason: 'image pull failed' },
      {
        id: 'stale-1',
        name: 'old-runner',
        state: 'started',
        createdAt: new Date(FIXED_NOW - 13 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'fresh-1',
        name: 'fresh-runner',
        state: 'started',
        createdAt: new Date(FIXED_NOW - 60 * 60 * 1000).toISOString(),
      },
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `started-${i}`,
        state: 'STARTED',
        createdAt: new Date(FIXED_NOW - 30 * 60 * 1000).toISOString(),
      })),
    ],
    { quotaPct: 80, staleHours: 12, now: FIXED_NOW, lastRunning: 1 },
  );

  assert.equal(result.running, 6);
  assert.equal(result.alerts.length, 4);
  assert.match(result.alerts.join('\n'), /CPU quota.*80%.*8\/10/);
  assert.match(result.alerts.join('\n'), /Sandbox ERROR.*build-failed.*image pull failed/);
  assert.match(result.alerts.join('\n'), /Stale sandbox.*old-runner.*13h/);
  assert.match(result.alerts.join('\n'), /Allocation jump.*1.*6/);
  assert.doesNotMatch(result.alerts.join('\n'), /fresh-runner/);
  assert.doesNotMatch(result.alerts.join('\n'), /memory quota/);
});

test('dry-run computes Daytona signals and writes one sensible Slack alert payload', async (t) => {
  const oldConfigDir = process.env.DAYTONA_CONFIG_DIR;
  const oldMountPath = process.env.RELAYFILE_MOUNT_PATH;
  const oldMountRoot = process.env.RELAYFILE_MOUNT_ROOT;
  const oldSlackChannel = process.env.SLACK_CHANNEL;
  const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;
  const configDir = await writeDaytonaConfig();
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'daytona-monitor-mount-'));
  const memorySaves = [];

  try {
    process.env.DAYTONA_CONFIG_DIR = configDir;
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-daytona-alerts';
    delete process.env.WORKSPACE_ROOT;
    t.mock.method(Date, 'now', () => FIXED_NOW);
    const fetchCalls = mockDaytonaFetch(t);
    const slackPayloadPromise = answerSlackWriteback(mountRoot);

    await agent.handler(ctx(memorySaves), cronEvent());
    const slackPayload = await slackPayloadPromise;

    assert.deepEqual(
      fetchCalls.map((call) => call.href),
      [
        `https://app.daytona.io/api/organizations/${ORG_ID}/usage`,
        'https://app.daytona.io/api/sandbox',
        'https://app.daytona.io/api/sandbox?cursor=page-2',
      ],
    );
    assert.equal(slackPayload.text.match(/Daytona monitor/g).length, 1);
    assert.match(slackPayload.text, /CPU quota.*90%.*9\/10/);
    assert.match(slackPayload.text, /memory quota.*85%.*85\/100/);
    assert.match(slackPayload.text, /Sandbox ERROR.*build-failed.*image pull failed/);
    assert.match(slackPayload.text, /Stale sandbox.*old-runner.*13h/);
    assert.match(slackPayload.text, /Allocation jump.*1.*6/);
    assert.equal(memorySaves.length, 1);
    assert.deepEqual(memorySaves[0].opts, {
      tags: ['daytona-monitor:snapshot'],
      scope: 'workspace',
    });
    assert.equal(JSON.parse(memorySaves[0].content).running, 6);
  } finally {
    if (oldConfigDir === undefined) delete process.env.DAYTONA_CONFIG_DIR;
    else process.env.DAYTONA_CONFIG_DIR = oldConfigDir;
    if (oldMountPath === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = oldMountPath;
    if (oldMountRoot === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = oldMountRoot;
    if (oldSlackChannel === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = oldSlackChannel;
    if (oldWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = oldWorkspaceRoot;
  }
});

test('usage comes from the adapter VFS mount when present — no REST /usage call', async (t) => {
  const oldConfigDir = process.env.DAYTONA_CONFIG_DIR;
  const oldMountPath = process.env.RELAYFILE_MOUNT_PATH;
  const oldMountRoot = process.env.RELAYFILE_MOUNT_ROOT;
  const oldSlackChannel = process.env.SLACK_CHANNEL;
  const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;
  const configDir = await writeDaytonaConfig();
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'daytona-monitor-vfs-usage-'));
  const memorySaves = [];

  try {
    process.env.DAYTONA_CONFIG_DIR = configDir;
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-daytona-alerts';
    delete process.env.WORKSPACE_ROOT;
    t.mock.method(Date, 'now', () => FIXED_NOW);

    // Adapter-polled usage record sitting on the mount: the agent must read this
    // and skip the REST /usage call entirely.
    await mkdir(path.join(mountRoot, 'daytona/usage'), { recursive: true });
    await writeFile(
      path.join(mountRoot, 'daytona/usage', `${ORG_ID}.json`),
      JSON.stringify({
        organizationId: ORG_ID,
        regionUsage: [{ regionId: 'eu', totalDiskQuota: 1000, currentDiskUsage: 910 }],
      }),
      'utf8',
    );

    // Fetch answers ONLY the sandbox list — a /usage call would assert-fail.
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const href = String(url);
      calls.push(href);
      assert.equal(init.headers.Authorization, 'Bearer cached-daytona-access');
      assert.equal(init.headers['X-Daytona-Organization-ID'], ORG_ID);
      if (href === 'https://app.daytona.io/api/sandbox') {
        return Response.json({ items: [{ id: 'ok-1', name: 'ok-1', state: 'stopped' }] });
      }
      assert.fail(`unexpected fetch: ${href}`);
    });

    const slackPayloadPromise = answerSlackWriteback(mountRoot);
    await agent.handler(ctx(memorySaves), cronEvent());
    const slackPayload = await slackPayloadPromise;

    // No REST /usage — only the sandbox list was fetched.
    assert.deepEqual(calls, ['https://app.daytona.io/api/sandbox']);
    // The disk-quota signal came from the mounted record (91% >= 80%).
    assert.match(slackPayload.text, /disk quota.*eu.*91%.*910\/1000/);
  } finally {
    if (oldConfigDir === undefined) delete process.env.DAYTONA_CONFIG_DIR;
    else process.env.DAYTONA_CONFIG_DIR = oldConfigDir;
    if (oldMountPath === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = oldMountPath;
    if (oldMountRoot === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = oldMountRoot;
    if (oldSlackChannel === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = oldSlackChannel;
    if (oldWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = oldWorkspaceRoot;
  }
});

test('dry-run follows a non-empty cursor even when the page is shorter than the default page size', async (t) => {
  const oldConfigDir = process.env.DAYTONA_CONFIG_DIR;
  const oldMountPath = process.env.RELAYFILE_MOUNT_PATH;
  const oldMountRoot = process.env.RELAYFILE_MOUNT_ROOT;
  const oldSlackChannel = process.env.SLACK_CHANNEL;
  const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;
  const configDir = await writeDaytonaConfig();
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'daytona-monitor-short-page-'));
  const memorySaves = [];
  const calls = [];

  try {
    process.env.DAYTONA_CONFIG_DIR = configDir;
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-daytona-alerts';
    delete process.env.WORKSPACE_ROOT;
    t.mock.method(Date, 'now', () => FIXED_NOW);
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const href = String(url);
      calls.push(href);
      assert.equal(init.headers.Authorization, 'Bearer cached-daytona-access');
      assert.equal(init.headers['X-Daytona-Organization-ID'], ORG_ID);

      if (href === `https://app.daytona.io/api/organizations/${ORG_ID}/usage`) {
        return Response.json({ regionUsage: [] });
      }
      if (href === 'https://app.daytona.io/api/sandbox') {
        return Response.json({
          items: [{ id: 'healthy-1', name: 'healthy-1', state: 'stopped' }],
          nextCursor: 'page-2',
        });
      }
      if (href === 'https://app.daytona.io/api/sandbox?cursor=page-2') {
        return Response.json({
          items: [{ id: 'err-1', name: 'late-error', state: 'error', errorReason: 'boot failed' }],
        });
      }
      assert.fail(`unexpected fetch: ${href}`);
    });

    const slackPayloadPromise = answerSlackWriteback(mountRoot);
    await agent.handler(ctx(memorySaves), cronEvent());
    const slackPayload = await slackPayloadPromise;

    assert.deepEqual(calls, [
      `https://app.daytona.io/api/organizations/${ORG_ID}/usage`,
      'https://app.daytona.io/api/sandbox',
      'https://app.daytona.io/api/sandbox?cursor=page-2',
    ]);
    assert.match(slackPayload.text, /Sandbox ERROR.*late-error.*boot failed/);
  } finally {
    if (oldConfigDir === undefined) delete process.env.DAYTONA_CONFIG_DIR;
    else process.env.DAYTONA_CONFIG_DIR = oldConfigDir;
    if (oldMountPath === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = oldMountPath;
    if (oldMountRoot === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = oldMountRoot;
    if (oldSlackChannel === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = oldSlackChannel;
    if (oldWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = oldWorkspaceRoot;
  }
});

test('numeric persona inputs are honored instead of falling back to string defaults', async (t) => {
  const oldConfigDir = process.env.DAYTONA_CONFIG_DIR;
  const oldMountPath = process.env.RELAYFILE_MOUNT_PATH;
  const oldMountRoot = process.env.RELAYFILE_MOUNT_ROOT;
  const oldSlackChannel = process.env.SLACK_CHANNEL;
  const oldWorkspaceRoot = process.env.WORKSPACE_ROOT;
  const configDir = await writeDaytonaConfig();
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'daytona-monitor-numeric-inputs-'));
  const memorySaves = [];

  try {
    process.env.DAYTONA_CONFIG_DIR = configDir;
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-daytona-alerts';
    delete process.env.WORKSPACE_ROOT;
    t.mock.method(Date, 'now', () => FIXED_NOW);
    t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
      const href = String(url);
      assert.equal(init.headers.Authorization, 'Bearer cached-daytona-access');
      assert.equal(init.headers['X-Daytona-Organization-ID'], ORG_ID);

      if (href === `https://app.daytona.io/api/organizations/${ORG_ID}/usage`) {
        return Response.json({
          regionUsage: [
            { regionId: 'us', totalCpuQuota: 10, currentCpuUsage: 9 },
          ],
        });
      }
      if (href === 'https://app.daytona.io/api/sandbox') {
        return Response.json({
          items: [
            {
              id: 'running-1',
              name: 'running-1',
              state: 'started',
              createdAt: new Date(FIXED_NOW - 13 * 60 * 60 * 1000).toISOString(),
            },
          ],
        });
      }
      assert.fail(`unexpected fetch: ${href}`);
    });

    await agent.handler(ctx(memorySaves, { QUOTA_ALERT_PCT: 95, STALE_HOURS: 14 }), cronEvent());

    assert.equal(memorySaves.length, 1);
    assert.deepEqual(JSON.parse(memorySaves[0].content), { running: 1, signature: '' });
    await assert.rejects(answerSlackWriteback(mountRoot), /Slack draft was not written/);
  } finally {
    if (oldConfigDir === undefined) delete process.env.DAYTONA_CONFIG_DIR;
    else process.env.DAYTONA_CONFIG_DIR = oldConfigDir;
    if (oldMountPath === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = oldMountPath;
    if (oldMountRoot === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = oldMountRoot;
    if (oldSlackChannel === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = oldSlackChannel;
    if (oldWorkspaceRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = oldWorkspaceRoot;
  }
});

// ── webhook (real-time) path ──────────────────────────────────────────────────

/** Run `fn` with the Daytona token config + a fresh mount root in env. */
async function withWebhookEnv(fn) {
  const saved = {
    config: process.env.DAYTONA_CONFIG_DIR,
    path: process.env.RELAYFILE_MOUNT_PATH,
    mount: process.env.RELAYFILE_MOUNT_ROOT,
    slack: process.env.SLACK_CHANNEL,
    ws: process.env.WORKSPACE_ROOT,
  };
  const configDir = await writeDaytonaConfig();
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'daytona-monitor-wh-'));
  try {
    process.env.DAYTONA_CONFIG_DIR = configDir;
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-daytona-alerts';
    delete process.env.WORKSPACE_ROOT;
    await fn(mountRoot);
  } finally {
    if (saved.config === undefined) delete process.env.DAYTONA_CONFIG_DIR;
    else process.env.DAYTONA_CONFIG_DIR = saved.config;
    if (saved.path === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = saved.path;
    if (saved.mount === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = saved.mount;
    if (saved.slack === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = saved.slack;
    if (saved.ws === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = saved.ws;
  }
}

/** Mock fetch that answers only the single-sandbox refetch (`/sandbox/{id}`). */
function mockSandboxRefetch(t, byId) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const href = String(url);
    calls.push(href);
    assert.equal(init.headers.Authorization, 'Bearer cached-daytona-access');
    const match = /\/api\/sandbox\/([^/?]+)$/.exec(href);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const found = byId[id];
      if (found === '__500__') return new Response('boom', { status: 500 });
      if (found) return Response.json(found);
    }
    assert.fail(`unexpected fetch: ${href}`);
  });
  return calls;
}

function webhookCtx() {
  const logs = [];
  return {
    persona: {
      inputs: { SLACK_CHANNEL: 'C-daytona-alerts', DAYTONA_ORG_ID: ORG_ID },
      inputSpecs: {},
    },
    // The webhook path never touches snapshot memory, but the ctx shape must
    // still satisfy the handler's optional calls.
    memory: { recall: async () => [], save: async () => ({ id: 'unused' }) },
    log: (level, message, attrs) => logs.push({ level, message, attrs }),
    _logs: logs,
  };
}

test('declares daytona sandbox-lifecycle triggers alongside the hourly schedule', () => {
  const ons = (agent.triggers?.daytona ?? []).map((t) => t.on);
  assert.deepEqual(ons, ['sandbox.created', 'sandbox.state.updated']);
  assert.deepEqual(
    (agent.schedules ?? []).map((s) => s.name),
    ['usage-scan'],
  );
});

test('a sandbox.state.updated -> error webhook posts an immediate alert without a full scan', async (t) => {
  await withWebhookEnv(async (mountRoot) => {
    t.mock.method(Date, 'now', () => FIXED_NOW);
    const fetchCalls = mockSandboxRefetch(t, {
      'err-1': { id: 'err-1', name: 'build-failed', state: 'error', errorReason: 'image pull failed' },
    });
    const slackPayloadPromise = answerSlackWriteback(mountRoot);

    const event = sandboxWebhookEvent({ id: 'err-1', name: 'build-failed', newState: 'error' });
    await agent.handler(webhookCtx(), event);
    const slackPayload = await slackPayloadPromise;

    // Only the targeted sandbox was fetched — no usage/list calls (no full scan).
    assert.deepEqual(fetchCalls, ['https://app.daytona.io/api/sandbox/err-1']);
    assert.match(slackPayload.text, /real-time/);
    assert.match(slackPayload.text, /Sandbox ERROR.*build-failed.*image pull failed/);
    assert.doesNotMatch(slackPayload.text, /quota/);
  });
});

test('a build_failed webhook falls back to the payload reason when the refetch fails', async (t) => {
  await withWebhookEnv(async (mountRoot) => {
    t.mock.method(Date, 'now', () => FIXED_NOW);
    // Refetch 500s → handler must still alert off the webhook payload.
    mockSandboxRefetch(t, { 'bf-1': '__500__' });
    const slackPayloadPromise = answerSlackWriteback(mountRoot);

    const event = sandboxWebhookEvent({
      id: 'bf-1',
      name: 'compile-box',
      new_state: 'build_failed',
      error_reason: 'tsc exited 2',
    });
    await agent.handler(webhookCtx(), event);
    const slackPayload = await slackPayloadPromise;

    assert.match(slackPayload.text, /Sandbox BUILD_FAILED.*compile-box.*tsc exited 2/);
  });
});

test('a healthy sandbox.state.updated webhook stays silent (no Slack post)', async (t) => {
  await withWebhookEnv(async (mountRoot) => {
    t.mock.method(Date, 'now', () => FIXED_NOW);
    mockSandboxRefetch(t, { 'ok-1': { id: 'ok-1', name: 'runner', state: 'started' } });

    const ctxObj = webhookCtx();
    const event = sandboxWebhookEvent({ id: 'ok-1', name: 'runner', newState: 'started' });
    await agent.handler(ctxObj, event);

    const drafts = await readdir(path.join(mountRoot, 'slack/channels/C-daytona-alerts/messages')).catch(
      () => [],
    );
    assert.deepEqual(drafts, [], 'expected no Slack draft for a healthy state change');
    assert.ok(
      ctxObj._logs.some((l) => l.message.includes('no actionable signal')),
      'expected a logged skip for the healthy event',
    );
  });
});

// Config-invariant pin (creating-cloud-persona §1/§6): readUsage reads the
// adapter usage record from /daytona/usage/**, so that subtree MUST be mounted.
// Cloud derives mounts only from triggers + each integration's scope; a missing
// `usage` key (the pre-PR shape) leaves the read tree empty and the agent
// silently stuck on the REST fallback forever. Parse through persona-kit so we
// assert the scope as it survives client-side compilation, not the raw literal.
test('daytona integration scope mounts the usage subtree readUsage depends on', () => {
  const parsed = parseIntegrations(persona.default?.integrations ?? persona.integrations ?? {}, 'daytona-monitor.integrations') ?? {};
  const scope = parsed.daytona?.scope ?? {};
  assert.equal(scope.usage, '/daytona/usage/**', 'usage subtree must be scoped so the VFS read is mounted');
  // Don't regress the existing sandbox-lifecycle mirror while adding usage.
  assert.equal(scope.sandboxes, '/daytona/sandboxes/**', 'sandboxes mirror must remain mounted');
});
