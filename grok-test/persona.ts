import { definePersona } from '@agentworkforce/persona-kit';

/**
 * grok-test — minimal persona for verifying the Grok/xAI browser subscription
 * connect flow in the deploy wizard. No required integrations or inputs, so
 * the wizard reaches the "Connect model" step immediately. Not intended for
 * real deployment — this is a throwaway persona for manual dev-environment
 * vetting only.
 */
export default definePersona({
  id: 'grok-test',
  intent: 'test',
  tags: ['test'],
  description: 'Minimal test persona for verifying the Grok/xAI browser subscription connect flow.',
  cloud: true,

  useSubscription: true,
  harness: 'grok',
  model: 'xai/grok-4.1',
  systemPrompt: 'You are a test agent used only to verify the Grok subscription connect flow.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },

  integrations: {},

  onEvent: './agent.ts'
});
