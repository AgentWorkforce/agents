<img src="./banner.png" alt="PR Reviewer">

Review Agent
==================

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/review/persona.ts)

A conservative PR reviewer that posts a multi-agent review when a PR opens.
It may auto-apply only lint, formatting, typo, import-order, and other
mechanical non-semantic fixes. Logic changes, safety-sensitive code, lifecycle
or termination paths, and test changes are suggestion/comment-only so a human
author owns them. It sends a message on Slack when a PR is ready for your
review or can merge the PR if you approve.
