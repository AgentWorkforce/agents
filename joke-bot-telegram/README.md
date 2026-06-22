# joke-bot-telegram

The **Telegram** sibling of [`joke-bot`](../joke-bot) — message it on Telegram and it replies with a pop-culture / current-events joke, holding a multi-turn conversation (callback humor). Also posts a daily **joke of the day** to the configured chat.

## How it works

- **Trigger:** telegram `message` → conversational joke reply (threaded on your message), with per-conversation memory for callbacks.
- **Schedule:** daily cron → one topical joke of the day posted to `TELEGRAM_CHAT`.
- Reply generation is `ctx.llm.complete` (a direct LLM call). No provider data / no VFS reads, so it runs **lightweight (`sandbox: false`)** — the Telegram writeback goes over the relayfile HTTP API, no Daytona box. Uses the shared Telegram transport (`../shared/telegram.ts`).

## Inputs

| input | required | purpose |
|---|---|---|
| `TELEGRAM_CHAT` | yes | Telegram chat id to reply in and post the daily joke to. No chat picker yet — enter the numeric chat id. |

## Auth

A **Telegram Nango connection** (bot token from `@BotFather`). `useSubscription` resolves the deployer's Anthropic credential for `ctx.llm`.

> **Note:** telegram trigger/scope catalogs are a pending cutover (relayfile-adapters#222 / workforce#249); the deploy target must have the telegram adapter registered.
