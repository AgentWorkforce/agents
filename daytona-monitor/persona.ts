import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Daytona Monitor — watches your Daytona organization's usage quotas and
 * sandbox allocations, and posts a Slack alert when (and only when) something
 * needs attention: a quota nearing its limit, a sandbox stuck in ERROR, a
 * long-running ("stale") sandbox burning cost, or a sudden allocation jump.
 *
 * Notification-only / proactive: it never starts, stops, or deletes anything.
 */
export default definePersona({
  id: 'daytona-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    "Watches your Daytona org's usage quotas + sandbox allocations and posts a Slack alert when a quota nears its limit, a sandbox errors, or a sandbox runs stale.",
  cloud: true,

  integrations: {
    // Two daytona subtrees:
    //   • usage     — org quota/usage the adapter polls hourly into
    //                 /daytona/usage/<orgId>.json; the agent reads it from the
    //                 mount (no token), falling back to the REST API while the
    //                 adapter's usage sync is still rolling out.
    //   • sandboxes — read mirror at /daytona/sandboxes/** backing the
    //                 sandbox-lifecycle webhooks (sandbox.created /
    //                 sandbox.state.updated) the triggers in agent.ts wake on.
    daytona: { scope: { usage: '/daytona/usage/**', sandboxes: '/daytona/sandboxes/**' } },
    // No slack trigger here, so `scope` is the only thing that mounts /slack —
    // without it every post is a silent no-op.
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    SLACK_CHANNEL: { description: 'Team Slack channel id to post alerts to.', env: 'SLACK_CHANNEL' },
    DAYTONA_ORG_ID: {
      description: 'Daytona organization id to monitor.',
      env: 'DAYTONA_ORG_ID',
      default: 'd9efb08e-7f53-4fe0-b37e-d1a281622bc0'
    },
    QUOTA_ALERT_PCT: {
      description: 'Alert when CPU/memory/disk usage reaches this percent of quota.',
      env: 'QUOTA_ALERT_PCT',
      default: '80'
    },
    STALE_HOURS: {
      description: 'Alert when a STARTED sandbox has been running longer than this many hours.',
      env: 'STALE_HOURS',
      default: '12'
    }
  },

  // Pure threshold-diff + post — no model needed.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 120 },
  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  onEvent: './agent.ts'
});
