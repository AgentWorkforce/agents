export type AskableAvailability =
  | 'verified'
  | 'implemented_unverified'
  | 'documented_unverified'
  | 'blocked';

export const ASKABLE_GTM_CAPABILITY = {
  enabled: true,
  schema: 'agentrelay.askable.v1',
  kind: 'gtm-signal-scout',
  status: 'prototype-blocked',
  discovery: {
    human: 'Send “what can you tell me?” over relay.',
    machine: 'Send “capabilities --json” over relay.',
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
      requires: ['server-side Revternal credential bridge', 'authenticated live-result gate'],
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
    operation: 'POST https://api.revternal.com/social/listen',
    authentication: 'required-observed',
    documentedRegisteredSources: ['reddit'],
    identicalRequestCache: '15m-documented-unverified',
    liveResultVerification: 'blocked-op-cli-unavailable',
  },
  credentials: {
    personaInput: false,
    byok: { availability: 'blocked', requires: 'scoped Revternal provider connection and proxy' },
    managed: { availability: 'blocked', requires: 'paid entitlement, metering, hard quota, audit, rotation' },
  },
  limitations: [
    'No successful keyed Listen response was observed during this investigation.',
    'Only Reddit is documented as currently registered.',
    'No full comments, contact data, employer/title, or qualification evidence.',
    'Per-watch recurrence is evaluated by one deploy-time sweep, not a dynamic Relaycron recurrence.',
    'Prototype watch state uses a 90-day workspace-memory snapshot without compare-and-set updates.',
  ],
} as const;

export type AskableGtmCapability = typeof ASKABLE_GTM_CAPABILITY;
