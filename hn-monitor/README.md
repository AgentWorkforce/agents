<img src="./banner.png" alt="HN Monitor">

Hacker News Monitor
==================

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/hn-monitor/persona.ts)

A proactive agentic-software radar for Hacker News. Twice a day it scans three
surfaces — Front Page, Show HN, and the previous 24 hours of New HN — then ranks
stories against the things Agent Relay builds: coding agents, multi-agent
coordination, agent runtimes/memory/sandboxes, workflows, and developer tools.

The channel stays compact: a one-line count/source header is posted at the top
level and a richer digest lives in its thread. Every story includes the article,
HN discussion, points/comments, feed provenance, category, and a short “why it
matters” note.

You can also chat with it:

- Reply in a digest thread and `@mention` the bot with a story number or title.
- DM it over Agent Relay, or message its configured Telegram chat.
- For post-specific questions it refreshes the HN item and top comments before
  answering, and clearly treats comments as community reaction rather than fact.
- Slack digests keep an authoritative per-thread record plus a rolling index in
  the mounted Slack Relayfile subtree. Per-thread shards prevent concurrent
  posts from overwriting one another. Semantic memory remains useful history,
  but ordinal/title follow-ups do not depend on semantic search returning the
  right record.
- If both exact state and semantic memory are unavailable, a question carrying
  a complete story title uses a conservative HN Algolia title match before
  hydration. Ambiguous or loose keyword matches are rejected.

If a delivered Slack digest cannot persist its exact grounding record, the run
fails explicitly and emits `hn-monitor.post-grounding-persistence-failed`;
semantic-memory failure alone remains a warning because exact state is primary.

Exact state currently follows the configured Slack channel. Telegram-only and
relay-only follow-ups still use semantic memory plus the strict title fallback;
an ordinal such as “story 2” therefore needs retained memory outside Slack.

Focused checks:

```sh
npm run test:hn
npm run evals:hn
npm run preview:hn  # read-only live HN selection + Slack-text preview
```

Platform developer loop:

```sh
agentworkforce invoke ./hn-monitor/agent.ts --case ./hn-monitor/cases/scheduled-scan.case.yaml
agentworkforce invoke ./hn-monitor/agent.ts --schedule scan --reads live --model stub --input SLACK_CHANNEL=C123
agentworkforce invoke ./hn-monitor/agent.ts --schedule scan --reads live --model live --input SLACK_CHANNEL=C123
agentworkforce deploy ./hn-monitor/agent.ts --mode cloud --dry-run
```

Local invocation always previews Slack actions; it never sends them. The
existing focused eval and preview scripts remain available until these platform
cases reach full runtime parity.

The Mac mini gate is a full proactive cloud run, not an SSH test. Deploy this
persona to a Cloud stage configured with `SANDBOX_PROVIDER=local` and
`LOCAL_SANDBOX_URL=https://sf-mac-mini.tailf3b8ad.ts.net`, then fire the
normal manual-trigger path:

```sh
agentworkforce trigger hn-monitor --workspace <workspace> --cloud-url <stage-url> --json
agentworkforce deployments logs hn-monitor --workspace <workspace> --cloud-url <stage-url> --tail 100
```

That exercises the real wakeup, cloud runtime, mini sandbox, model, memory,
and Slack delivery path. Use a dev channel because the trigger posts a real
digest.
