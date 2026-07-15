import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';

import agent, {
  parseNeonEvent,
  neonEventFingerprint,
  formatEventAlert,
} from '../.test-build/neon-monitor/agent.js';

const FIXED_OCCURRED = '2026-06-18T10:00:00.000Z';

// A Neon sync-delta event exactly as Cloud Step 2 dispatches it (cloud-expert's
// pinned shape): standard AgentEvent, `type` = `neon.<object>.<action>`,
// top-level `occurredAt`, and the normalized object under `resource` (mirrored
// into `expand('full').data`).
function neonEvent(resource, type) {
  return envelopeToAgentEvent({
    id: `evt-${resource.id ?? 'x'}`,
    workspace: 'ws-test',
    type,
    provider: 'neon',
    occurredAt: resource.occurredAt ?? FIXED_OCCURRED,
    paths: [resource.path ?? `/neon/${resource.objectType ?? 'x'}/${resource.id ?? 'x'}.json`],
    resource,
  });
}

function failedOpResource(overrides = {}) {
  return {
    provider: 'neon',
    eventType: 'operation.failed',
    objectType: 'operation',
    id: 'op-123',
    objectId: 'op-123',
    path: '/neon/operations/op-123.json',
    payload: {
      id: 'op-123',
      action: 'apply_config',
      project_id: 'proj-royal-9',
      status: 'failed',
      error: 'start_compute timed out after 30s',
    },
    metadata: { action: 'ADDED' },
    ...overrides,
  };
}

function endpointResource(overrides = {}) {
  return {
    provider: 'neon',
    eventType: 'endpoint.state_changed',
    objectType: 'endpoint',
    id: 'ep-77',
    objectId: 'ep-77',
    current_state: 'waking',
    path: '/neon/endpoints/ep-77.json',
    payload: {
      id: 'ep-77',
      host: 'ep-77.us-east-2.neon.tech',
      project_id: 'proj-royal-9',
      current_state: 'waking',
    },
    metadata: { action: 'UPDATED' },
    ...overrides,
  };
}

function advisorResource(overrides = {}) {
  return {
    provider: 'neon',
    eventType: 'advisor.issue_raised',
    objectType: 'advisor-issue',
    id: 'cache-key-abc', // Cloud sets resource.id = cache_key for advisor
    objectId: 'cache-key-abc',
    path: '/neon/advisors/cache-key-abc.json',
    payload: {
      id: 'raw-advisor-1',
      cache_key: 'cache-key-abc',
      name: 'unused_index',
      title: 'Unused index on users.email',
      level: 'ERROR',
      remediation: 'DROP INDEX idx_users_email;',
    },
    metadata: { action: 'ADDED' },
    ...overrides,
  };
}

// In-memory ctx whose memory store actually persists across handler calls, so
// the replay-dedup path is exercised end-to-end.
function eventCtx(store) {
  return {
    persona: { inputs: { SLACK_CHANNEL: 'C-neon-alerts' }, inputSpecs: {} },
    memory: {
      recall: async (_q, opts) => {
        const tag = opts?.tags?.[0];
        const v = store.get(tag);
        return v ? [{ content: v }] : [];
      },
      save: async (content, opts) => {
        store.set(opts.tags[0], content);
        return { id: 'mem-1' };
      },
    },
    log: () => {},
  };
}

