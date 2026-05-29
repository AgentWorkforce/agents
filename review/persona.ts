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

  // Re-review on every PR change (open, new commits, review comments, finished
  // CI), and merge when you approve. Every `on` value autocompletes from
  // github's catalog (see relayfile-adapters DEFAULT_SUPPORTED_EVENTS).
  integrations: {
    github: {
      triggers: [
        { on: 'pull_request.opened' },
        { on: 'pull_request_review.submitted' },
        { on: 'pull_request_review_comment.created' },
        { on: 'check_run.completed' },
        { on: 'pull_request.synchronize' }
      ]
    },
    slack: {}
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Slack channel to post review updates to (the message references the PR author).',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    },
    APPROVERS: {
      description: 'GitHub logins whose approval merges the PR. If unset, any approval merges.',
      env: 'APPROVERS',
      optional: true,
      picker: { provider: 'github', resource: 'users' }
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

  onEvent: './agent.ts'
});
