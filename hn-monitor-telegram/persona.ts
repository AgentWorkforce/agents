import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Hacker News Monitor for Telegram — scans HN a few times a day for the topics
 * you care about and posts a digest to Telegram. The agent also replies to
 * Telegram messages with answers grounded in recently posted digests.
 */
export default definePersona({
  id: 'hn-monitor-telegram',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Scans Hacker News a few times a day for topics you care about and posts a digest to Telegram. Retains the last ~30 days of digests, so you can message the bot to ask about what it recently posted.',
  cloud: true,

  integrations: {
    telegram: { scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' } }
  },

  inputs: {
    TOPICS: {
      description: 'Comma-separated keywords to watch for (matched against story titles).',
      env: 'TOPICS',
      default: 'agents,ai,typescript,developer tools'
    },
    TELEGRAM_CHAT: {
      description: 'Telegram chat id to post the digest to and answer Q&A in.',
      env: 'TELEGRAM_CHAT'
    }
  },

  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Summarize Hacker News stories into a short, skimmable digest.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 1800 },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
