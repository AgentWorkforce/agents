const writeKinds = new Set([
  'provider.write',
  'relay.post',
  'files.write',
  'sandbox.write',
  'memory.save',
  'schedule.at',
  'schedule.cancel',
  'compose.run',
  'compose.spawn',
]);

export const cloudComposioIntegrationTitle =
  'authenticates a persisted Composio identity, dispatches a canonical Event, and records SQL dedupe + trace evidence';
export const cloudComposioEvidenceMarker = 'COMPOSIO_CLOSURE_EVIDENCE=';

const expectedFirstComposioTrace = [
  'event.ingress.received',
  'event.ingress.verified',
  'event.contract.resolved',
  'event.normalized',
  'event.dedupe.claimed',
  'event.match.completed',
  'event.completed',
];
const expectedDuplicateComposioTrace = [
  'event.ingress.received',
  'event.ingress.verified',
  'event.contract.resolved',
  'event.normalized',
  'event.dedupe.duplicate',
];

export const expectedHnSlackParentText = [
  ':satellite_antenna: *HN agentic radar — 3 fresh signals*',
  '_1 Front Page · 1 Show HN · 2 New · Details in thread._',
].join('\n');

export const expectedHnSlackReplyText = [
  '*:mag: What stands out*',
  '_Agent infrastructure stories worth monitoring._',
  '',
  '*1 · <https://example.com/claude-code-agents|Claude Code adds background coding agents>*',
  '`CODING AGENTS`  ▲ 121 points  ·  49 comments  ·  Front Page + New',
  'Relevant to agent builders: Claude Code adds background coding agents',
  '<https://news.ycombinator.com/item?id=1001|HN discussion>  ·  example.com',
  '',
  '*2 · <https://example.com/agent-memory|Show HN: Durable memory for long-running coding agents>*',
  '`CODING AGENTS`  ▲ 34 points  ·  12 comments  ·  Show HN',
  'Relevant to agent builders: Show HN: Durable memory for long-running coding agents',
  '<https://news.ycombinator.com/item?id=1002|HN discussion>  ·  example.com',
  '',
  '*3 · <https://example.com/agent-handoffs|A protocol for multi-agent coordination and handoffs>*',
  '`AGENT COORDINATION`  ▲ 18 points  ·  7 comments  ·  New',
  'Relevant to agent builders: A protocol for multi-agent coordination and handoffs',
  '<https://news.ycombinator.com/item?id=1003|HN discussion>  ·  example.com',
  '',
  '_Want the deeper read? Reply in this thread and @mention me with a story number or title for live details and top HN comments._',
].join('\n');

export function validateWritesDenyEvidence({ exitStatus, runRecord, sentinelCounts }) {
  const errors = [];
  const actions = Array.isArray(runRecord?.actions) ? runRecord.actions : [];
  const deniedWrites = actions.filter((action) => isWriteAction(action) && action.status === 'denied');
  const escapedWrites = actions.filter((action) => isWriteAction(action) && action.status !== 'denied');
  const deniedKinds = [...new Set(deniedWrites.map((action) => action.kind))];
  const sentinelRequests = Array.isArray(sentinelCounts?.requests) ? sentinelCounts.requests : [];

  if (!Number.isInteger(exitStatus) || exitStatus === 0) errors.push('invoke must exit nonzero');
  if (runRecord?.status !== 'failed') errors.push('RunRecord status must be failed');
  if (runRecord?.policy?.writes !== 'deny') errors.push('RunRecord policy.writes must be deny');
  if (deniedWrites.length === 0) errors.push('at least one required write must be recorded as denied');
  if (!deniedKinds.includes('provider.write')) errors.push('the real HN Slack provider write must be denied');
  if (escapedWrites.length > 0) errors.push(`write actions escaped denial: ${escapedWrites.map(describeAction).join(', ')}`);
  if (containsKey(runRecord, 'simulatedReceipt')) errors.push('denied RunRecord must contain zero simulated receipts');
  if (hasStateMutations(runRecord?.stateDiff)) errors.push('denied RunRecord must contain zero state mutations');
  if (sentinelRequests.length !== 0) errors.push(`write sentinel received ${sentinelRequests.length} request(s)`);

  return {
    ok: errors.length === 0,
    errors,
    deniedWriteCount: deniedWrites.length,
    deniedKinds,
    escapedWriteCount: escapedWrites.length,
    sentinelRequestCount: sentinelRequests.length,
  };
}

