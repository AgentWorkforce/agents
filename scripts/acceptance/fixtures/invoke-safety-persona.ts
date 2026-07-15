import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'invoke-safety-persona',
  intent: 'e2e-validation',
  tags: ['testing'],
  description: 'Acceptance-only persona for exercising the local invoke safety boundary.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Run the acceptance safety probe and record what the runtime allows or blocks.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 1 },
  inputs: {
    ALLOWED_GET_URL: {
      env: 'ALLOWED_GET_URL',
      description: 'Local sentinel URL that should be reachable via GET.',
    },
    DENIED_POST_URL: {
      env: 'DENIED_POST_URL',
      description: 'Local sentinel URL that should not receive live POSTs.',
    },
  },
  onEvent: './invoke-safety-agent.ts',
});
