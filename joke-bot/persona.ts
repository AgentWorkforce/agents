import { definePersona } from '@agentworkforce/persona-kit';

/**
 * joke-bot — the simplest possible conversational agent: you DM it via the relay
 * inbox, it replies in Slack with a joke. No provider data, no VFS reads — its
 * only job is to PROVE the conversational path works end to end (relay inbox →
 * harness → Slack writeback) and to exercise multi-turn threading.
 *
 * Why it exists: we keep getting conversational agents + threading wrong. A bot
 * with zero data dependencies isolates the chat path from all the
 * sync/materialization machinery — if joke-bot can hold a multi-turn
 * conversation, "conversational agents work" is confirmed independent of the VFS.
 *
 * It is also the harness test vehicle: the joke is generated via ctx.harness.run
 * (NOT ctx.llm.complete), so flipping `harness` below to claude / codex / opencode
 * tests each provider's conversational + session-resume behavior in turn.
 *
 * Reply surface is Slack writeback (slackClient().post) — the proven chat-reply
 * path for relay-inbox agents in this repo.
 */
export default definePersona({
  id: 'joke-bot',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'A conversational joke bot: DM it via the relay inbox and it replies in Slack with a pop-culture / current-events joke. Exists to confirm conversational agents + multi-turn threading work, and to test the claude/codex/opencode harnesses.',
  cloud: true,

  // sandbox:true (default) is required: the reply is a Slack WRITEBACK
  // (slackClient().post → relayfile mount), and sandbox:false bypasses the
  // relayfile mount, so the reply can't be written. The run is still fast — the
  // handler answers via ctx.llm.complete (one LLM call), NOT ctx.harness.run
  // (which boots a full CLI session and took minutes). Cost is just the box
  // cold-start; trigger `match` (once cloud enforces it) limits when it provisions.
  sandbox: true,

  // ctx.llm.complete() resolves against the deployer's connected subscription
  // credential (rides in providerEnv; the deploy log shows it selected for ctx.llm).
  useSubscription: true,

  // Swap this between 'claude' | 'codex' | 'opencode' to test each provider.
  // The joke is produced by ctx.harness.run, so the harness here is what runs.
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
  capabilities: {
    conversational: {
      enabled: true,
      defaultResponder: true,
      channels: ['C0AD7UU0J1G'],
      identity: { username: 'joke-bot' }
    }
  },

  // Slack is the reply surface (writeback to /slack/channels/{id}/messages), so
  // scope channels. An unscoped slack mount would make post() a silent no-op.
  integrations: {
    slack: { scope: { channels: '/slack/channels/**' } }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Slack channel id to reply in.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' }
    }
  },

  // Conversation memory drives the multi-turn threading test: each turn is saved
  // and recalled so the bot can do callbacks across messages.
  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  relay: { inbox: ['@self'] },

  onEvent: './agent.ts'
});
