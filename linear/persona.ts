import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'linear-chat-lead',
  intent: 'relay-orchestrator',
  tags: ['implementation', 'planning'],
  description: 'Owns Linear agent-session chat, answers follow-up prompts, and delegates implementation requests to a coding workflow.',
  cloud: true,
  sandbox: false,
  useSubscription: true,
  memory: true,

  integrations: {
    linear: {},
  },

  inputs: {
    // Optional comma-separated aliases for this agent's Linear mention identity.
    // The handler also infers aliases from the deployed agent/persona names.
    MENTION: { description: 'Optional comma-separated Linear mention aliases.', env: 'MENTION', optional: true }
  },

  model: 'gpt-5.5',
  harnessSettings: {
    reasoning: 'low',
    timeoutSeconds: 120
  },

  onEvent: './agent.ts'
});
