import { definePersona } from '@agentworkforce/persona-kit';

/**
 * spotify-releases-telegram — the Telegram sibling of spotify-releases. Checks
 * daily for new releases from artists you follow on Spotify and messages you on
 * Telegram instead of Slack.
 *
 * Catalog note: telegram trigger/scope catalogs are a pending cutover
 * (relayfile-adapters#222 / workforce#249); persona-kit accepts `telegram` via
 * its provider index-signature fallback today.
 */
export default definePersona({
  id: 'spotify-releases-telegram',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Checks daily for new releases from artists you follow on Spotify and messages you on Telegram about them.',
  cloud: true,

  integrations: {
    // Cron-only persona (no telegram trigger), so `scope` is the only thing that
    // mounts /telegram. Scope the concrete chats subtree (NOT `/telegram/**` —
    // the cloud mount drops provider-root globs) so the writeback path mounts.
    telegram: { scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' } }
  },

  inputs: {
    TELEGRAM_CHAT: {
      description: 'Telegram chat id — releases are sent here. No chat picker exists yet; enter the numeric chat id.',
      env: 'TELEGRAM_CHAT'
    },
    SPOTIFY_TOKEN: { description: 'Spotify OAuth token with the user-follow-read scope.', env: 'SPOTIFY_TOKEN' }
  },

  // Pure fetch + message — no model needed.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 600 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
