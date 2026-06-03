import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Hacker News Monitor — scans HN a few times a day for the topics you care
 * about and posts a short digest to Slack.
 */
export default definePersona({
  id: 'hn-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Scans Hacker News a few times a day for topics you care about and posts a summary to Slack.',
  cloud: true,

  // `slack` gives the handler the ctx.slack client to post the digest.
  integrations: { slack: {} },

  inputs: {
    TOPICS: {
      description: 'Comma-separated keywords to watch for (matched against story titles).',
      env: 'TOPICS',
      default: 'agents,ai,typescript,developer tools'
    },
    SLACK_CHANNEL: {
      description: 'Slack channel id to post the digest to.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    }
  },

  // ctx.llm uses this model to summarize the matching stories.
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Summarize Hacker News stories into a short, skimmable Slack digest.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 120 },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 7 },

  onEvent: './agent.ts'
});
