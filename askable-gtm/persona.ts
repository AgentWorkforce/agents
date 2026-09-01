import { definePersona } from '@agentworkforce/persona-kit';

/**
 * The capability manifest lives HERE, not in a sibling module, because the
 * one-click launch page resolves this file statically and builds its constant
 * scope from this file alone — an imported identifier fails the whole resolve
 * (`persona.capabilities.askable uses unsupported dynamic syntax (Identifier)`)
 * and silently degrades the page to demo data. `capabilities.ts` re-exports it
 * so the handler keeps one import site.
 */
export type AskableAvailability =
  | 'verified'
  | 'implemented_unverified'
  | 'documented_unverified'
  | 'blocked';

export const ASKABLE_GTM_CAPABILITY = {
  enabled: true,
  schema: 'agentrelay.askable.v1',
  kind: 'gtm-signal-scout',
  status: 'prototype-gated',
  discovery: {
    human: 'Send “what can you tell me?” in Slack or over relay.',
    machine: 'Send “capabilities --json” in Slack or over relay.',
  },
  operations: [
    {
      id: 'self-describe',
      availability: 'verified',
      accepts: ['what can you tell me?', 'capabilities --json'],
    },
    {
      id: 'manage-watch-definitions',
      availability: 'verified',
      accepts: [
        'watch <query> every <15m|1h|6h|12h|24h|7d>',
        'watches',
        'unwatch <watch-id>',
      ],
      recurrence: {
        mechanism: 'shared-static-sweep',
        sweepCron: '*/15 * * * *',
        perWatchRelaycronSchedule: false,
      },
    },
    {
      id: 'query-public-social-signals',
      availability: 'implemented_unverified',
      requires: ['Connected Revternal workspace integration', 'cloud runtime credentials'],
      implementedPieces: ['bounded query planner', 'evidence renderer', 'cloud-backed secretless gateway contract'],
      evidence: [
        'source URL',
        'source timestamp',
        'public author handle when supplied',
        'community',
        'title/body excerpt',
        'score/comment counts',
        'source coverage and fetched_at',
      ],
      // Both are queried per request and folded into one answer; a source that
      // fails is named in the reply rather than silently omitted.
      sources: ['linkedin'],
    },
  ],
  questions: [
    {
      id: 'competitor-mentions',
      availability: 'documented_unverified',
      example: 'Which high-engagement public posts mention a competitor this week?',
    },
    {
      id: 'objections-and-pain',
      availability: 'documented_unverified',
      example: 'What objections or migration pain recur around this category?',
    },
    {
      id: 'launch-reaction',
      availability: 'documented_unverified',
      example: 'Which communities and public authors are discussing this launch?',
    },
  ],
  watches: [
    'new competitor mentions',
    'new launch reaction',
    'new public posts returned by a saved query',
  ],
  provider: {
    id: 'revternal.listen',
    availability: 'implemented_unverified',
    operation: 'POST /api/v1/workspaces/:workspaceId/integrations/revternal/actions/social-listen',
    endpointSource: 'nango-connection',
    authentication: 'required-observed',
    documentedRegisteredSources: ['reddit'],
    // Registered by the provider, not queried by this persona: their Reddit
    // fetcher scrapes an unauthenticated endpoint and is blocked upstream.
    inUse: false,
    identicalRequestCache: '15m-documented-unverified',
    // Results remain unverified: no real Reddit row has ever come back.
    liveResultVerification: 'not-yet-live-verified',
    // The transport, separately, IS verified — observed 2026-09-01 answering
    // HTTP 200 with credentialSource "user". What fails is upstream of us:
    // Revternal's Reddit fetcher returns "Unexpected status: 403", so every
    // result set is empty for reasons no change here can fix.
    liveTransportVerification: 'verified',
    liveSourceStatus: 'reddit-blocked-upstream',
  },
  secondaryProvider: {
    id: 'revternal.linkedin-post-search',
    availability: 'implemented_unverified',
    operation: 'POST /api/v1/workspaces/:workspaceId/integrations/revternal/actions/linkedin-post-search',
    endpointSource: 'nango-connection',
    authentication: 'required-observed',
    documentedRegisteredSources: ['linkedin'],
    // Same Revternal credential and workspace action gateway as Listen; only
    // the provider capability differs.
    sharesCredentialWith: 'revternal.listen',
    liveResultVerification: 'not-yet-live-verified',
    meteredSeparately: 'documented-unverified',
  },
  credentials: {
    personaInput: false,
    canonicalStore: 'nango',
    retrieval: 'single-nango-action',
    userKey: {
      availability: 'implemented_unverified',
      source: 'nango-connection-credential',
      setupPath: '/integrations',
    },
    endpoint: {
      availability: 'implemented_unverified',
      source: 'nango-connection-config',
      disclosedToUser: true,
    },
    managedFallback: {
      availability: 'blocked-no-entitlement-metering',
      source: 'nango-environment-variable',
      variable: 'REVTERNAL_API_KEY',
      endpointVariable: 'REVTERNAL_BASE_URL',
      disclosureRequired: true,
    },
    selection: 'user connection first; managed fallback only after trusted entitlement and quota authorization; otherwise fail closed',
  },
  limitations: [
    'Live result quality with a real keyed workspace connection is not yet verified in this repo.',
    'Live search depends on a connected Revternal workspace integration and cloud runtime credentials.',
    'Managed fallback has no Revternal entitlement, per-workspace meter, or hard quota today.',
    'LinkedIn is the only source queried; Revternal\u2019s Reddit fetcher is blocked upstream and is not used.',
    'LinkedIn results are engagement-shaped (likes/comments) and carry no community field.',
    'No full comments, contact data, employer/title, or qualification evidence.',
    'Per-watch recurrence is evaluated by one deploy-time sweep, not a dynamic Relaycron recurrence.',
    'Watch definitions use Relayfile revision compare-and-set updates and a pre-delivery run claim.',
    'Relay DM has no idempotency-key input, so a process crash after delivery but before final state commit can cause a duplicate after claim-lease recovery.',
  ],
} as const;


