#!/usr/bin/env node
/**
 * askable-gtm live acceptance — drives the agent's REAL handler against the
 * REAL Cloud integration action gateway, so the only thing stubbed is the
 * chat transport. It proves the whole chain that a deployed run uses:
 *
 *   handleRelayMessage → createCloudApiListenGateway
 *     → POST /api/v1/workspaces/{id}/integrations/revternal/actions/social-listen
 *     → Nango revternal-relay → POST https://api.revternal.com/social/listen
 *
 * Credentials come from the CLI's own login (~/.agentworkforce/relay/cloud-auth.json
 * + ~/.agentworkforce/active.json). Nothing is printed that could leak one.
 *
 * Usage: node scripts/acceptance/askable-gtm-live.mjs [query]
 * Exit 0 = the chain answered with a well-formed, honest reply.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const QUERY = process.argv[2] ?? 'developer frustration with agent orchestration tools';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function loadCredentials() {
  const auth = readJson(path.join(homedir(), '.agentworkforce/relay/cloud-auth.json'));
  const active = readJson(path.join(homedir(), '.agentworkforce/active.json'));
  if (!auth.accessToken || !active.workspaceId) {
    throw new Error('no cloud login: run `agentworkforce` once to authenticate');
  }
  if (new Date(auth.accessTokenExpiresAt).getTime() <= Date.now()) {
    throw new Error('cloud access token is expired: re-authenticate the CLI');
  }
  return {
    cloudApi: { url: auth.apiUrl, token: auth.accessToken },
    // The gateway only reads `workspaceId` off the relayfile credential; watch
    // state is not exercised here, so no relayfile token is needed.
    relayfile: { url: auth.apiUrl, token: auth.accessToken, workspaceId: active.workspaceId },
  };
}

const { default: _agent, createCloudApiListenGateway, handleRelayMessage, classifyListenCoverage, queryListen } =
  await import('../../.test-build/askable-gtm/agent.js');

const credentials = loadCredentials();
const sent = [];
const logs = [];
const ctx = {
  log(level, message, fields) { logs.push({ level, message, fields }); },
  credentials: { tryRequire: () => credentials },
  memory: { async recall() { return []; }, async save() {} },
  relay: {
    async dm(to, text) { sent.push({ to, text }); return { ok: true, messageId: 'live-acceptance' }; },
  },
};

const gateway = createCloudApiListenGateway(ctx);
if (gateway.status !== 'configured') {
  console.error('FAIL: gateway resolved as blocked with real cloud credentials');
  process.exit(1);
}
console.log('gate 1 ok: cloud action gateway is configured');

const { data, access } = await queryListen(QUERY, gateway);
const report = classifyListenCoverage(data);
console.log(`gate 2 ok: provider answered · fetched_at=${data.meta?.fetched_at ?? 'n/a'}`
  + ` · total=${data.meta?.total_results ?? 0} · credentialSource=${access.credentialSource}`
  + ` · coverage=${report.coverage}`
  + (report.failedSources.length ? ` · failed=[${report.failedSources.join(',')}]` : ''));

// Build the event the same way the runtime does, so `expand()` and the
// envelope accessors the handler relies on are real rather than hand-rolled.
const { envelopeToAgentEvent } = await import('@agentworkforce/runtime');
const event = envelopeToAgentEvent({
  id: 'live-acceptance',
  workspace: credentials.relayfile.workspaceId,
  type: 'relaycast.message',
  occurredAt: new Date().toISOString(),
  summary: { actor: { id: 'live-acceptance-requester' } },
  resource: { text: QUERY },
});
if (!event) {
  console.error('FAIL: could not build a relaycast.message event');
  process.exit(1);
}
await handleRelayMessage(ctx, event, gateway);

if (sent.length !== 1) {
  console.error(`FAIL: expected exactly one reply, got ${sent.length}`);
  process.exit(1);
}
const reply = sent[0].text;
console.log('gate 3 ok: the handler produced one reply\n');
console.log('─'.repeat(72));
console.log(reply);
console.log('─'.repeat(72));

// The reply must never present a source outage as an empty market.
if (report.coverage === 'failed') {
  if (!/source outage/.test(reply)) {
    console.error('\nFAIL: every source failed but the reply did not say so');
    process.exit(1);
  }
  console.log('\ngate 4 ok: total source failure is reported as an outage, not "no results"');
  console.log('\nRESULT: the chain is wired correctly end to end, but the provider is degraded.');
  console.log(`        askable-gtm cannot return real signal until Revternal's `
    + `${report.failedSources.join(', ')} listener recovers. Re-run this script to check.`);
  process.exit(0);
}

// Assert on the evidence itself, not on a banner: the Slack surface
// deliberately drops the header, so pinning it here failed every healthy run.
if (!/^1\./mu.test(reply) || !/https:\/\/\S*linkedin\.com\//u.test(reply)) {
  console.error('\nFAIL: reply carries no numbered, linked LinkedIn evidence');
  process.exit(1);
}
const noise = ['Public-signal evidence for', 'Fetched:', 'Access:']
  .filter((phrase) => reply.includes(phrase));
if (noise.length > 0) {
  console.error(`\nFAIL: the answer regrew header noise the surface drops: ${noise.join(', ')}`);
  process.exit(1);
}
console.log('\ngate 4 ok: evidence-carrying answer returned with live results');
console.log('\nRESULT: askable-gtm is fully working end to end with live provider data.');
