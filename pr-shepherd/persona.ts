import { definePersona } from '@agentworkforce/persona-kit';

/**
 * PR Shepherd — proactive cloud agent that watches every team's open pull
 * requests, classifies stale ones into four named bins, and escalates via
 * Slack with a per-rung dedupe key so each PR is never pinged twice for the
 * same condition at the same rung.
 *
 * Design decisions captured in:
 *   principals/khaliq/workstreams/pr-shepherd-agent.md
 *
 * Architecture (agreed 2026-08-11):
 *   • Webhook events → maintain the ledger (cloud only; only cloud receives webhooks)
 *   • Cron timer → evaluate ledger, fire escalation ladder
 *   • Cloud is the SOLE WRITER. Local instances are read-only observers.
 *   • Ledger stored in workspace-scoped memory (cloud-side, not a Relayfile
 *     projection — stale projections showed lag=0 while serving 3-day-old data).
 *   • work_unit_id is CARRIED IN from trajectory-lead-0811v3; never invented here.
 *
 * Staleness taxonomy (four bins; each requires explicit timestamps):
 *   awaiting-review   — no reviewer action N days after open/synchronize
 *   awaiting-author   — changes-requested with no author push for N days
 *   ci-red            — CI failing with no new commit for N days
 *   abandoned         — no human activity of any kind for N days
 *
 * Escalation ladder (per {owner}/{repo}/{pr_number}/{bin}/{rung}):
 *   rung 1 — Slack header post (once per PR per bin)
 *   rung 2 — Slack thread reply via replyTo (not threadTs — see 2026-08-07 defect)
 *   rung 3 — DM to Chief via relay
 *
 * DRY_RUN mode (set DRY_RUN=true): evaluates ledger and logs what would be
 * posted, but writes nothing to Slack and records no escalation entries.
 * Use this for the initial read-only proof against real PRs.
 *
 * Backfill: on the first cron tick the ledger is empty (webhooks only describe
 * PRs that move after listening starts). A one-time REST crawl seeds it from
 * currently-open PRs. Without this, PRs >60 days old that emit no events are
 * invisible — precisely the ones this agent exists to catch.
 */
export default definePersona({
  id: 'pr-shepherd',
  intent: 'relay-orchestrator',
  tags: ['review', 'discovery'],
  description:
    'Watches every open pull request org-wide, classifies stale ones into four named bins (awaiting-review, awaiting-author, ci-red, abandoned), and escalates via Slack with a dedupe key so each PR is pinged once per rung — never spammed.',
  cloud: true,
  useSubscription: true,

  // GitHub: receives PR and CI webhook events to maintain the ledger.
  // Slack: optional, gated on SLACK_CHANNEL — a dry-run deploy never needs it.
  integrations: {
    github: {
      scope: { paths: '/github/**' },
      // webhookWritesForLazyRepos: true ensures webhook events write PR data
      // to the Relayfile mount even for repos not eagerly materialized — the
      // ledger update path reads from the webhook payload directly, but this
      // gives the VFS a usable mirror for the Q&A path.
      config: {
        materialization: {
          default: 'lazy',
          webhookWritesForLazyRepos: true
        }
      }
    },
    slack: {
      optional: true,
      enabledByInput: 'SLACK_CHANNEL',
      scope: { channels: '/slack/channels/**' }
    }
  },

  // Workspace-scoped: ledger entries and escalation records are per-workspace
  // (shared between cloud + any local readers). ttlDays covers closed PRs —
  // entries age out 90 days after the last write, preventing unbounded growth.
  memory: {
    enabled: true,
    scopes: ['workspace'],
    ttlDays: 90
  },

  relay: {
    inbox: ['@self']
  },

  // Haiku: the cron path is largely data processing + a Slack write.
  // The Q&A path (relay DM) can use ctx.llm.complete() for synthesis but
  // doesn't need deep reasoning for a PR state summary.
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt:
    'You are PR Shepherd. You maintain a ledger of open pull requests and escalate stale ones via Slack. ' +
    'When answering questions about PR state, use the ledger (ctx.memory) as the primary source — never invent data. ' +
    'State the staleness bin and the reason it fired in every alert. ' +
    'If you are running in a local harness where ctx.memory is not available, fall back to the GitHub CLI: ' +
    '`gh pr list --state open --repo AgentWorkforce/<repo>` or `gh pr list --state open --json number,title,author,createdAt,reviewDecision --repo AgentWorkforce/<repo>` ' +
    'to answer questions about current PR state. Always tell the user which data source you used: ' +
    '"From ledger (cloud memory):" vs "From live GitHub API (ledger unavailable):". ' +
    'Never silently fail — if you cannot reach the ledger AND the gh CLI is not available, say so explicitly.',
  harnessSettings: {
    reasoning: 'low',
    timeoutSeconds: 1800
  },

  onEvent: './agent.ts',

  inputs: {
    SLACK_CHANNEL: {
      description: 'Slack channel id to post stale-PR alerts to. If unset, the agent runs in implicit dry-run (no Slack integration is connected).',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    },
    SLACK_BOT_USER_ID: {
      description: 'Slack bot user ID (e.g. U0XXXXXXX). When set, only responds to @mentions of this bot. When unset, responds to any non-bot message in SLACK_CHANNEL. Find it in your Slack app settings.',
      env: 'SLACK_BOT_USER_ID',
      optional: true
    },
    DRY_RUN: {
      description: 'Set to "true" to log what the escalation ladder would post without writing to Slack or recording escalation entries. Use for the initial read-only proof against real PRs.',
      env: 'DRY_RUN',
      default: 'false'
    },
    STALE_AWAITING_REVIEW_DAYS: {
      description: 'Days without a reviewer action before a PR is classified awaiting-review.',
      env: 'STALE_AWAITING_REVIEW_DAYS',
      default: '3'
    },
    STALE_AWAITING_AUTHOR_DAYS: {
      description: 'Days after "changes requested" without an author push before classified awaiting-author.',
      env: 'STALE_AWAITING_AUTHOR_DAYS',
      default: '2'
    },
    STALE_CI_RED_DAYS: {
      description: 'Days with CI failing without a new commit before classified ci-red.',
      env: 'STALE_CI_RED_DAYS',
      default: '1'
    },
    STALE_ABANDONED_DAYS: {
      description: 'Days with no human activity of any kind before classified abandoned.',
      env: 'STALE_ABANDONED_DAYS',
      default: '14'
    },
    ESCALATION_RUNG2_MULTIPLIER: {
      description: 'Rung-2 fires after this multiple of the bin threshold with no resolution (e.g. 2 = 2× the threshold).',
      env: 'ESCALATION_RUNG2_MULTIPLIER',
      default: '2'
    },
    ORG: {
      description: 'GitHub org to watch (default: AgentWorkforce).',
      env: 'ORG',
      default: 'AgentWorkforce'
    }
  }
});
