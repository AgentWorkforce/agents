import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Spotify Releases — checks daily for new releases from artists you follow and
 * DMs you about them.
 */
export default definePersona({
  id: 'spotify-releases',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Checks daily for new releases from artists you follow on Spotify and DMs you about them.',
  cloud: true,

  schedules: [{ name: 'check', cron: '0 10 * * *', tz: 'America/New_York' }],
  integrations: { slack: {} },

  inputs: {
    SLACK_USER: { description: 'Your Slack user id — releases are DMed here.', env: 'SLACK_USER' },
    SPOTIFY_TOKEN: { description: 'Spotify OAuth token with the user-follow-read scope.', env: 'SPOTIFY_TOKEN' }
  },

  // Pure fetch + DM — no model needed.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 120 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
