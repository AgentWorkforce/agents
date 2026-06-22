# inbox-buddy-telegram

<img src="./banner.png" alt="Inbox Buddy Telegram">

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/inbox-buddy-telegram/persona.ts)

The **Telegram** sibling of [`inbox-buddy`](../inbox-buddy) — chat with it on Telegram to ask about your Gmail. Same conversational agent (multi-turn continuity + full email-thread reasoning), just a different chat surface.

```text
You → (Telegram):  What's the latest on the Q3 export thread with Alice?
inbox-buddy →      Alice will send the final Q3 numbers by Friday and looped in finance for sign-off.
You →              Who did she loop in?
inbox-buddy →      finance@acme.com — she added them on the Jun 9 reply.
```

## How it works

It **reuses inbox-buddy's transport-agnostic libs** (`../inbox-buddy/lib/{gmail,prompt,conversation}`) and swaps the Slack transport for the shared Telegram transport (`../shared/telegram.ts`). Only the transport differs:

- **Trigger:** telegram `message` (webhook-driven — the message rides in the event payload, independent of the relayfile mount).
- **Reads** Gmail only from the `/google-mail/threads` VFS mount (no Gmail token in the agent).
- **Replies** via `telegramClient().messages.write`, threading on the source message.

## Inputs

| input | required | purpose |
|---|---|---|
| `TELEGRAM_CHAT` | no | Optional: restrict replies to one Telegram chat id. Unset = reply wherever the bot is messaged. No chat picker yet — enter the numeric chat id. |

## Auth

A **Telegram Nango connection** (bot token from `@BotFather`) + the **google-mail Nango connection**. No tokens live in the agent. `sandbox: true` is required so the `/google-mail` VFS mount materializes.

> **Note:** the telegram trigger/scope catalogs are a pending cutover (relayfile-adapters#222 / workforce#249); the deploy target must have the telegram adapter registered.
