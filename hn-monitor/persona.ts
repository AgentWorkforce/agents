import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Hacker News Monitor — scans HN a few times a day for the topics you care
 * about and posts a digest to Slack, Telegram, or both. Configuration-driven:
 * set SLACK_CHANNEL, TELEGRAM_CHAT, or both — the handler delivers to
 * whichever targets are configured.
 *
 * Retains ~30 days of digests; DM the agent (relay inbox) or message it on
 * Telegram to ask about recently posted stories.
 */
export default definePersona({
  id: 'hn-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Scans Hacker News a few times a day for topics you care about and posts a digest to Slack, Telegram, or both. Retains the last ~30 days of digests — DM the agent or message it on Telegram to ask about what it recently posted.',
  cloud: true,

  // Optional integrations (workforce#252): each transport is `optional` and gated
  // by `enabledByInput`, so its provider connection + trigger registration happen
  // ONLY when the matching id input is set. Set SLACK_CHANNEL, TELEGRAM_CHAT, or
  // both — a Slack-only deploy never has to wire up a Telegram bot, and vice
  // versa. The handler delivers to whichever targets are configured.
  integrations: {
    slack: {
      optional: true,
      enabledByInput: 'SLACK_CHANNEL',
      scope: { paths: '/slack/channels/**' }
    },
    telegram: {
      optional: true,
      enabledByInput: 'TELEGRAM_CHAT',
      scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' }
    }
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
    },
    TELEGRAM_CHAT: {
      description: 'Telegram chat id to post the digest to (and answer Q&A in). Leave empty to skip Telegram delivery.',
      env: 'TELEGRAM_CHAT',
      optional: true
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
