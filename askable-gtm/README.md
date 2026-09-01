GTM Signal Scout
================

Instantly launch this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/agents/blob/main/askable-gtm/persona.ts)

Ask it what the market is saying, get cited public posts back.

It searches **LinkedIn** through [Revternal](https://revternal.com) — the
strongest public surface for B2B go-to-market chatter — and answers with the
post, its author, its engagement, and a link. Save a query as a watch and it
re-runs on a 15-minute sweep, DMing you only what is new.

Deploy
------

Launch it with the button above, then:

1. **Connect Revternal.** Open **Integrations → Connect Revternal** and paste
   your Revternal API key. It is stored with the provider and the agent never
   sees it — every query is authorized per request. Without this the deploy
   fails rather than shipping a half-wired agent.
2. **Set `SLACK_CHANNEL`** (optional) to a channel id. With it, `@mention` the
   agent there and it answers in a thread. Without it, the agent is relay-only.

Or from a shell:

```bash
agentworkforce deploy ./askable-gtm/persona.ts
```

Your Revternal key belongs on the provider connection, never in an agent input:
nothing here reads a key, and a value passed at deploy time shows up in logs.

Talk to it
----------

```text
what are developers saying about observability pricing?   any GTM question
watch <query> every <15m|1h|6h|12h|24h|7d>                save it
watches                                                   list yours
unwatch <watch-id>                                        stop one
what can you tell me?                                     what it does
capabilities --json                                       the same, as JSON
```

A watch is a durable query definition evaluated by one shared sweep, not a
schedule of its own. Saved watches deliver only posts you have not been sent.

What it will and won't say
--------------------------

Every claim is a real post, cited with whatever the provider returned for it —
URL, timestamp, author, engagement, excerpt. A post that did not come back from
the provider never appears in an answer, and a field the provider omitted is
left out rather than guessed.

When the provider fails, the answer says so rather than returning a short list
as if that were the whole market. A zero-result answer during an outage is
reported as an outage, never as "nothing was posted".

Themes, intent, and sentiment are inference, not evidence, and are labelled as
such.

Verify
------

```sh
npm run typecheck
node scripts/test.mjs tests/askable-gtm.test.mjs

# End to end against the real gateway, Nango, and Revternal:
node scripts/acceptance/askable-gtm-live.mjs "your gtm question"
```

The acceptance script exits 0 either way and states whether it saw live signal
or a provider outage, so it doubles as a health check.
