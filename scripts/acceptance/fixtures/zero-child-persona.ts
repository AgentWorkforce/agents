import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'zero-child-persona',
  intent: 'e2e-validation',
  tags: ['testing'],
  description: 'Acceptance-only persona for proving local preview does not launch child runs or shell execution.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Run the acceptance zero-child probe and record the simulated preview actions.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  onEvent: './zero-child-agent.ts',
});
