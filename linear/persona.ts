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

  // Two Linear triggers — `on` autocompletes Linear's catalog events.
  integrations: {
    linear: {
      triggers: [
        { on: 'issue.create', match: 'agentrelay' }, // new issues labelled "agentrelay"
        { on: 'comment.create' } // …or a comment that @-mentions the agent (handler enforces MENTION + skips its own replies)
      ]
    },
    // Default repo the cloud materializes into the sandbox (ctx.sandbox.cwd)
    // via relayfile — the agent never clones. If the issue names its own repo,
    // the handler parses it and points the coding agent there instead.
    github: { scope: { repo: 'your-org/your-repo' } }
  },

  inputs: {
    // The handle the agent answers to in Linear comments. Adjust to your
    // workspace's bot handle (e.g. @agentrelay / @agent_relay).
    MENTION: { description: 'Mention that triggers the comment path.', env: 'MENTION', default: '@agentrelay', optional: true }
  },

  // The coding agent implements inside a sandbox with write + network access.
  harness: 'codex',
  model: 'gpt-5.5',
  systemPrompt: 'Implement Linear issues as complete, well-described GitHub PRs that fully resolve the issue.',
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 1800,
    sandboxMode: 'workspace-write',
    workspaceWriteNetworkAccess: true
  },

  onEvent: './agent.ts'
});
