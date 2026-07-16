import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'replay-bundle-persona',
  intent: 'e2e-validation',
  tags: ['testing'],
  description: 'Acceptance-only persona for proving Cloud replay bundles can be consumed by Workforce local invoke.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Consume the supplied replay bundle and record the replay provenance in the local preview trace.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 1 },
  onEvent: './replay-bundle-agent.ts',
});
