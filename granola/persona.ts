import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Granola Agent — when a Granola meeting recording lands, detects prospect
 * calls, files a Linear issue with what they asked for, and opens a GitHub PR
 * implementing it.
 */
export default definePersona({
  id: 'granola-prospect',
  intent: 'relay-orchestrator',
  tags: ['discovery', 'implementation'],
  description: 'When a Granola recording lands, detects prospect calls, files a Linear issue with the ask, and opens a GitHub PR implementing it.',
  cloud: true,
  useSubscription: true,

  integrations: {
    // Granola has no realtime webhook yet, so notes arrive via the Nango
    // `granola-relay:fetch-notes` sync, which writes each note to the VFS at
    // /granola/notes/<id>.json and fires a storage `file.created` event.
    granola: { triggers: [{ on: 'file.created' }] },
    linear: {},
    // The cloud materializes this repo into the sandbox (ctx.sandbox.cwd) via
    // relayfile — the agent never clones it.
    github: { scope: { repo: 'your-org/your-repo' } }
  },

  inputs: {
    LINEAR_TEAM_ID: { description: 'Linear team to file prospect issues under.', env: 'LINEAR_TEAM_ID' }
  },

  harness: 'claude',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'Turn prospect asks from meeting transcripts into a Linear issue and a small implementing PR.',
  harnessSettings: {
    reasoning: 'high',
    timeoutSeconds: 1800,
    sandboxMode: 'workspace-write',
    workspaceWriteNetworkAccess: true
  },

  onEvent: './agent.ts'
});
