<img src="./banner.png" alt="Linear Slack">

Linear Slack
============

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/linear-slack/persona.ts)

A conversational Linear board assistant you chat with in one dedicated Slack
channel. It runs a Claude harness inside a sandbox with the Linear VFS mounted,
so it can navigate issues on demand instead of stuffing the entire board into a
single prompt.

What it does
------------

1. Answers Slack questions about open Linear issues, projects, teams, and board
   state.
2. Reads only the mounted Linear files needed for the question.
3. Organizes the board when explicitly asked by emitting structured
   `linear-actions` for the runtime to apply.
4. Replies in concise Slack-friendly plain text.

Deploy
------

```bash
agentworkforce deploy ./linear-slack/persona.ts
```

At deploy time, choose the Slack channel where teammates should chat with the
assistant about the Linear board.
