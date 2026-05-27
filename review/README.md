Review Agent
==================

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts)

A proactive agent that when a PR is opened up posts a multi agent review. If
the review finds items that needs to be changed it proactively fixes the issues both
from its own review but also other bot reviews. If there are failing CI checks
or merge conflicts it proactively resolves it. It sends a message on Slack to let
you know when a PR is ready for your review or can merge the PR if you approve.


