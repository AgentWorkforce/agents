import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Neon Monitor — watches your Neon database organization's infrastructure
 * health and posts a Slack alert when (and only when) something needs
 * attention: failed or repeatedly failing operations, endpoints stuck waking
 * or thrashing suspension cycles, advisor issues at ERROR/WARN severity,
 * compute-unit-second spikes, or a spending limit that is absent or close to
 * its cap.
 *
 * This was purpose-built after the ai-hist pooling incident (2026-06-16) where
 * the CF Worker used WebSocket Neon connections that terminated unexpectedly.
 * An agent like this would have surfaced the repeated start_compute failures
 * before they cascaded into a service outage.
 *
 * Notification-only / proactive: it never mutates Neon.
 *
 * Reads ONLY the relayfile VFS mounts materialized by @relayfile/adapter-neon
 * (via the neon-relay Nango integration). It does NOT query the Neon API
 * directly — auth and polling live in the Nango connection + Relayfile syncs.
 */
export default definePersona({
  id: 'neon-monitor',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    "Watches your Neon database org's operations, endpoint health, advisor issues, and consumption via the relayfile VFS and posts a Slack alert when failures spike, endpoints thrash, advisor issues fire, or spend approaches limits. Can also answer questions about current Neon state via relay inbox.",
  cloud: true,

  harness: 'opencode',
  model: 'deepseek-v4-flash-free',
  systemPrompt:
    'You are a Neon database infrastructure monitor. Answer questions about the current Neon organization state (projects, branches, endpoints, operations, advisor issues, consumption) concisely using Slack markdown. When no question is asked, summarize any active alerts.',

  integrations: {
    // Neon state materialized into the VFS by @relayfile/adapter-neon:
    //   • operations  — recent DB operations   /neon/operations/**
    //   • endpoints   — compute endpoints       /neon/endpoints/**
    //   • advisors    — advisor issue reports    /neon/advisors/**
    //   • consumption — project CU consumption  /neon/consumption/**
    //   • spending    — org spending limits      /neon/spending-limits/**
    //   • projects    — project list             /neon/projects/**
    // The agent reads these from the mount (no Neon token); auth lives in the
    // neon-relay Nango connection that feeds the adapter.
    neon: {
      scope: {
        operations: '/neon/operations/**',
        endpoints: '/neon/endpoints/**',
        advisors: '/neon/advisors/**',
        consumption: '/neon/consumption/**',
        spending: '/neon/spending-limits/**',
        projects: '/neon/projects/**',
        organizations: '/neon/organizations/**',
      }
    },
    // Scope is required for writes — a trigger alone does not mount /slack
    // write paths, and Slack post() silently no-ops without a mounted path.
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Team Slack channel id to post alerts to.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    },
    NEON_ORG_ID: {
      description: 'Neon organization id to monitor (used for spending-limit lookups).',
      env: 'NEON_ORG_ID',
      default: 'org-royal-sea-32807234'
    },
    FAILED_OPS_THRESHOLD: {
      description: 'Alert when the number of failed operations in the last scan exceeds this count.',
      env: 'FAILED_OPS_THRESHOLD',
      default: '3'
    },
    WAKING_ENDPOINTS_THRESHOLD: {
      description: 'Alert when the number of endpoints currently in a waking/suspended-thrash state exceeds this count.',
      env: 'WAKING_ENDPOINTS_THRESHOLD',
      default: '2'
    },
    SPENDING_ALERT_PCT: {
      description: 'Alert when spending reaches this percent of the org spending limit.',
      env: 'SPENDING_ALERT_PCT',
      default: '80'
    }
  },

  harnessSettings: { reasoning: 'medium', timeoutSeconds: 120 },
  relay: { inbox: ['@self'] },
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 90 },

  onEvent: './agent.ts'
});
