import { definePersona } from '@agentworkforce/persona-kit';

/**
 * joke-bot-telegram — the Telegram sibling of joke-bot. Message it on Telegram
 * and it replies with a pop-culture / current-events joke, holding a multi-turn
 * conversation (callback humor) via memory. Also posts a daily "joke of the day"
 * to the configured chat.
 *
 * No provider data / no VFS reads — only ctx.llm + Telegram writeback — so it
 * runs lightweight (sandbox:false): the writeback goes over the relayfile HTTP
 * API when there's no mount (relay-helpers ≥0.4.1), so no Daytona box is needed.
 *
 * Catalog note: telegram trigger/scope catalogs are a pending cutover
 * (relayfile-adapters#222 / workforce#249); persona-kit accepts `telegram` via
 * its provider index-signature fallback today.
 */
export default definePersona({
  id: 'joke-bot-telegram',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'A conversational joke bot on Telegram: message it and it replies with a pop-culture / current-events joke, with multi-turn callback humor, plus a daily joke of the day.',
  cloud: true,

  // No Daytona box: the handler answers via ctx.llm.complete (one LLM call) and
  // the Telegram writeback goes over the relayfile HTTP API (no FS mount needed).
  sandbox: false,

  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt:
    'You are a sharp, fast stand-up comedian. You riff on current events, tech, and pop culture. ' +
    'Keep replies short (1-3 lines), punchy, and genuinely funny — favor a clever observation or a tight setup→punchline over puns. ' +
    'Stay good-natured: no slurs, no punching down, nothing mean about the person you are talking to. ' +
    'If the user is clearly continuing an earlier bit, build on it (callback humor) using the conversation so far.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },

  // Telegram is the reply surface (writeback to /telegram/chats/{chatId}/messages),
  // so scope the concrete chats subtree (NOT `/telegram/**` — the cloud mount
  // drops provider-root globs). An unscoped mount would make the reply a no-op.
  integrations: {
    telegram: { scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' } }
  },

  inputs: {
    TELEGRAM_CHAT: {
      description:
        'Telegram chat id to reply in (and post the daily joke to). No chat picker exists yet — enter the numeric chat id.',
      env: 'TELEGRAM_CHAT'
    }
  },

  // Conversation memory drives multi-turn callbacks across messages.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