export function validateHumanSlackTrace({ humanOutput, runRecord, channel = 'C123' }) {
  const errors = [];
  const text = typeof humanOutput === 'string' ? humanOutput : '';
  const actions = Array.isArray(runRecord?.actions) ? runRecord.actions : [];
  const slackWrites = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.kind === 'provider.write' && action.provider === 'slack');
  const parent = slackWrites.find(({ action }) => !action.data?.body?.parentRef);
  const reply = slackWrites.find(({ action }) => typeof action.data?.body?.parentRef === 'string');

  if (slackWrites.length !== 2) errors.push(`expected exactly two Slack writes, received ${slackWrites.length}`);
  if (!parent) errors.push('missing Slack parent action');
  if (!reply) errors.push('missing Slack threaded reply action');
  if (!parent || !reply) return { ok: false, errors, parentText: null, replyText: null };

  const parentText = parent.action.data?.body?.text;
  const replyText = reply.action.data?.body?.text;
  const parentPath = parent.action.data?.path;
  const parentReceipt = parent.action.data?.simulatedReceipt?.id;
  const replyParentRef = reply.action.data?.body?.parentRef;
  const replyThreadTs = reply.action.data?.body?.thread_ts;
  const parentSection = humanActionSection(text, parent.index + 1);
  const replySection = humanActionSection(text, reply.index + 1);

  if (parent.index >= reply.index) errors.push('Slack parent must precede threaded reply in Run action order');
  if (parentText !== expectedHnSlackParentText) errors.push('RunRecord parent text does not exactly match the deterministic HN snapshot');
  if (replyText !== expectedHnSlackReplyText) errors.push('RunRecord reply text does not exactly match the deterministic HN snapshot');
  if (parent.action.status !== 'previewed' || reply.action.status !== 'previewed') {
    errors.push('Slack parent and reply must both be previewed');
  }
  if (replyParentRef !== parentPath || replyThreadTs !== parentReceipt) {
    errors.push('Slack reply linkage must reference the exact preview parent path and receipt');
  }
  requireSection(parentSection, 'slack message: parent', 'parent classification', errors);
  requireSection(parentSection, `channel: ${channel}`, 'parent channel', errors);
  requireSection(parentSection, `text (exact): ${JSON.stringify(expectedHnSlackParentText)}`, 'exact parent text snapshot', errors);
  requireSection(replySection, 'slack message: reply', 'reply classification', errors);
  requireSection(replySection, `channel: ${channel}`, 'reply channel', errors);
  requireSection(replySection, `text (exact): ${JSON.stringify(expectedHnSlackReplyText)}`, 'exact reply text snapshot', errors);
  requireSection(replySection, `parentRef=${replyParentRef}`, 'reply parent reference', errors);
  requireSection(replySection, `thread_ts=${replyThreadTs}`, 'reply thread timestamp', errors);
  if (!text.startsWith('preview: ')) errors.push('standard human summary header is missing');

  return {
    ok: errors.length === 0,
    errors,
    parentText: typeof parentText === 'string' ? parentText : null,
    replyText: typeof replyText === 'string' ? replyText : null,
    channel,
    parentRef: typeof replyParentRef === 'string' ? replyParentRef : null,
    threadTs: typeof replyThreadTs === 'string' ? replyThreadTs : null,
    parentActionSequence: parent.index + 1,
    replyActionSequence: reply.index + 1,
  };
}

