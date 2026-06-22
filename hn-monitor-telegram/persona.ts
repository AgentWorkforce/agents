import { definePersona } from '@agentworkforce/persona-kit';

/**
 * hn-monitor-telegram — the Telegram sibling of hn-monitor. Scans Hacker News a
 * few times a day for the topics you care about and posts a digest to a Telegram
 * chat, threaded under a compact count header (native Telegram reply-to). Retains
 * ~30 days of digests; message the bot on Telegram to ask about recent posts.
 *
 * Catalog note: telegram trigger/scope catalogs are a pending cutover
 * (relayfile-adapters#222 / workforce#249); persona-kit accepts `telegram` via
 * its provider index-signature fallback today.
 */
export default definePersona({
  id: 'hn-monitor-telegram',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Scans Hacker News a few times a day for topics you care about and posts a digest to Telegram, threaded under a count header. Retains the last ~30 days of digests — message the bot to ask about what it recently posted.',
  cloud: true,

  integrations: {
    // Telegram is both the digest surface and the Q&A surface. Scope the concrete
    // chats subtree (NOT `/telegram/**` — the cloud mount drops provider-root
    // globs) so the writeback path mounts (else every post is a silent no-op).
    telegram: { scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' } }
  },

  inputs: {
    TOPICS: {
      description: 'Comma-separated keywords to watch for (matched against story titles).',
      env: 'TOPICS',
      default: 'agents,ai,typescript,developer tools'
    },
    TELEGRAM_CHAT: {
      description: 'Telegram chat id to post the digest to (and answer Q&A in). No chat picker exists yet; enter the numeric chat id.',
      env: 'TELEGRAM_CHAT'
    }
  },

  // ctx.llm summarizes matches + answers the Q&A path. useSubscription is the
  // standing consent that lets cloud resolve the deployer's anthropic credential.
  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Summarize Hacker News stories into a short, skimmable digest.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 1800 },

  // 30-day retention gives the rolling window of posted digests for the Q&A path.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
