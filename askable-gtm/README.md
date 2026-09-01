# GTM Signal Scout

Ask it what the market is saying, get cited public posts back.

It searches **LinkedIn** through [Revternal](https://revternal.com) — the
strongest public surface for B2B go-to-market chatter — and answers with the
post, its author, its engagement, and a link. Save a query as a watch and it
re-runs on a 15-minute sweep, DMing you only what is new.

[![Deploy this agent](https://img.shields.io/badge/Deploy-this%20agent-2ea44f?style=for-the-badge&logo=github)](../../actions/workflows/deploy-agent.yml)

## Deploy

1. **Connect Revternal.** In your workspace, open **Integrations → Connect
   Revternal** and paste your Revternal API key. It is stored with the
   provider, and the agent never sees it — every query is authorized per
   request. Without this the deploy fails loudly rather than shipping a
   half-wired agent.
2. **Set up the workspace secrets** once, per [`../docs/SELF-DEPLOY.md`](../docs/SELF-DEPLOY.md).
3. **Run the deploy** with the button above — pick `askable-gtm`, and add
   `SLACK_CHANNEL=C0123ABCD` under agent inputs to answer in a Slack channel.

`SLACK_CHANNEL` is optional. With it, `@mention` the agent in that channel and
it replies in a thread. Without it, the agent is relay-only.

> Never put your Revternal key in the deploy input box — values typed there
> appear in the run log, and nothing in this agent reads a key anyway. The
> Integrations connection above is the only path.

## Talk to it

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

## What it will and won't say

Every claim carries its source: URL, timestamp, author, engagement, and an
excerpt. A post that did not come back from the provider never appears in an
answer.

When a source fails, the answer says so — `(reddit unavailable this request)` —
rather than returning a shorter list as if that were the whole market. A
zero-result answer during an outage is reported as an outage, never as "nothing
was posted".

Themes, intent, and sentiment are inference, not evidence, and are labelled as
such.

## Verify

```sh
npm run typecheck
node scripts/test.mjs tests/askable-gtm.test.mjs

# End to end against the real gateway, Nango, and Revternal:
node scripts/acceptance/askable-gtm-live.mjs "your gtm question"
```

The acceptance script exits 0 either way and states whether it saw live signal
or a provider outage, so it doubles as a health check.

## Notes

Revternal also registers a Reddit source. Their Reddit fetcher scrapes the
unauthenticated public endpoint and has been returning `403 Blocked` upstream —
check `curl https://api.revternal.com/reddit/health`. The agent still queries
it, reports it as unavailable when it fails, and answers from LinkedIn.

Design, evidence, and the commercial boundary:
[`../ASKABLE_AGENTS.md`](../ASKABLE_AGENTS.md).