/**
 * GTM Signal Scout — an askable prototype for public market signals. It never
 * accepts a provider key or endpoint as a persona input; live queries go
 * through the Cloud workspace integration action route only when that route is
 * available and the workspace has connected Revternal.
 */
export default definePersona({
  id: 'askable-gtm',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Answers questions about public GTM signals in Slack or over relay, advertises its capabilities as machine-readable data, and turns saved watch requests into durable definitions evaluated by one recurring sweep. Live Revternal queries remain blocked unless the Cloud workspace integration action route is available and the workspace has connected Revternal.',
  cloud: true,

  integrations: {
    // The Revternal workspace integration action route owns both provider
    // access and this narrow Relayfile subtree. Keeping the CAS state under the
    // same provider root gives the runtime a scoped durable-write credential
    // without making a key or endpoint a persona input.
    revternal: {
      source: { kind: 'workspace' },
      scope: { paths: '/revternal/_agents/askable-gtm/**' },
    },
    // Human chat surface. The trigger itself mirrors the configured channel
    // read-only, but slackClient() writes to the canonical bare-id subtree, so
    // a non-empty scope is still required or replies become a silent no-op.
    slack: {
      optional: true,
      enabledByInput: 'SLACK_CHANNEL',
      scope: { paths: '/slack/channels/**' },
    },
  },

  // Same shape as hn-monitor, which this persona was built from: a light relay
  // conversation surface, so the cheapest claude tier rather than a reasoning
  // model. Without a harness/model/systemPrompt the persona is not launchable —
  // persona-registry rejects it as an incomplete standalone persona, so
  // `agentworkforce agent askable-gtm` could never open a seat in it.
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: [
    'You are GTM Signal Scout: you answer questions about PUBLIC go-to-market signals in Slack or over relay, and you describe your own capabilities as machine-readable data.',
    'Live public-signal search uses the Cloud workspace integration action route when that route is available and the workspace has connected Revternal. If the current runtime cannot reach the cloud gateway or the workspace has not connected Revternal, say so plainly and point them at "capabilities --json" for the exact status. Never fill the gap with a plausible answer.',
    // Kept in step with `capabilities.askable` by a test rather than derived
    // here: the launch page resolves this file statically, and a template
    // literal makes the whole persona unreadable to it — including its
    // integrations, so the one-click flow would offer to deploy an agent with
    // no Revternal connection.
    'Every claim about a public post carries its evidence: source URL, source timestamp, the public author handle when one was supplied, community, title/body excerpt, the score and comment counts, and source coverage and fetched_at. A post, handle, number, or date that did not come back from the gateway does not go in an answer.',
    'You never accept, request, or repeat an API key, token, or provider base URL. The only path to access is Workspace Integrations, then Connect Revternal; say that instead of taking a credential.',
    'A watch is a durable query definition evaluated by one shared 15-minute sweep, not a schedule of its own. The commands you honor are "what can you tell me?", "capabilities --json", "watch <query> every <15m|1h|6h|12h|24h|7d>", "watches", and "unwatch <watch-id>".'
  ].join(' '),
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },

  inputs: {
    SLACK_CHANNEL: {
      description:
        'Slack channel id to ask GTM Signal Scout in. Setting it enables the Slack transport and restricts replies to that channel.',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' },
    },
  },

  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  capabilities: {
    askable: ASKABLE_GTM_CAPABILITY,
  },

  onEvent: './agent.ts',
});
