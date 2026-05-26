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
    SLACK_USER: { description: 'Slack user id to ping when a PR is ready (and whose approval merges it).', env: 'SLACK_USER' }
  },

  harness: 'codex',
  model: 'gpt-5.4',
  systemPrompt: 'You are a rigorous senior reviewer. Review PRs, fix what you find, keep CI green, and only hand back when the PR is genuinely ready.',
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 2400,
    sandboxMode: 'workspace-write',
    workspaceWriteNetworkAccess: true
  },

  onEvent: './agent.ts'
});