export function validateSingleProviderReadEvidence(runRecord) {
  const errors = [];
  const actions = (runRecord?.actions ?? []).filter((entry) => entry.kind === 'provider.read');
  const spans = (runRecord?.trace ?? []).filter((entry) => entry.kind === 'provider.read');
  if (actions.length !== 1) errors.push(`expected exactly one provider.read action, received ${actions.length}`);
  if (spans.length !== 1) errors.push(`expected exactly one provider.read trace span, received ${spans.length}`);

  const action = actions[0];
  const span = spans[0];
  if (action && (action.provider !== 'slack' || action.resource !== 'messages')) {
    errors.push('provider.read action must be the authored Slack messages read');
  }
  if (action && (
    action.status !== 'previewed' ||
    action.data?.operation !== 'list' ||
    action.data?.parameters?.channelId !== 'C123' ||
    action.data?.path !== '/slack/channels/C123/messages'
  )) {
    errors.push('provider.read action must contain the exact previewed Slack messages list operation');
  }
  if (span && (
    span.data?.operation !== 'list' ||
    span.data?.parameters?.channelId !== 'C123' ||
    span.data?.path !== action?.data?.path
  )) {
    errors.push('provider.read trace span must match the authored Slack messages list read');
  }

  return {
    ok: errors.length === 0,
    errors,
    actionCount: actions.length,
    traceSpanCount: spans.length,
  };
}

