<img src="./banner.png" alt="Spotify Releases">

Spotify Releases
==================

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/spotify-releases/persona.ts)

A proactive agent that checks daily for new releases from your favorite artists
and messages you about them over **Slack, Telegram, or both**.

Transport is configuration-driven (workforce#252 optional integrations): `slack`
delivery is a DM to `SLACK_USER`, `telegram` delivery is a message to
`TELEGRAM_CHAT`. Set either or both — the unconfigured transport is pruned at
deploy. At least one must be set.

## Inputs

| input | required | purpose |
|---|---|---|
| `SLACK_USER` | one of | Your Slack user id — releases are DMed here. Empty = skip Slack. |
| `TELEGRAM_CHAT` | one of | Telegram chat id — releases are sent here. Empty = skip Telegram. (No chat picker yet — enter the numeric id.) |
| `SPOTIFY_TOKEN` | yes | Spotify OAuth token with the user-follow-read scope. |
