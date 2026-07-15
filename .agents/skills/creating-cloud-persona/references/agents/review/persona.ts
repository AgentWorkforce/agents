import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Review Agent — reviews every new PR, fixes the issues it (and other bots)
 * find, resolves failing CI and merge conflicts, pings you on Slack when the PR
 * is ready, and merges it once you approve.
 */
export default definePersona({
  id: 'pr-reviewer',
  intent: 'review',
  tags: ['review'],
  description: 'Reviews new PRs, fixes the issues found (its own + other bots\'), resolves failing CI and merge conflicts, pings you on Slack when ready, and merges once you approve.',
  cloud: true,

  integrations: {
    github: {},
    slack: {
      // Cloud mounts an integration's relayfile subtree only from `scope`
      // (or from triggers — and this persona has github triggers only). A
      // scope-less `slack: {}` mounts nothing, so slackClient().post() wrote
      // its draft to unmounted local disk and the writeback worker never saw
      // it: every Slack ping was a silent no-op. The channel is picked at
      // deploy time (SLACK_CHANNEL input), so the scope can't name one
      // statically — mount the channels subtree, which covers the
      // `/slack/channels/{channelId}/messages` writeback path for any picked
      // channel (and excludes DMs/users).
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
      description: 'Only review and auto-fix PRs opened by these GitHub logins (comma-separated). If unset, every author is reviewed.',
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

  harness: 'codex',
  model: 'gpt-5.5',
  systemPrompt: 'You are a rigorous senior reviewer. Review PRs, fix what you find, keep CI green, and only hand back when the PR is genuinely ready.',
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 2400,
    // Daytona is the trust boundary for cloud fires. Codex's nested
    // bubblewrap sandbox requires user namespaces that Daytona does not allow.
    dangerouslyBypassApprovalsAndSandbox: true
  },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 180 },

  onEvent: './agent.ts'
});
