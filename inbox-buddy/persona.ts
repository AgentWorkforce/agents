import { definePersona } from '@agentworkforce/persona-kit';

/**
 * inbox-buddy — a conversational agent you chat with in a dedicated Slack
 * channel to ask about your Gmail. It remembers earlier turns and reasons over
 * full Gmail threads (not single messages).
 *
 * Human channel = Slack (the relay inbox is agent-to-agent, so it is NOT used
 * for human chat). This mirrors the in-production `linear-slack` agent: a slack
 * trigger watches ONE channel (SLACK_CHANNEL); the handler answers every fresh
 * human message there and replies in Slack.
 *
 * Reads Gmail ONLY from the relayfile VFS mount materialized by the google-mail
 * Nango connection. The canonical mount root is `/google-mail` (NOT `/gmail` —
 * that legacy adapter path is unused by cloud; see lib/gmail.ts). No Gmail token
 * lives in the agent.
 *
 * sandbox: true — REQUIRED. A `sandbox:false` (lightweight) delivery skips the
 * relayfile-mount daemon, so the VFS is never mirrored to the filesystem and the
 * handler's `/google-mail/threads` reads come back empty. The proven Slack-chat
 * agent (linear-slack) is also sandbox:true. The box reads Gmail from the
 * mounted VFS and answers with ctx.llm.complete (no harness needed).
 */
export default definePersona({
  id: 'inbox-buddy',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Chat in a dedicated Slack channel to ask about your Gmail. Holds a multi-turn conversation, remembers earlier turns, and reasons over full email threads (e.g. "summarize that thread with Alice about the export").',
  cloud: true,
  sandbox: true,

  // ctx.llm.complete drives the conversation. useSubscription lets cloud resolve
  // the deployer's active Anthropic credential per fire.
  useSubscription: true,
  harness: 'claude',
  model: 'claude-sonnet-4-6',
  systemPrompt:
    "You are inbox-buddy, a concise assistant with read access to the user's recent Gmail. Answer questions about their email over a multi-turn conversation, grounded only in the email data provided, and reason over full threads when the user references one.",
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 1200 },

  integrations: {
    // Gmail threads materialize under /google-mail (provider id `google-mail`).
    // `/google-mail/**` mounts the threads + LAYOUT.md the handler reads. An
    // unscoped mirror (or a `/gmail/**` scope) would mount nothing.
    'google-mail': { scope: { paths: '/google-mail/**' } },
    // The slack trigger only mirrors the chat channel READ-ONLY at the
    // display-labelled path; slackClient().post() writes to the canonical
    // bare-id path, which only a non-empty `scope` mounts — without it every
    // reply is a silent no-op (the labelled-mirror trap).
    slack: { scope: { paths: '/slack/channels/**' } }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'The dedicated Slack channel inbox-buddy chats in. Its id is interpolated into the trigger watch path so the agent only wakes for this channel.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    }
  },

  // Workspace-scoped memory holds the per-conversation transcript (continuity),
  // aged out after 60 days.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 60 },

  onEvent: './agent.ts'
});
