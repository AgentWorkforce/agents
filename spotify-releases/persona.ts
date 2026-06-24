import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Spotify Releases — checks daily for new releases from artists you follow and
 * messages you about them over Slack, Telegram, or both. Cron-only (no chat
 * surface); pure fetch + deliver, no model needed.
 *
 * Optional integrations (workforce#252): `slack` and `telegram` are each
 * `optional: true` and gated by `enabledByInput`. Slack delivery is a DM to
 * SLACK_USER (writeback to /slack/users/**); Telegram delivery is a message to
 * TELEGRAM_CHAT. Set either input (or both) — the unconfigured transport's
 * connection is pruned at deploy, so a Slack-only deploy never wires up Telegram.
 */
export default definePersona({
  id: 'spotify-releases',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Checks daily for new releases from artists you follow on Spotify and messages you on Slack, Telegram, or both.',
  cloud: true,

  integrations: {
    // No slack trigger here (cron-only persona), so `scope` is the only thing
    // that mounts /slack. DMs write to /slack/users/{userId}/messages, a
    // different subtree than channel posts. Gated on SLACK_USER (workforce#252).
    slack: {
      optional: true,
      enabledByInput: 'SLACK_USER',
      scope: { paths: '/slack/users/**' }
    },
    // Cron-only (no telegram trigger), so `scope` is the only thing that mounts
    // /telegram. Scope the concrete chats subtree (NOT `/telegram/**` — the cloud
    // mount drops provider-root globs) so the writeback path mounts. Gated on
    // TELEGRAM_CHAT.
    telegram: {
      optional: true,
      enabledByInput: 'TELEGRAM_CHAT',
      scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' }
    }
  },

  inputs: {
    SLACK_USER: {
      description: 'Your Slack user id — releases are DMed here. Leave empty to skip Slack delivery.',
      env: 'SLACK_USER',
      optional: true,
      picker: { provider: 'slack', resource: 'users' }
    },
    TELEGRAM_CHAT: {
      description: 'Telegram chat id — releases are sent here. Leave empty to skip Telegram delivery. No chat picker exists yet; enter the numeric chat id.',
      env: 'TELEGRAM_CHAT',
      optional: true
    },
    SPOTIFY_TOKEN: { description: 'Spotify OAuth token with the user-follow-read scope.', env: 'SPOTIFY_TOKEN' }
  },

  // Pure fetch + deliver — no model needed.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 600 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
