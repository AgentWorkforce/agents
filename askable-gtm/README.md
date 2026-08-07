# GTM Signal Scout

An askable proactive-agent prototype for public GTM signals. It has a relay
conversation surface, a machine-readable capability manifest, durable user
watch definitions, and a real deploy-time 15-minute sweep.

It intentionally fails closed for live Revternal access. The current Cloud
runtime has no scoped Revternal integration/credential bridge, so this persona
does not declare or accept an API key input. Do not add a key to `persona.ts`, a
fixture, a README command, or Relayfile.

## Conversation contract

```text
what can you tell me?
capabilities --json
watch <query> every <15m|1h|6h|12h|24h|7d>
watches
unwatch <watch-id>
<any GTM signal question>
```

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
