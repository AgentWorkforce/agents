import { definePersona } from '@agentworkforce/persona-kit';

/**
 * inbox-buddy — a conversational agent you chat with to ask about your Gmail. It
 * remembers earlier turns and reasons over full Gmail threads (not single
 * messages). Delivers over Slack, Telegram, or both — one agent, transport
 * chosen by configuration.
 *
 * Human chat surface(s):
 *   - Slack via `@mention` (trigger `slack.app_mention`)
 *   - Telegram via direct `message` (trigger `telegram.message`)
 * Both are WEBHOOK-driven: the message rides in the event payload, so chat works
 * independent of the relayfile slack/telegram mounts (whose ingestion can
 * lag/stall — e.g. during the relayfile migration). The relay inbox is
 * agent-to-agent, so it is NOT used for human chat.
 *
 * Optional integrations (workforce#252): `slack` and `telegram` are each
 * declared `optional: true` and gated by `enabledByInput`. A transport's
 * provider connection + trigger registration happen ONLY when its id input
 * resolves non-empty — so a Slack-only deploy (set SLACK_CHANNEL, leave
 * TELEGRAM_CHAT empty) never has to wire up a Telegram bot, and vice versa. Set
 * both to deliver over both. `google-mail` is always required (the data source).
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
    'Chat in Slack or Telegram to ask about your Gmail. Holds a multi-turn conversation, remembers earlier turns, and reasons over full email threads (e.g. "summarize that thread with Alice about the export").',
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
    // The cloud runtime mount DROPS provider-root globs (`/google-mail/**`) via
    // isProviderRootPath to avoid mirroring whole providers — so a `/google-mail/**`
    // scope is granted in the token but never mirrored, and loadRecentThreads()
    // sees an empty dir and reports no Gmail. Naming subpaths survives the filter
    // (same stack as linear-slack), so scope the concrete subtree the handler
    // reads (`/google-mail/threads/**`) + the root LAYOUT.md file directly.
    'google-mail': {
      scope: {
        threads: '/google-mail/threads/**',
        layout: '/google-mail/LAYOUT.md'
      }
    },
    // Slack chat surface. optional + enabledByInput (workforce#252): connected
    // and trigger-registered ONLY when SLACK_CHANNEL is set. The slack trigger
    // mirrors the chat channel READ-ONLY at the display-labelled path;
    // slackClient().post() writes to the canonical bare-id path, which only a
    // non-empty `scope` mounts — without it every reply is a silent no-op (the
    // labelled-mirror trap).
    slack: {
      optional: true,
      enabledByInput: 'SLACK_CHANNEL',
      scope: { paths: '/slack/channels/**' }
    },
    // Telegram chat surface. Same opt-in gate on TELEGRAM_CHAT. Scope the
    // concrete chats subtree (NOT `/telegram/**` — same provider-root drop),
    // which also mounts the canonical bare-id writeback path rather than just the
    // read-only labelled mirror.
    telegram: {
      optional: true,
      enabledByInput: 'TELEGRAM_CHAT',
      scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' }
    }
  },

  inputs: {
    // Gate-on-id (workforce#252): providing SLACK_CHANNEL both ENABLES the Slack
    // transport and restricts replies to that one channel. Leave empty to skip
    // Slack entirely. (app_mention is webhook-driven, so the id is used as a
    // gate/filter, not interpolated into a watch path.)
    SLACK_CHANNEL: {
      description:
        'Slack channel id to chat in. Setting it enables the Slack transport and restricts replies to that channel. Leave empty to skip Slack delivery.',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    },
    // Gate-on-id: providing TELEGRAM_CHAT enables the Telegram transport and
    // restricts replies to that chat. Leave empty to skip Telegram. No chat
    // picker exists yet — enter the numeric chat id.
    TELEGRAM_CHAT: {
      description:
        'Telegram chat id to chat in. Setting it enables the Telegram transport and restricts replies to that chat. Leave empty to skip Telegram delivery.',
      env: 'TELEGRAM_CHAT',
      optional: true
    }
  },

  // Workspace-scoped memory holds the per-conversation transcript (continuity),
  // aged out after 60 days.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 60 },

  onEvent: './agent.ts'
});
