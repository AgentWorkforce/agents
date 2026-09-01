import { definePersona } from '@agentworkforce/persona-kit';
import { ASKABLE_GTM_CAPABILITY } from './capabilities.js';

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
