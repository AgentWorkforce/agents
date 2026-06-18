import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { envelopeToAgentEvent } from '@agentworkforce/runtime';
import { parseIntegrations } from '@agentworkforce/persona-kit';

import agent, { evaluateSignals } from '../.test-build/gcp-watcher/agent.js';
import persona from '../.test-build/gcp-watcher/persona.js';

const PROJECT_ID = 'nightcto-production';
const CHANNEL = 'C-gcp-alerts';

// ── event envelopes (as the runtime delivers them) ───────────────────────────

function cronEvent() {
  return envelopeToAgentEvent({
    id: 'evt-gcp-scan',
    workspace: 'ws-test',
    type: 'cron.tick',
    occurredAt: '2026-06-12T12:00:00.000Z',
    name: 'gcp-scan',
    cron: '0 * * * *',
  });
}

// A GCP Monitoring incident webhook. The provider payload rides in `resource`;
// `event.type` is the normalized `gcp.monitoring.incident.*` literal the handler
// routes on.
function monitoringWebhookEvent(type = 'gcp.monitoring.incident.open') {
  return envelopeToAgentEvent({
    id: `evt-${type}`,
    workspace: 'ws-test',
    type,
    provider: 'gcp',
    occurredAt: '2026-06-12T12:05:00.000Z',
    paths: ['/gcp/monitoring/alerts/_index.json'],
    resource: { id: 'incident-1' },
  });
}

// ── VFS mount fixtures ────────────────────────────────────────────────────────

/** Write the three GCP VFS mounts the agent reads. Omit a key to skip it. */
async function writeGcpMounts(mountRoot, { services, alerts, billing } = {}) {
  if (services) {
    const dir = path.join(mountRoot, 'gcp/run/services');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '_index.json'), JSON.stringify(services), 'utf8');
  }
  if (alerts) {
    const dir = path.join(mountRoot, 'gcp/monitoring/alerts');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '_index.json'), JSON.stringify(alerts), 'utf8');
  }
  if (billing) {
    const dir = path.join(mountRoot, 'gcp/billing');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'current.json'), JSON.stringify(billing), 'utf8');
  }
}

