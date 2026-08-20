# GTM Signal Scout

An askable proactive-agent prototype for public GTM signals. It has a Slack
chat surface, a relay inbox for agent-to-agent traffic, a machine-readable
capability manifest, durable user watch definitions, and a real deploy-time
15-minute sweep.

It intentionally fails closed for live Revternal access. The current Cloud
runtime has no Revternal provider or persona-to-Nango action bridge, so this
persona does not declare or accept an API key or endpoint input. Do not add a
key or provider base URL to `persona.ts`, `agent.ts`, a fixture, a README
command, or Relayfile.

The required product flow is Workspace Integrations (`/integrations`) → Connect
Revternal. Hosted users paste their API key and confirm the visible hosted
provider endpoint; they do not supply a base URL. Nango stores the user-owned
credential and endpoint together. Managed access uses the same Nango action but
a gated environment-held pair. This UI is a design target today: Revternal is
not yet registered in Cloud's provider catalog.

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

See [`../ASKABLE_AGENTS.md`](../ASKABLE_AGENTS.md) for evidence, both persona
designs, the commercial boundary, and the explicit production gaps.
