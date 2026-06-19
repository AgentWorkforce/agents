import { definePersona } from '@agentworkforce/persona-kit';

/**
 * GCP Watcher — watches your GCP project's Cloud Run services, Monitoring alert
 * policies, and billing/cost, and posts a Slack alert when (and only when)
 * something needs attention: a Cloud Run service whose latest revision isn't
 * Ready, a firing Monitoring alert, or spend crossing a threshold.
 *
 * Notification-only / proactive: it never mutates GCP.
 *
 * BASIC (free) tier: reads ONLY the relayfile VFS mounts materialized by
 * @relayfile/adapter-gcp (via the gcp-relay Nango integration). It does NOT
 * query BigQuery — deeper OTel/historical analysis is the paid tier that lives
 * inside nightcto and is gated for paying customers.
 */
export default definePersona({
  id: 'gcp-watcher',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    "Watches your GCP project's Cloud Run services, Monitoring alerts, and billing via the relayfile VFS and posts a Slack alert when a service is unhealthy, an alert fires, or spend crosses a threshold. Can also answer questions about current GCP state via relay inbox.",
  cloud: true,

  harness: 'opencode',
  model: 'deepseek-v4-flash-free',
  systemPrompt:
    'You are a GCP infrastructure monitor. Answer questions about the current GCP project state (Cloud Run services, Monitoring alerts, billing) concisely using Slack markdown. When no question is asked, summarize any active alerts.',

  integrations: {
    // GCP state materialized into the VFS by @relayfile/adapter-gcp:
    //   • run        — Cloud Run services      /gcp/run/services/**
    //   • monitoring — alert policies/incidents /gcp/monitoring/alerts/**
    //   • billing    — current cost/FinOps      /gcp/billing/**
    // The agent reads these from the mount (no GCP token); auth lives in the
    // gcp-relay Nango connection that feeds the adapter.
    gcp: {
      scope: {
        run: '/gcp/run/**',
        monitoring: '/gcp/monitoring/**',
        billing: '/gcp/billing/**'
      }
    },
    // No slack trigger here, so `scope` is the only thing that mounts /slack —
    // without it every post is a silent no-op.
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Team Slack channel id to post alerts to.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    },
    GCP_PROJECT_ID: {
      description: 'GCP project id to monitor.',
      env: 'GCP_PROJECT_ID',
      default: 'nightcto-production'
    },
    BILLING_ALERT_USD: {
      description: 'Alert when current-period spend (USD) reaches this amount.',
      env: 'BILLING_ALERT_USD',
      default: '500'
    }
  },

  harnessSettings: { reasoning: 'medium', timeoutSeconds: 600 },
  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  onEvent: './agent.ts'
});
