# joke-bot

<img src="./banner.png" alt="joke-bot">

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/joke-bot/persona.ts)

A lightweight conversational Slack joke bot for proving the Agent Relay chat path
end to end. It can answer relay inbox messages or Slack mentions, replies through
Slack, and keeps recent conversation memory so follow-up jokes can use callbacks.

## Inputs

| input | required | purpose |
|---|---|---|
| `SLACK_CHANNEL` | yes | Slack channel id to reply in. |
