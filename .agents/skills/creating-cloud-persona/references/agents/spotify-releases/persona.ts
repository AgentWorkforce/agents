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

  integrations: {
    // No slack trigger here (cron-only persona), so `scope` is the only
    // thing that mounts /slack. DMs write to /slack/users/{userId}/messages,
    // a different subtree than channel posts.
    slack: { scope: { paths: '/slack/users/**' } }
  },

  inputs: {
    SLACK_USER: {
      description: 'Your Slack user id — releases are DMed here.',
      env: 'SLACK_USER',
      picker: { provider: 'slack', resource: 'users' }
    },
    SPOTIFY_TOKEN: { description: 'Spotify OAuth token with the user-follow-read scope.', env: 'SPOTIFY_TOKEN' }
  },

  // Pure fetch + DM — no model needed.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 120 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
