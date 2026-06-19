import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Vendor Monitor — watches the vendors in your stack for new releases and posts
 * changes to your team Slack channel.
 */
export default definePersona({
  id: 'vendor-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Watches the vendors in your stack for new releases and posts the changes to your team Slack channel.',
  cloud: true,

  integrations: {
    // No slack trigger here (cron-only persona), so `scope` is the only
    // thing that mounts /slack — without it every post is a silent no-op.
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    VENDORS: {
      description: 'Comma-separated npm packages to watch (e.g. "next,react,@daytonaio/sdk").',
      env: 'VENDORS',
      default: 'next,react,typescript'
    },
    SLACK_CHANNEL: { description: 'Team Slack channel id to post changes to.', env: 'SLACK_CHANNEL' }
  },

  // Pure version-diff + post — no model needed.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 600 },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  onEvent: './agent.ts'
});
