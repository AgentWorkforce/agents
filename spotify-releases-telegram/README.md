# spotify-releases-telegram

The **Telegram** sibling of [`spotify-releases`](../spotify-releases) — checks daily for new releases from artists you follow on Spotify and messages you on Telegram (instead of Slack DM).

## How it works

- **Schedule:** daily cron → list followed artists → fetch each one's latest releases → keep releases newer than the last check (durable memory) → message the list to `TELEGRAM_CHAT`.
- Pure fetch + message, no model. Uses the shared Telegram transport (`../shared/telegram.ts`); bare URLs auto-link in Telegram.

## Inputs

| input | required | purpose |
|---|---|---|
| `TELEGRAM_CHAT` | yes | Telegram chat id releases are sent to. No chat picker yet — enter the numeric chat id. |
| `SPOTIFY_TOKEN` | yes | Spotify OAuth token with the `user-follow-read` scope. |

## Auth

A **Telegram Nango connection** (bot token from `@BotFather`) for delivery; the Spotify token is supplied as an input.

> **Note:** telegram trigger/scope catalogs are a pending cutover (relayfile-adapters#222 / workforce#249); the deploy target must have the telegram adapter registered.
