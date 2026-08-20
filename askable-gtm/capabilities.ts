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
    identicalRequestCache: '15m-documented-unverified',
    liveResultVerification: 'not-yet-live-verified',
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
    'Only Reddit is documented as currently registered.',
    'No full comments, contact data, employer/title, or qualification evidence.',
    'Per-watch recurrence is evaluated by one deploy-time sweep, not a dynamic Relaycron recurrence.',
    'Watch definitions use Relayfile revision compare-and-set updates and a pre-delivery run claim.',
    'Relay DM has no idempotency-key input, so a process crash after delivery but before final state commit can cause a duplicate after claim-lease recovery.',
  ],
} as const;

export type AskableGtmCapability = typeof ASKABLE_GTM_CAPABILITY;
