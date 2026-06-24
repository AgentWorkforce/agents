# inbox-buddy

<img src="./banner.png" alt="inbox-buddy">

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/inbox-buddy/persona.ts)

Chat with this agent in **Slack or Telegram** to ask about your Gmail. It holds a
**multi-turn conversation** (remembers earlier turns) and reasons over **full
email threads** (not single messages). One agent, dual transport — pick Slack,
Telegram, or both via configuration.

```text
You → #your-channel:  What's the latest on the Q3 export thread with Alice?
inbox-buddy →         Alice will send the final Q3 numbers by Friday and looped in finance for sign-off.
You →                 Who did she loop in?
inbox-buddy →         finance@acme.com — she added them on the Jun 9 reply.
```

It exists as a **dogfooding forcing-function** for two things the platform keeps
getting wrong:

1. **Conversational continuity** — remembering context across your messages.
2. **Email threading** — resolving "that thread with X" to the right Gmail
   thread and reasoning over its whole message list.

## How it works

- **Channels:** the human chat path is **Slack and/or Telegram**, not the relay
  inbox (the relay inbox is agent-to-agent). Two webhook-driven triggers are
  registered — `slack.app_mention` and `telegram.message` — and the handler
  dispatches by event type, **always replying on the origin transport** (a
  question asked in Slack is answered in Slack, never mirrored to Telegram). It
  ignores bot messages (loop guard) and Slack message edits/joins.
- **Pick a transport (workforce#252 optional integrations):** the `slack` and
  `telegram` integrations are each `optional: true` and gated by
  `enabledByInput`. Setting `SLACK_CHANNEL` enables (and restricts) the Slack
  transport; setting `TELEGRAM_CHAT` enables (and restricts) Telegram. A
  Slack-only deploy leaves `TELEGRAM_CHAT` empty and never has to connect a
  Telegram bot — the unused provider's connection + trigger are pruned at deploy.
- **Reads:** Gmail threads from the relayfile VFS at
  `/google-mail/threads/<id>.json` (provider id `google-mail`). No Gmail token —
  auth lives in the `google-mail` Nango connection. `lib/gmail.ts`.
- **Continuity:** the conversation transcript is persisted per-conversation in
  `ctx.memory` (workspace scope) and replayed into each prompt. Keyed on the
  Slack thread / Telegram chat (plus forum topic), or the channel itself for
  top-level Slack messages, so a back-and-forth is one continuous conversation.
  `lib/conversation.ts`; transports in `lib/slack.ts` + `../shared/telegram.ts`.
- **Reasoning:** `ctx.llm.complete` (claude-sonnet-4-6) over a recent-thread
  overview plus the full message list of any thread the question references.
  `lib/prompt.ts`.

## Threading gaps this surfaced (the real deliverable)

1. **Relay inbox is agent-to-agent, not human→agent.** `relay: { inbox: ['@self'] }`
   only fires on a native relaycast DM to the agent — a human posting in Slack
   never reaches it. The human-facing channel is Slack (this agent), so the chat
   path was reworked from a relay-inbox trigger to a `slack` trigger.
2. **Relay chat would get no harness session-resume** (cloud derives conversation
   keys from Slack `thread_ts`), and `ctx.llm.complete` is stateless — so we
   persist/replay the transcript ourselves. cloud#2375.
3. **Stale mount path** — the materialized Gmail path is `/google-mail/**`, not
   the legacy `/gmail/...`; scoping `/gmail/**` would mount an empty tree.

## Inputs

At least one of `SLACK_CHANNEL` / `TELEGRAM_CHAT` must be set — each both
**enables** its transport and **restricts** replies to that channel/chat.

| input | required | purpose |
|---|---|---|
| `SLACK_CHANNEL` | one of | Slack channel id to chat in. Setting it enables the Slack transport and restricts replies to that channel. Empty = skip Slack. |
| `TELEGRAM_CHAT` | one of | Telegram chat id to chat in. Setting it enables the Telegram transport and restricts replies to that chat. Empty = skip Telegram. (No chat picker yet — enter the numeric id.) |

## Local testing

```bash
# golden tests (pure helpers + multi-turn continuity + email threading + slack gating + scope invariant)
npm test -- tests/inbox-buddy.test.mjs

# eval harness (routing/side-effects in simulate; real model + judge in live)
npm run evals -- --agent inbox-buddy
npm run evals:live -- --judge --agent inbox-buddy
```

Seeds live in `evals/seeds/gmail-thread-*.json`; chat cases (incl. the multi-turn
continuity case) in `evals/cases.jsonl`.

> Note: the full delivery path (Slack message → cloud dispatcher → handler →
> reply) is the same rail the in-production `linear-slack` agent uses. The local
> cloud-delivery mirror (`cloud/dev-stack make dev`) needs Docker.
