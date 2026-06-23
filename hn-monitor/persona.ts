import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Hacker News Monitor — scans HN a few times a day for the topics you care
 * about and posts a digest to Slack. Use ../hn-monitor-telegram/persona.ts
 * for the Telegram deploy target.
 *
 * Retains ~30 days of digests; DM the agent through its relay inbox to ask
 * about recently posted stories.
 */
export default definePersona({
  id: 'hn-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Scans Hacker News a few times a day for topics you care about and posts a digest to Slack. Retains the last ~30 days of digests, so you can DM the agent to ask about what it recently posted.',
  cloud: true,

  integrations: {
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    TOPICS: {
      description: 'Comma-separated keywords to watch for (matched against story titles).',
      env: 'TOPICS',
      default: 'agents,ai,typescript,developer tools'
    },
    SLACK_CHANNEL: {
      description: 'Slack channel id to post the digest to. Leave empty to skip Slack delivery.',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    }
  },

  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Summarize Hacker News stories into a short, skimmable digest.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 1800 },

  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
