# GTM Signal Scout

An askable proactive-agent prototype for public GTM signals. It has a Slack
chat surface, a relay inbox for agent-to-agent traffic, a machine-readable
capability manifest, durable user watch definitions, and a real deploy-time
15-minute sweep.

It intentionally fails closed for live Revternal access. The runtime path is a
cloud-backed Revternal listen route, not a persona-held credential, so this
persona does not declare or accept an API key or endpoint input. Do not add a
key or provider base URL to `persona.ts`, `agent.ts`, a fixture, a README
command, or Relayfile.

The product flow is Workspace Integrations (`/integrations`) → Connect
Revternal. Hosted users paste their API key and confirm the visible hosted
provider endpoint; they do not supply a base URL. Nango stores the user-owned
credential and endpoint together. Managed access uses the same Nango action but
a gated environment-held pair. Revternal is registered in Cloud's provider
catalog as of cloud#3093, and this workspace's connection is live.

## Known blockers (2026-08-31)

The provider chain is verified working, but two things outside this repo stop
the agent from being useful. See [`../ASKABLE_AGENTS.md`](../ASKABLE_AGENTS.md)
for the evidence table.

1. **Revternal's Reddit fetcher is 403-blocked upstream.** Reddit is their only
   registered source, so every query returns zero results. Check with
   `curl https://api.revternal.com/reddit/health`. The agent reports this as a
   source outage rather than an empty market — a zero-result answer here is
   never a finding that nothing was posted.
2. **A relay DM does not wake a deployed agent.** The Agent Gateway's durable
   delivery drain matched the Relaycast recipient id against the Cloud
   deployment UUID and skipped every row, so the relay inbox is dead until the
   fix (cloud PR #3230) ships and the gateway is released. Slack is the working
   human surface in the meantime.

## Conversation contract

```text
what can you tell me?
capabilities --json
watch <query> every <15m|1h|6h|12h|24h|7d>
watches
unwatch <watch-id>
<any GTM signal question>
```

Human chat runs through Slack `@mention` in the configured channel. The relay
inbox remains available for agent-to-agent usage, not as the primary human
entry point. Saved watches created from Slack deliver later updates by Slack DM
to the requesting user; relay-created watches continue to deliver over relay.

Watch requests are durable query definitions evaluated by the shared static
sweep. They do not create one dynamic Relaycron recurrence per utterance.

## Verify locally

```sh
npm run typecheck
node scripts/test.mjs tests/askable-gtm.test.mjs
agentworkforce persona compile ./askable-gtm/persona.ts
```

## Verify against live production

Drives the real handler through the real Cloud action gateway, Nango, and
Revternal, stubbing only the chat transport. Uses your existing CLI login:

```sh
node scripts/acceptance/askable-gtm-live.mjs "your gtm question"
```

It exits 0 either way and says whether it saw live signal or the vendor
outage, so it doubles as the recovery check.

See [`../ASKABLE_AGENTS.md`](../ASKABLE_AGENTS.md) for evidence, both persona
designs, the commercial boundary, and the explicit production gaps.
