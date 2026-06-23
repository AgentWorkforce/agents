import { definePersona } from '@agentworkforce/persona-kit';

const enableTelegram = process.env.HN_MONITOR_ENABLE_TELEGRAM === '1';

/**
 * Hacker News Monitor — scans HN a few times a day for the topics you care
 * about and posts a digest to Slack, Telegram, or both. Configuration-driven:
 * set SLACK_CHANNEL for Slack. To deploy with Telegram triggers/mounts too,
 * set HN_MONITOR_ENABLE_TELEGRAM=1 during deploy and pass TELEGRAM_CHAT.
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

  integrations: {
    slack: { scope: { paths: '/slack/channels/**' } },
    ...(enableTelegram
      ? { telegram: { scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' } } }
      : {})
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
    ...(enableTelegram
      ? {
          TELEGRAM_CHAT: {
            description: 'Telegram chat id to post the digest to (and answer Q&A in).',
            env: 'TELEGRAM_CHAT'
          }
        }
      : {})
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
