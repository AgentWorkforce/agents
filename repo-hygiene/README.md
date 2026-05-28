Repo Hygiene Agent
==================

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/repo-hygiene/persona.ts)

A proactive dogfood agent that watches GitHub pull requests and reviews them
for codebase entropy: duplicated or dead code, divergent paths that should be
consolidated, stale skills/rules/docs, and maintainability smells.

On every PR open or update it:

- reads the PR metadata and diff through the GitHub Relayfile integration
- runs a read-only hygiene diagnosis in the materialized repository
- posts a concise GitHub PR comment with findings and follow-ups
- creates a Notion journal page for the run
- optionally posts a Slack summary
- remembers prior findings so repeated divergence can be tracked over time

## Inputs

| Input | Required | Purpose |
| --- | --- | --- |
| `NOTION_DATABASE_ID` | yes | Notion database that receives run journals. |
| `SLACK_CHANNEL` | no | Slack channel for high-level run summaries. |
| `MAX_DIFF_CHARS` | no | Maximum PR diff characters included in the diagnosis prompt. Defaults to `40000`. |

## Current Safety Boundary

The first dogfood slice is read-only. It never modifies files and it never
pushes commits. Fix mode should be added behind explicit labels such as
`agent-hygiene:fix` or `agent-hygiene:patch-this-pr` after the diagnostics and
journals prove useful.

## Useful Next Step

After read-only runs are trusted, add a second phase that opens a separate
cleanup PR for approved findings. Keep deletion, public API changes, generated
artifact rewrites, migrations, and auth-path edits behind human approval.
