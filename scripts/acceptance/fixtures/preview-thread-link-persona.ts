import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'preview-thread-link-persona',
  intent: 'e2e-validation',
  tags: ['testing'],
  description: 'Acceptance-only persona for proving preview thread refs survive across separate local invoke workers.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Exercise preview Slack parent/thread continuity across two separate local invoke turns.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 60 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 1 },
  inputs: {
    SLACK_CHANNEL: {
      env: 'SLACK_CHANNEL',
      description: 'Preview Slack channel id for acceptance thread-link validation.',
    },
  },
  onEvent: './preview-thread-link-agent.ts',
});
