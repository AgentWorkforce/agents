import { definePersona } from '@agentworkforce/persona-kit';

/**
 * joke-bot — a conversational agent you chat with over Slack and/or Telegram: it
 * replies with a pop-culture / current-events joke, holds a multi-turn
 * conversation (callback humor) via memory, and posts a daily "joke of the day".
 * One agent, dual transport — pick Slack, Telegram, or both via configuration.
 *
 * Why it exists: we keep getting conversational agents + threading wrong. A bot
 * with zero data dependencies isolates the chat path from all the
 * sync/materialization machinery — if joke-bot can hold a multi-turn
 * conversation, "conversational agents work" is confirmed independent of the VFS.
 *
 * Optional integrations (workforce#252): `slack` and `telegram` are each
 * `optional: true` and gated by `enabledByInput` (SLACK_CHANNEL / TELEGRAM_CHAT),
 * so a Slack-only deploy never has to wire up a Telegram bot, and vice versa. The
 * relay-inbox DM path and the Slack `capabilities.conversational` routing below
 * are Slack-side; Telegram is reached via its own `message` trigger.
 */
export default definePersona({
  id: 'joke-bot',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'A conversational joke bot on Slack and/or Telegram: message it and it replies with a pop-culture / current-events joke, with multi-turn callback humor, plus a daily joke of the day.',
  cloud: true,

  // No Daytona box. The handler answers via ctx.llm.complete (one LLM call) and
  // the writeback goes over the relayfile HTTP API instead of the FS mount
  // (relay-helpers ≥0.4.1 routes writeJsonFile to RelayFileClient when there's no
  // mount). So no mount is needed → handler runs in the persona runner (ms).
  sandbox: false,

  // ctx.llm.complete() resolves against the deployer's connected subscription
  // credential (rides in providerEnv; the deploy log shows it selected for ctx.llm).
  useSubscription: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt:
    "You are a sharp, fast stand-up comedian. You riff on current events, tech, and pop culture. " +
    'Keep replies short (1-3 lines), punchy, and genuinely funny — favor a clever observation or a tight setup→punchline over puns. ' +
    'Stay good-natured: no slurs, no punching down, nothing mean about the person you are talking to. ' +
    'If the user is clearly continuing an earlier bit, build on it (callback humor) using the conversation so far.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },

  // Makes joke-bot a candidate for Slack @AgentRelay conversational routing.
  // The cloud dispatcher only routes app_mentions to personas with this
  // capability; `channels` scopes it to proj-cloud and `defaultResponder` lets
  // it answer there without having to name it (`@AgentRelay joke-bot ...` still
  // works and is needed if other conversational agents share the channel).
  // Slack-only — Telegram is reached via its `message` trigger in agent.ts.
  capabilities: {
    conversational: {
      enabled: true,
      defaultResponder: true,
      channels: ['C0AD7UU0J1G'],
      identity: { username: 'joke-bot' }
    }
  },

  integrations: {
    // Slack reply surface (writeback to /slack/channels/{id}/messages), so scope
    // channels. Gated on SLACK_CHANNEL (workforce#252) — an unscoped slack mount
    // would make post() a silent no-op anyway.
    slack: {
      optional: true,
      enabledByInput: 'SLACK_CHANNEL',
      scope: { channels: '/slack/channels/**' }
    },
    // Telegram reply surface (writeback to /telegram/chats/{chatId}/messages), so
    // scope the concrete chats subtree (NOT `/telegram/**` — the cloud mount
    // drops provider-root globs). Gated on TELEGRAM_CHAT.
    telegram: {
      optional: true,
      enabledByInput: 'TELEGRAM_CHAT',
      scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' }
    }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Slack channel id to reply in. Setting it enables the Slack transport. Leave empty to skip Slack.',
      env: 'SLACK_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' }
    },
    TELEGRAM_CHAT: {
      description:
        'Telegram chat id to reply in (and post the daily joke to). Setting it enables the Telegram transport. Leave empty to skip Telegram. No chat picker exists yet — enter the numeric chat id.',
      env: 'TELEGRAM_CHAT',
      optional: true
    }
  },

  // Conversation memory drives the multi-turn threading test: each turn is saved
  // and recalled so the bot can do callbacks across messages.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  relay: { inbox: ['@self'] },

  onEvent: './agent.ts'
});
