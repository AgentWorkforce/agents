import { definePersona } from '@agentworkforce/persona-kit';

/**
 * inbox-buddy-telegram — the Telegram sibling of inbox-buddy. Same conversational
 * Gmail Q&A agent, but the human chat surface is Telegram instead of Slack. It
 * reuses inbox-buddy's transport-agnostic libs (gmail/prompt/conversation) and
 * the shared Telegram transport (../shared/telegram.ts); only the transport
 * differs.
 *
 * Trigger: telegram `message` (webhook-driven — the update rides in the event
 * payload, independent of the relayfile mount). Reads Gmail ONLY from the
 * /google-mail VFS mount. Auth: the Telegram Nango connection (bot token from
 * @BotFather) + the google-mail Nango connection. No tokens live in the agent.
 *
 * Catalog note: telegram's trigger/scope catalogs are a pending cutover
 * (relayfile-adapters#222 / workforce#249). persona-kit accepts `telegram` via
 * its provider index-signature fallback today; the deploy target must have the
 * telegram adapter registered.
 *
 * sandbox: true — REQUIRED (same as inbox-buddy): a lightweight delivery skips
 * the relayfile-mount daemon, so the /google-mail reads come back empty.
 */
export default definePersona({
  id: 'inbox-buddy-telegram',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'Chat in Telegram to ask about your Gmail. Holds a multi-turn conversation, remembers earlier turns, and reasons over full email threads (e.g. "summarize that thread with Alice about the export").',
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
    // Gmail data source — identical to inbox-buddy. Scope the concrete subtree;
    // the cloud mount DROPS provider-root globs (`/google-mail/**`) via
    // isProviderRootPath, so name the threads subtree + LAYOUT.md directly.
    'google-mail': {
      scope: {
        threads: '/google-mail/threads/**',
        layout: '/google-mail/LAYOUT.md'
      }
    },
    // Telegram is the human chat surface (replaces inbox-buddy's slack block).
    // Scope the concrete chats subtree (NOT `/telegram/**` — same provider-root
    // drop), which also mounts the canonical bare-id writeback path rather than
    // just the read-only labelled mirror.
    telegram: {
      scope: {
        chats: '/telegram/chats/**',
        layout: '/telegram/LAYOUT.md'
      }
    }
  },

  inputs: {
    TELEGRAM_CHAT: {
      description:
        'Optional: restrict replies to one Telegram chat id. Unset = reply wherever the bot is messaged. (telegram `message` is webhook-driven, so no chat watch path is interpolated.) No chat picker exists yet — enter the numeric chat id.',
      env: 'TELEGRAM_CHAT',
      optional: true
    }
  },

  // Workspace-scoped memory holds the per-conversation transcript (continuity),
  // aged out after 60 days.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 60 },

  onEvent: './agent.ts'
});
