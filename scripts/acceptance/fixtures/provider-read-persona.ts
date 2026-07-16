import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'acceptance-provider-read',
  intent: 'e2e-validation',
  tags: ['testing'],
  description: 'Acceptance-only persona proving one Relayfile read records one action and trace span.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Perform exactly one deterministic Slack provider read.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  onEvent: './provider-read-agent.ts',
});
