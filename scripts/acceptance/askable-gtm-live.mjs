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

// The README promises this script states the outcome and exits 0 either way so
// it can be used as the recovery check. A provider that is simply down must not
// surface as an uncaught stack trace — that is the one moment the script is
// reached for, and the one moment it would fail to answer.
// Only codes that mean the vendor itself is unwell. `request-failed` is
// `mapCloudActionError`'s catch-all — it covers any non-CloudIntegrationActionError
// throw and every unclassified cloud-action error — and `invalid-response` means
// the Cloud API returned an envelope we could not parse. Calling either of those
// a provider outage would tell someone whose credentials or gateway are broken
// to sit and wait for a recovery that is not coming.
const VENDOR_OUTAGE_CODES = new Set(['provider-unavailable', 'provider-rate-limited']);
let data;
let access;
try {
  ({ data, access } = await queryListen(QUERY, gateway));
} catch (error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const detail = error instanceof Error ? error.message : String(error);
  if (VENDOR_OUTAGE_CODES.has(code)) {
    console.log(`gate 2: the provider is unavailable (${code}): ${detail}`);
    console.log('\nRESULT: the chain is wired correctly up to the provider, which is down.');
    console.log('        Re-run this script to check whether it has recovered.');
    process.exit(0);
  }
  // Everything else needs someone to act — a missing connection, a rejected
  // credential, an exhausted quota — so it must not read as "just wait".
  console.error(`\nFAIL: the query could not run (${code ?? 'unknown'}): ${detail}`);
  process.exit(1);
}
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
// The reply below comes from the handler's own gateway calls, not from the
// preflight query above. Asserting the access disclosure against the preflight's
// metadata would compare two separate provider requests, so a valid reply could
// fail this gate if credential resolution differed between them. Record what the
// handler itself was told.
// Keep every call rather than the last one: with one shared slot the gate would
// silently judge the reply by whichever request happened to settle last.
const recordedAccess = [];
const recordAccess = (fn) => async (request) => {
  const result = await fn(request);
  recordedAccess.push(result.access);
  return result;
};
const recordingGateway = {
  ...gateway,
  listen: recordAccess((request) => gateway.listen(request)),
  ...(gateway.searchLinkedIn
    ? { searchLinkedIn: recordAccess((request) => gateway.searchLinkedIn(request)) }
    : {}),
};
await handleRelayMessage(ctx, event, recordingGateway);

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

// Assert on the evidence itself, not on a banner: the surface deliberately
// drops the header, so pinning it here failed every healthy run.
//
// `renderListenAnswer` leads with the answer and nothing else, so requiring the
// reply to *start* with it is the whole no-header-noise guarantee — and unlike
// scanning for banned phrases it cannot trip over a cited post whose own body
// happens to contain one.
const EMPTY_ANSWER = 'No results were returned.';
const leadsWithEvidence = /^1\./u.test(reply);
const leadsWithEmptyAnswer = reply.startsWith(EMPTY_ANSWER);
if (!leadsWithEvidence && !leadsWithEmptyAnswer) {
  console.error('\nFAIL: the reply does not lead with the answer — header noise regrew');
  process.exit(1);
}

// The managed and undisclosed paths are metered and billable, so the manifest
// marks that line `disclosureRequired`; the user's own credential needs none.
// Assert the contract both ways rather than treating every `Access:` as noise.
const credentialSources = new Set(recordedAccess.map((entry) => entry.credentialSource));
if (credentialSources.size > 1) {
  console.error(`\nFAIL: the handler's gateway calls disagreed on the credential source `
    + `(${[...credentialSources].join(', ')}), so the reply cannot disclose one honestly`);
  process.exit(1);
}
const replyAccess = recordedAccess[0];
const discloses = /^Access:/mu.test(reply);
if (!replyAccess) {
  // Falling back to the preflight's metadata here would reintroduce exactly the
  // cross-request comparison the wrapper above exists to remove. Nothing was
  // observed, so nothing is asserted — and the run says so rather than passing
  // a gate it never actually ran.
  console.log('note: the handler made no gateway call, so the access disclosure was not asserted');
} else if (replyAccess.credentialSource !== 'user' && !discloses) {
  console.error(`\nFAIL: ${replyAccess.credentialSource} access was not disclosed in the reply`);
  process.exit(1);
} else if (replyAccess.credentialSource === 'user' && discloses) {
  console.error('\nFAIL: the reply disclosed access for a user-connected credential');
  process.exit(1);
}

if (leadsWithEmptyAnswer) {
  console.log('\ngate 4 ok: a healthy empty result is reported as no results, not an outage');
  console.log('\nRESULT: the chain is wired correctly end to end; this query simply matched nothing.');
  console.log('        Re-run with a broader query to see evidence flow.');
  process.exit(0);
}

// Match on the parsed hostname: a URL merely containing "linkedin.com" (say
// https://example.com/linkedin.com/) is not LinkedIn evidence.
const citesLinkedIn = (reply.match(/https:\/\/\S+/gu) ?? []).some((raw) => {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
});
if (!citesLinkedIn) {
  console.error('\nFAIL: reply carries no LinkedIn permalink to back its evidence');
  process.exit(1);
}
console.log('\ngate 4 ok: evidence-carrying answer returned with live results');
console.log('\nRESULT: askable-gtm is fully working end to end with live provider data.');
