import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Linear Agent — when a labelled Linear issue is opened (or commented on),
 * implements it and opens a GitHub PR.
 */
export default definePersona({
  id: 'linear-implementer',
  intent: 'relay-orchestrator',
  tags: ['implementation'],
  description: 'When a labelled Linear issue is opened (or commented on), implements it and opens a GitHub PR.',
  cloud: true,
  useSubscription: true,

  // Two Linear triggers — `on` autocompletes Linear's catalog events. `match`
  // narrows issue.create to a single label.
  integrations: {
    linear: {
      triggers: [
        { on: 'issue.create', match: 'agentrelay' }, // only issues labelled "agentrelay"
        { on: 'comment.create' } // …or a new comment on an issue
      ]
    },
    // Default repo the cloud materializes into the sandbox (ctx.sandbox.cwd)
    // via relayfile — the agent never clones. If the issue names its own repo,
    // the handler parses it and points the coding agent there instead.
    github: { scope: { repo: 'your-org/your-repo' } }
  },

  // The coding agent implements inside a sandbox with write + network access.
  harness: 'codex',
  model: 'gpt-5.5',
  systemPrompt: 'Implement Linear issues as small, reviewable GitHub PRs with a clear description.',
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 1800,
    sandboxMode: 'workspace-write',
    workspaceWriteNetworkAccess: true
  },

  onEvent: './agent.ts'
});
