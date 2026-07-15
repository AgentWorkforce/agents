import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'review-agent',
  intent: 'review',
  tags: ['review'],
  description:
    'Reviews opened PRs, responds to @mentions in comments, attempts autofix on red CI.',
  cloud: true,
  useSubscription: true,
  // Connection config only — which events fire this agent lives in agent.ts
  // (defineAgent). The persona just declares which providers it connects to.
  integrations: {
    github: {},
    slack: {}
  },
  memory: {
    enabled: true,
    scopes: ['workspace']
  },
  onEvent: './agent.ts',
  harness: 'codex',
  model: 'gpt-5.4',
  systemPrompt:
    'Review pull requests for correctness, regression risk, security concerns, and missing tests. Be concise and concrete.',
  harnessSettings: {
    reasoning: 'medium',
    timeoutSeconds: 1200,
    sandboxMode: 'workspace-write',
    workspaceWriteNetworkAccess: true
  }
});