async function answerSlackWriteback(mountRoot, channel) {
  const dir = path.join(mountRoot, `slack/channels/${channel}/messages`);
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

// ── parseNeonEvent ────────────────────────────────────────────────────────────

test('parseNeonEvent reads the pinned v4 envelope for each event type', async () => {
  const op = await parseNeonEvent(neonEvent(failedOpResource(), 'neon.operation.failed'));
  assert.equal(op.eventType, 'operation.failed');
  assert.equal(op.objectType, 'operation');
  assert.equal(op.objectId, 'op-123');
  assert.equal(op.occurredAt, FIXED_OCCURRED);
  assert.equal(op.record.project_id, 'proj-royal-9');

  const ep = await parseNeonEvent(neonEvent(endpointResource(), 'neon.endpoint.state_changed'));
  assert.equal(ep.objectType, 'endpoint');
  assert.equal(ep.currentState, 'waking');

  const adv = await parseNeonEvent(neonEvent(advisorResource(), 'neon.advisor.issue_raised'));
  // Cloud sets resource.id = cache_key; objectId must prefer it.
  assert.equal(adv.objectId, 'cache-key-abc');
  assert.equal(adv.objectType, 'advisor-issue');
});

test('parseNeonEvent ignores non-neon events and records without a stable objectId', async () => {
  const cron = envelopeToAgentEvent({
    id: 'c1', workspace: 'ws', type: 'cron.tick',
    occurredAt: FIXED_OCCURRED, name: 'neon-scan', cron: '0 */2 * * *',
  });
  assert.equal(await parseNeonEvent(cron), undefined);

  // neon-typed but the resource carries no id/objectId/payload → no event.
  const noId = neonEvent({ provider: 'neon', eventType: 'operation.failed', objectType: 'operation' }, 'neon.operation.failed');
  assert.equal(await parseNeonEvent(noId), undefined);
});

test('parseNeonEvent falls back to stripping the neon. prefix when resource.eventType is absent', async () => {
  const r = failedOpResource();
  delete r.eventType;
  const parsed = await parseNeonEvent(neonEvent(r, 'neon.operation.failed'));
  assert.equal(parsed.eventType, 'operation.failed');
});

// ── neonEventFingerprint ──────────────────────────────────────────────────────

test('neonEventFingerprint matches the frozen per-object-type contract', () => {
  assert.equal(
    neonEventFingerprint({ eventType: 'operation.failed', objectType: 'operation', objectId: 'op-123', occurredAt: FIXED_OCCURRED, record: {} }),
    'neon:operation.failed:op-123',
  );
  assert.equal(
    neonEventFingerprint({ eventType: 'advisor.issue_raised', objectType: 'advisor-issue', objectId: 'cache-key-abc', occurredAt: FIXED_OCCURRED, record: {} }),
    'neon:advisor.issue_raised:cache-key-abc',
  );
  // Endpoint key folds in state + time so a legit later transition isn't suppressed.
  assert.equal(
    neonEventFingerprint({ eventType: 'endpoint.state_changed', objectType: 'endpoint', objectId: 'ep-77', currentState: 'waking', occurredAt: FIXED_OCCURRED, record: {} }),
    `neon:endpoint.state_changed:ep-77:waking:${FIXED_OCCURRED}`,
  );
});

test('endpoint fingerprint differs across distinct transitions on the same endpoint', () => {
  const base = { eventType: 'endpoint.state_changed', objectType: 'endpoint', objectId: 'ep-77', record: {} };
  const waking = neonEventFingerprint({ ...base, currentState: 'active', occurredAt: '2026-06-18T10:00:00.000Z' });
  const idle = neonEventFingerprint({ ...base, currentState: 'idle', occurredAt: '2026-06-18T10:05:00.000Z' });
  assert.notEqual(waking, idle);
});

// ── formatEventAlert ──────────────────────────────────────────────────────────

test('formatEventAlert renders each event type with the key identifying fields', async () => {
  const op = formatEventAlert(await parseNeonEvent(neonEvent(failedOpResource(), 'neon.operation.failed')));
  assert.match(op, /Neon operation failed/);
  assert.match(op, /apply_config/);
  assert.match(op, /proj-royal-9/);
  assert.match(op, /start_compute timed out/);

  const ep = formatEventAlert(await parseNeonEvent(neonEvent(endpointResource(), 'neon.endpoint.state_changed')));
  assert.match(ep, /endpoint state change/);
  assert.match(ep, /waking/);

  const adv = formatEventAlert(await parseNeonEvent(neonEvent(advisorResource(), 'neon.advisor.issue_raised')));
  // `*Neon advisor issue*` is markdown-bold, so the `*` sits before ` (ERROR)`.
  assert.match(adv, /Neon advisor issue\* \(ERROR\)/);
  assert.match(adv, /Unused index/);
});

// ── handler: real-time alert + replay dedup ───────────────────────────────────

test('handler posts a Slack alert on operation.failed and dedupes a replayed delivery', async (t) => {
  const oldMountPath = process.env.RELAYFILE_MOUNT_PATH;
  const oldMountRoot = process.env.RELAYFILE_MOUNT_ROOT;
  const oldChannel = process.env.SLACK_CHANNEL;
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'neon-monitor-mount-'));
  const store = new Map();

  try {
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-neon-alerts';

    const event = neonEvent(failedOpResource(), 'neon.operation.failed');

    // First delivery → one Slack alert.
    const firstPost = answerSlackWriteback(mountRoot, 'C-neon-alerts');
    await agent.handler(eventCtx(store), event);
    const payload = await firstPost;
    assert.match(payload.text, /Neon operation failed/);
    assert.match(payload.text, /proj-royal-9/);

    // The fingerprint was persisted.
    assert.deepEqual(JSON.parse(store.get('neon-monitor:event-dedup')), ['neon:operation.failed:op-123']);

    // answerSlackWriteback overwrites the draft with a receipt rather than
    // deleting it, so clear the dir to detect whether the replay writes a NEW one.
    const dir = path.join(mountRoot, 'slack/channels/C-neon-alerts/messages');
    for (const f of await readdir(dir)) await rm(path.join(dir, f));

    // Replay the SAME event → dedup short-circuits before any Slack post.
    await agent.handler(eventCtx(store), event);
    await new Promise((r) => setTimeout(r, 50));
    const remaining = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 0, 'replayed event must not write a second Slack draft');
  } finally {
    if (oldMountPath === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = oldMountPath;
    if (oldMountRoot === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = oldMountRoot;
    if (oldChannel === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = oldChannel;
  }
});

// ── handler: empty-VFS data-plane guard ───────────────────────────────────────

// A full-state scan against a mount where NO neon index has materialized must
// post a loud "empty /neon mount" diagnostic (cloud#2530) instead of silently
// logging scan-clean, and must dedupe a second scan while still un-materialized.
test('cron scan on an un-materialized /neon mount posts the cloud#2530 diagnostic and dedupes', async () => {
  const oldMountPath = process.env.RELAYFILE_MOUNT_PATH;
  const oldMountRoot = process.env.RELAYFILE_MOUNT_ROOT;
  const oldChannel = process.env.SLACK_CHANNEL;
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'neon-monitor-empty-'));
  const store = new Map();

  try {
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = 'C-neon-alerts';

    const cron = envelopeToAgentEvent({
      id: 'c1', workspace: 'ws', type: 'cron.tick',
      occurredAt: FIXED_OCCURRED, name: 'neon-scan', cron: '0 */2 * * *',
    });

    // First scan → one diagnostic post naming the empty mount + tracking issue.
    const firstPost = answerSlackWriteback(mountRoot, 'C-neon-alerts');
    await agent.handler(eventCtx(store), cron);
    const payload = await firstPost;
    assert.match(payload.text, /empty `\/neon` mount/);
    assert.match(payload.text, /cloud#2530/);

    // Second scan while STILL un-materialized → deduped, no new draft written.
    const dir = path.join(mountRoot, 'slack/channels/C-neon-alerts/messages');
    for (const f of await readdir(dir)) await rm(path.join(dir, f));
    await agent.handler(eventCtx(store), cron);
    await new Promise((r) => setTimeout(r, 50));
    const remaining = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
    assert.equal(remaining.length, 0, 'a still-empty mount must not repost the diagnostic');
  } finally {
    if (oldMountPath === undefined) delete process.env.RELAYFILE_MOUNT_PATH;
    else process.env.RELAYFILE_MOUNT_PATH = oldMountPath;
    if (oldMountRoot === undefined) delete process.env.RELAYFILE_MOUNT_ROOT;
    else process.env.RELAYFILE_MOUNT_ROOT = oldMountRoot;
    if (oldChannel === undefined) delete process.env.SLACK_CHANNEL;
    else process.env.SLACK_CHANNEL = oldChannel;
  }
});
