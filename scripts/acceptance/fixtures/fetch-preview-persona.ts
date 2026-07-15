import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'fetch-preview-persona',
  intent: 'e2e-validation',
  tags: ['testing'],
  description: 'Acceptance-only persona for exercising local fetch policy preview behavior.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Run the acceptance fetch preview probe and record what the runtime allows or blocks.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  capabilities: {
    httpRead: {
      allow: [{ method: 'GET', urlGlob: 'http://127.0.0.1:*/allowed-get' }],
    },
  },
  inputs: {
    ALLOWED_GET_URL: {
      env: 'ALLOWED_GET_URL',
      description: 'Local sentinel URL that should be reachable via GET.',
    },
    DENIED_POST_URL: {
      env: 'DENIED_POST_URL',
      description: 'Local sentinel URL that should not receive live POSTs.',
    },
    UNDECLARED_GET_URL: {
      env: 'UNDECLARED_GET_URL',
      description: 'Local sentinel URL that must NOT be reachable (not in httpRead allow list).',
    },
  },
  onEvent: './fetch-preview-agent.ts',
});
