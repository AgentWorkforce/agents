# joke-bot

<img src="./banner.png" alt="joke-bot">

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/joke-bot/persona.ts)

A lightweight conversational joke bot for proving the Agent Relay chat path end
to end — over **Slack and/or Telegram**. It answers Slack @mentions, relay-inbox
DMs, and Telegram messages, **replies on the origin transport**, posts a daily
"joke of the day" to every configured transport, and keeps recent conversation
memory so follow-up jokes can use callbacks.

Transport is configuration-driven (workforce#252 optional integrations): `slack`
is gated on `SLACK_CHANNEL`, `telegram` on `TELEGRAM_CHAT`. Set either or both;
the unconfigured transport is pruned at deploy. At least one must be set.

## Inputs

| input | required | purpose |
|---|---|---|
| `SLACK_CHANNEL` | one of | Slack channel id to reply in. Setting it enables the Slack transport. Empty = skip Slack. |
| `TELEGRAM_CHAT` | one of | Telegram chat id to reply in (and post the daily joke to). Setting it enables Telegram. Empty = skip Telegram. (No chat picker yet — enter the numeric id.) |
