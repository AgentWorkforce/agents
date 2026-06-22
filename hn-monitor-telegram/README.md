# hn-monitor-telegram

<img src="./banner.png" alt="HN Monitor Telegram">

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/hn-monitor-telegram/persona.ts)

The **Telegram** sibling of [`hn-monitor`](../hn-monitor) — scans Hacker News a few times a day for your topics and posts a digest to a Telegram chat, **threaded under a compact count header**. Message the bot to ask about what it recently posted.

## How it works

- **Schedule:** cron scan → fetch the HN front page → keep stories matching `TOPICS` → drop already-posted (durable memory) → summarize with `ctx.llm` → post a count header, then thread the digest under it via **native Telegram `reply_to_message_id`** (no header/parentRef dance).
- **Trigger:** telegram `message` → Q&A over the last ~30 days of posted digests.
- Uses the shared Telegram transport (`../shared/telegram.ts`). Idempotency: claims "seen" before posting; if a header lands but the body send fails, it stores a pending threaded body and retries that body without reposting the header.

## Inputs

| input | required | purpose |
|---|---|---|
| `TOPICS` | no | Comma-separated keywords matched against story titles (default: `agents,ai,typescript,developer tools`). |
| `TELEGRAM_CHAT` | yes | Telegram chat id to post the digest to and answer Q&A in. No chat picker yet — enter the numeric chat id. |

## Auth

A **Telegram Nango connection** (bot token from `@BotFather`). `useSubscription` resolves the deployer's Anthropic credential for `ctx.llm` (summaries + Q&A).

> **Note:** telegram trigger/scope catalogs are a pending cutover (relayfile-adapters#222 / workforce#249); the deploy target must have the telegram adapter registered.