/** Drain the first Slack draft the agent writes and ack it with a receipt. */
async function answerSlackWriteback(mountRoot) {
  const dir = path.join(mountRoot, `slack/channels/${CHANNEL}/messages`);
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

/** Message files still carrying a `text` body — i.e. drafts not yet acked. */
async function pendingDrafts(mountRoot) {
  const dir = path.join(mountRoot, `slack/channels/${CHANNEL}/messages`);
  const files = await readdir(dir).catch(() => []);
  const pending = [];
  for (const file of files) {
    const body = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    if (typeof body.text === 'string') pending.push(file);
  }
  return pending;
}

/**
 * A ctx whose snapshot memory is a real mutable cell, so dedup behaves across
 * back-to-back handler calls exactly as it does in the cloud (load → evaluate →
 * save). `seed` is the signature already on record.
 */
function ctx({ seed = ':old-alert:', inputs = {} } = {}) {
  const store = { snapshot: seed === undefined ? undefined : { signature: seed } };
  const logs = [];
  return {
    _store: store,
    _logs: logs,
    persona: {
      inputs: {
        SLACK_CHANNEL: CHANNEL,
        GCP_PROJECT_ID: PROJECT_ID,
        BILLING_ALERT_USD: '500',
        ...inputs,
      },
      inputSpecs: {},
    },
    memory: {
      recall: async () => (store.snapshot ? [{ content: JSON.stringify(store.snapshot) }] : []),
      save: async (content) => {
        store.snapshot = JSON.parse(content);
        return { id: 'snapshot-1' };
      },
    },
    log: (level, message, attrs) => logs.push({ level, message, attrs }),
  };
}

/** Run `fn` with a fresh mount root wired into the relayfile env. */
async function withMount(fn) {
  const saved = {
    path: process.env.RELAYFILE_MOUNT_PATH,
    mount: process.env.RELAYFILE_MOUNT_ROOT,
    slack: process.env.SLACK_CHANNEL,
    ws: process.env.WORKSPACE_ROOT,
  };
  const mountRoot = await mkdtemp(path.join(os.tmpdir(), 'gcp-watcher-mount-'));
  try {
    process.env.RELAYFILE_MOUNT_PATH = mountRoot;
    process.env.RELAYFILE_MOUNT_ROOT = mountRoot;
    process.env.SLACK_CHANNEL = CHANNEL;
    delete process.env.WORKSPACE_ROOT;
    await fn(mountRoot);
  } finally {
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

// ── pure signal evaluation ────────────────────────────────────────────────────

test('evaluateSignals flags not-ready Cloud Run, a firing alert, and spend over threshold', () => {
  const { alerts } = evaluateSignals(
    [
      { name: 'api', region: 'us-central1', ready: false, latestRevision: 'api-00042' },
      { name: 'web', region: 'us-central1', ready: true },
    ],
    [
      { policyId: 'p-1', displayName: 'High 5xx rate', firing: true, conditionName: '5xx > 1%' },
      { policyId: 'p-2', displayName: 'Quiet policy', firing: false },
    ],
    { currency: 'USD', amount: 742 },
    { billingAlertUsd: 500 },
  );

  assert.equal(alerts.length, 3);
  const joined = alerts.join('\n');
  assert.match(joined, /Cloud Run not ready.*api @ us-central1.*api-00042/);
  assert.match(joined, /Alert firing.*High 5xx rate.*5xx > 1%/);
  assert.match(joined, /Spend.*USD.*742.*>= 500/);
  assert.doesNotMatch(joined, /web/);
  assert.doesNotMatch(joined, /Quiet policy/);
});

test('evaluateSignals stays silent when everything is healthy and spend is under threshold', () => {
  const { alerts } = evaluateSignals(
    [{ name: 'api', region: 'us-central1', ready: true }],
    [{ policyId: 'p-1', firing: false }],
    { currency: 'USD', amount: 120 },
    { billingAlertUsd: 500 },
  );
  assert.deepEqual(alerts, []);
});

// ── scheduled scan (cron) ─────────────────────────────────────────────────────

test('a cron scan reads the VFS mounts and writes one Slack alert payload', async () => {
  await withMount(async (mountRoot) => {
    await writeGcpMounts(mountRoot, {
      services: [{ name: 'api', region: 'us-central1', ready: false, latestRevision: 'api-00042' }],
      alerts: [{ policyId: 'p-1', displayName: 'High 5xx rate', firing: true }],
      billing: { currency: 'USD', amount: 742 },
    });

    const slackPayloadPromise = answerSlackWriteback(mountRoot);
    const c = ctx();
    await agent.handler(c, cronEvent());
    const slackPayload = await slackPayloadPromise;

    assert.equal(slackPayload.text.match(/GCP watcher/g).length, 1);
    assert.match(slackPayload.text, /Cloud Run not ready.*api @ us-central1/);
    assert.match(slackPayload.text, /Alert firing.*High 5xx rate/);
    assert.match(slackPayload.text, /Spend.*USD.*742/);
    // The dedup signature was persisted to workspace memory.
    assert.ok(c._store.snapshot.signature.length > 0);
  });
});

test('a cron scan stays silent (no Slack draft) when nothing is wrong', async () => {
  await withMount(async (mountRoot) => {
    await writeGcpMounts(mountRoot, {
      services: [{ name: 'api', region: 'us-central1', ready: true }],
      alerts: [{ policyId: 'p-1', firing: false }],
      billing: { currency: 'USD', amount: 120 },
    });

    const c = ctx();
    await agent.handler(c, cronEvent());

    const drafts = await readdir(path.join(mountRoot, `slack/channels/${CHANNEL}/messages`)).catch(() => []);
    assert.deepEqual(drafts, [], 'expected no Slack draft when all signals are clear');
    // Snapshot cleared so a future fire re-alerts.
    assert.equal(c._store.snapshot.signature, '');
  });
});

test('an empty mount (gcp-relay not live yet) degrades gracefully — no post', async () => {
  await withMount(async (mountRoot) => {
    const c = ctx({ seed: '' });
    await agent.handler(c, cronEvent());
    const drafts = await readdir(path.join(mountRoot, `slack/channels/${CHANNEL}/messages`)).catch(() => []);
    assert.deepEqual(drafts, [], 'expected silence when the VFS mounts are empty');
  });
});

// ── real-time webhook path (regression: no double-post) ───────────────────────

test('declares the monitoring incident triggers alongside the hourly schedule', () => {
  const ons = (agent.triggers?.gcp ?? []).map((t) => t.on);
  assert.deepEqual(ons, ['monitoring.incident.open', 'monitoring.incident.closed']);
  assert.deepEqual((agent.schedules ?? []).map((s) => s.name), ['gcp-scan']);
});

test('a monitoring webhook runs a full scan and posts the firing alert', async () => {
  await withMount(async (mountRoot) => {
    await writeGcpMounts(mountRoot, {
      alerts: [{ policyId: 'p-1', displayName: 'High 5xx rate', firing: true }],
    });

    const slackPayloadPromise = answerSlackWriteback(mountRoot);
    const c = ctx();
    await agent.handler(c, monitoringWebhookEvent('gcp.monitoring.incident.open'));
    const slackPayload = await slackPayloadPromise;

    assert.match(slackPayload.text, /Alert firing.*High 5xx rate/);
    assert.ok(c._store.snapshot.signature.length > 0, 'webhook must persist the dedup signature');
  });
});

test('webhook then hourly scan does NOT double-post the same firing alert', async () => {
  await withMount(async (mountRoot) => {
    await writeGcpMounts(mountRoot, {
      alerts: [{ policyId: 'p-1', displayName: 'High 5xx rate', firing: true }],
    });

    // Real-time webhook fires first and posts once.
    const firstPost = answerSlackWriteback(mountRoot);
    const c = ctx();
    await agent.handler(c, monitoringWebhookEvent('gcp.monitoring.incident.open'));
    await firstPost;

    // The hourly tick later sees the SAME unchanged firing alert. Because the
    // webhook shared the snapshot, the signature is unchanged → no second post.
    // (The first post's file lingers as an acked receipt; assert no NEW pending
    // draft — a file still carrying `text` — was written by the scan.)
    await agent.handler(c, cronEvent());
    const pending = await pendingDrafts(mountRoot);
    assert.deepEqual(pending, [], 'the hourly scan must not re-post an unchanged alert the webhook already sent');
  });
});

test('a closed incident clears the dedup signature so the next fire re-alerts', async () => {
  await withMount(async (mountRoot) => {
    // Incident has resolved — the alerts mount no longer shows it firing.
    await writeGcpMounts(mountRoot, {
      alerts: [{ policyId: 'p-1', displayName: 'High 5xx rate', firing: false }],
    });

    const c = ctx({ seed: ':warning: *Alert firing* `High 5xx rate`' });
    await agent.handler(c, monitoringWebhookEvent('gcp.monitoring.incident.closed'));

    const drafts = await readdir(path.join(mountRoot, `slack/channels/${CHANNEL}/messages`)).catch(() => []);
    assert.deepEqual(drafts, [], 'a closed incident produces no alert');
    assert.equal(c._store.snapshot.signature, '', 'closing must clear the signature so a future fire re-alerts');
  });
});

// ── persona config invariants (§1 scope trap) ─────────────────────────────────

test('gcp integration scope mounts the run/monitoring/billing subtrees the handler reads', () => {
  const parsed =
    parseIntegrations(persona.default?.integrations ?? persona.integrations ?? {}, 'gcp-watcher.integrations') ?? {};
  const gcp = parsed.gcp?.scope ?? {};
  assert.equal(gcp.run, '/gcp/run/**', 'run subtree must be scoped for the Cloud Run read');
  assert.equal(gcp.monitoring, '/gcp/monitoring/**', 'monitoring subtree must be scoped for the alerts read');
  assert.equal(gcp.billing, '/gcp/billing/**', 'billing subtree must be scoped for the spend read');
});

test('slack is scoped for writeback — a Slack post needs a scope, a trigger is never enough', () => {
  const parsed =
    parseIntegrations(persona.default?.integrations ?? persona.integrations ?? {}, 'gcp-watcher.integrations') ?? {};
  const slack = parsed.slack?.scope ?? {};
  // Without this the alert draft lands on unmounted disk and post() is a silent no-op (skill §1).
  assert.equal(slack.paths, '/slack/channels/**', 'slack channels subtree must be scoped so writeback is mounted');
});
