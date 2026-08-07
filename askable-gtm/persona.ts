import { definePersona } from '@agentworkforce/persona-kit';
import { ASKABLE_GTM_CAPABILITY } from './capabilities.js';

/**
 * GTM Signal Scout — an askable, fail-closed prototype for public market
 * signals. It never accepts a provider key or endpoint as a persona input.
 * Cloud must provide a secretless Nango action bridge before Listen can run.
 */
export default definePersona({
  id: 'askable-gtm',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Answers questions about public GTM signals, advertises its capabilities as machine-readable data, and turns relay watch requests into durable definitions evaluated by one recurring sweep. Live Revternal results remain blocked until Cloud provides a secretless Nango action bridge.',
  cloud: true,

  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  capabilities: {
    askable: ASKABLE_GTM_CAPABILITY,
  },

  onEvent: './agent.ts',
});
