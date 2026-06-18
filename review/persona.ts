import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Review Agent — reviews every new PR, applies only mechanical safe fixes,
 * comments on logic/safety findings, pings you on Slack when the PR is ready,
 * and merges it once you approve.
 */
export default definePersona({
  id: 'pr-reviewer',
  intent: 'review',
  tags: ['review'],
  description: 'Reviews new PRs, applies only lint/format/typo fixes, comments on logic or safety findings, pings you on Slack when ready, and merges once you approve.',
  cloud: true,

  // Opt-in, comment-driven merge-conflict resolution. Distinct from cloud's
  // deterministic `conflictAutofix` (which only does a clean rebase and aborts
  // on real textual conflicts): `conflictResolve` is the LLM path — cloud merges
  // the base branch into the working tree, the harness resolves the conflict
  // markers (see conflictResolveHarnessPrompt in agent.ts), and cloud finalizes
  // and pushes the merge commit. It engages ONLY when an authorized commenter
  // posts the directive (see CONFLICT_DIRECTIVE_PATTERN), never on ordinary PR
  // events. Inert until cloud models this capability + the merge-in-tree setup
  // (tracked in AgentWorkforce/cloud): with no merge, the harness finds no
  // markers and makes no change.
  capabilities: {
    conflictResolve: { directive: '@relay fix conflicts', resolveMarkers: true }
  },

  integrations: {
    github: {},
    slack: {
      // Slack writebacks use bare channel ids while trigger paths can include
      // display labels; keep the whole channels subtree mounted so ready/merge
      // pings and merge-request replies both reach the writeback worker.
      scope: { paths: '/slack/channels/**' }
    }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Slack channel to post review updates to (the message references the PR author).',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    },
    APPROVERS: {
      description: 'GitHub logins whose approval merges the PR. If unset, any approval merges.',
      env: 'APPROVERS',
      optional: true,
      picker: { provider: 'github', resource: 'users' }
    },
    REVIEW_AUTHORS: {
      description: 'Only review and mechanically auto-fix PRs opened by these GitHub logins (comma-separated). If unset, every author is reviewed.',
      env: 'REVIEW_AUTHORS',
      optional: true,
      picker: { provider: 'github', resource: 'users' }
    },
    SKIP_LABELS: {
      description: 'PR labels that disable the reviewer entirely (comma-separated). Defaults to "no-agent-relay-review".',
      env: 'SKIP_LABELS',
      optional: true
    }
  },

  harness: 'claude',
  model: 'claude-opus-4-8',
  systemPrompt: 'You are a rigorous senior reviewer. Review PRs, auto-apply only lint/format/typo fixes, leave logic and safety changes as comments, keep CI honest, and only hand back when the PR is genuinely ready.',
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 2400,
  },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 180 },

  onEvent: './agent.ts'
});