export function validateCloudComposioVitestEvidence({ exitStatus, output }) {
  const errors = [];
  const text = typeof output === 'string' ? output : '';
  if (exitStatus !== 0) errors.push(`Cloud Composio integration exited ${exitStatus}`);
  if (!text.includes('route.integration.test.ts')) errors.push('dedicated Composio route integration file did not execute');
  if (!text.includes(cloudComposioIntegrationTitle)) errors.push('stable non-vacuous Composio integration title is missing');
  if (!/(?:✓|PASS|passed)/u.test(text)) errors.push('verbose Vitest output contains no passing-test marker');

  const markerMatches = [...text.matchAll(/COMPOSIO_CLOSURE_EVIDENCE=(\{[^\r\n]*\})/gu)];
  if (markerMatches.length !== 1) {
    errors.push(`expected exactly one ${cloudComposioEvidenceMarker} marker, received ${markerMatches.length}`);
    return { ok: false, errors, evidence: null };
  }

  let evidence;
  try {
    evidence = JSON.parse(markerMatches[0][1]);
  } catch (error) {
    errors.push(`Composio closure evidence marker is malformed JSON: ${String(error)}`);
    return { ok: false, errors, evidence: null };
  }

  const eventId = evidence?.event?.id;
  requireValue(evidence?.schemaVersion === 1, 'evidence schemaVersion must equal 1', errors);
  requireValue(evidence?.first?.httpStatus === 200, 'first response status must equal 200', errors);
  requireValue(evidence?.first?.accepted === true, 'first response must be accepted', errors);
  requireValue(['unmatched', 'completed'].includes(evidence?.first?.state), 'first receiver state must be unmatched or completed', errors);
  requireValue(evidence?.duplicate?.httpStatus === 200, 'duplicate response status must equal 200', errors);
  requireValue(evidence?.duplicate?.accepted === true, 'duplicate response must be accepted', errors);
  requireValue(evidence?.duplicate?.state === 'duplicate', 'second receiver state must be duplicate', errors);
  requireValue(typeof eventId === 'string' && eventId.length > 0, 'receiver-generated event id must be nonempty', errors);
  requireValue(evidence?.duplicate?.duplicateOf === eventId, 'duplicate response must reference the first event id', errors);

  requireValue(evidence?.event?.type === 'composio.trigger.message', 'canonical Event type is wrong', errors);
  requireValue(evidence?.event?.contractVersion === 1, 'canonical Event contractVersion must equal 1', errors);
  requireValue(evidence?.event?.workspaceId === '11111111-1111-4111-8111-111111111111', 'canonical Event workspace is not the persisted workspace UUID', errors);
  requireValue(evidence?.event?.resource?.provider === 'composio', 'canonical resource provider must be composio', errors);
  requireValue(evidence?.event?.resource?.kind === 'composio.trigger', 'canonical resource kind must be composio.trigger', errors);
  requireValue(evidence?.event?.resource?.id === 'ti_github_123', 'canonical resource id is wrong', errors);
  requireValue(evidence?.event?.resource?.path === '/composio/triggers/ti_github_123', 'canonical resource path is wrong', errors);
  requireValue(evidence?.event?.occurredAt === '2026-07-16T01:00:00.000Z', 'canonical occurredAt is wrong', errors);
  requireValue(evidence?.event?.deliveryId === 'msg_composio_123', 'canonical delivery id is wrong', errors);
  requireValue(evidence?.event?.payloadDeliveryId === evidence?.event?.deliveryId, 'canonical payload must retain the delivery id', errors);
  requireValue(evidence?.event?.payloadConnectionId === 'ca_composio_123', 'canonical payload must retain connected_account_id', errors);

  requireValue(evidence?.identity?.workspaceIntegrationId === '33333333-3333-4333-8333-333333333333', 'persisted workspace integration id is wrong', errors);
  requireValue(evidence?.identity?.workspaceId === evidence?.event?.workspaceId, 'persisted identity workspace must equal canonical Event workspace', errors);
  requireValue(evidence?.identity?.provider === 'github', 'persisted semantic provider must be github', errors);
  requireValue(evidence?.identity?.connectedAccountId === evidence?.event?.payloadConnectionId, 'persisted connection must equal the payload connected account', errors);
  requireValue(evidence?.identity?.backend === 'composio', 'persisted identity backend must be composio', errors);

  requireValue(evidence?.dedupe?.first === 'claimed', 'first ledger delivery must own the dedupe claim', errors);
  requireValue(evidence?.dedupe?.second === 'duplicate', 'second ledger delivery must be duplicate', errors);
  requireValue(evidence?.dedupe?.duplicateOf === eventId, 'ledger duplicate must reference the first event id', errors);
  requireValue(equalStringArrays(evidence?.trace?.first, expectedFirstComposioTrace), 'first trace milestones are missing or out of order', errors);
  requireValue(equalStringArrays(evidence?.trace?.second, expectedDuplicateComposioTrace), 'duplicate trace milestones are missing or out of order', errors);
  requireValue(evidence?.dispatchCount === 1, 'production dispatcher must be reached exactly once', errors);

  return { ok: errors.length === 0, errors, evidence };
}

function isWriteAction(action) {
  if (!action || typeof action.kind !== 'string') return false;
  return writeKinds.has(action.kind) || action.kind.endsWith('.write');
}

function describeAction(action) {
  return `${action.kind}:${action.status ?? 'missing-status'}`;
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([entryKey, entryValue]) => entryKey === key || containsKey(entryValue, key));
}

function hasStateMutations(stateDiff) {
  if (!stateDiff || typeof stateDiff !== 'object') return false;
  return Object.values(stateDiff).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== undefined && value !== null && value !== false && value !== 0 && value !== '';
  });
}

function humanActionSection(output, sequence) {
  const marker = `      ${String(sequence).padStart(2, '0')}.`;
  const start = output.indexOf(marker);
  if (start < 0) return '';
  const next = output.indexOf(`\n      ${String(sequence + 1).padStart(2, '0')}.`, start + marker.length);
  return output.slice(start, next < 0 ? output.length : next);
}

function requireSection(section, expected, label, errors) {
  if (!section.includes(expected)) errors.push(`human output is missing ${label}`);
}

function requireValue(condition, message, errors) {
  if (!condition) errors.push(message);
}

function equalStringArrays(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
