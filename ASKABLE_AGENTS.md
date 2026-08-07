# Askable proactive agents

Status: proposed class with one compile-ready, fail-closed GTM instance. Live
Revternal result quality is not verified because the authorized 1Password CLI
session was unavailable during the investigation. Nothing in this document
should be read as a production-readiness claim.

## Decision

Build **GTM Signal Scout first**, as one conversational agent with one recurring
sweep. Keep Recruiting Scout as a separate persona that can reuse the same
provider adapter and capability schema.

GTM is the better first fit for the data Revternal documents: public post text,
community, public author handle, URL, timestamps, and engagement counts are
directly useful for competitor mentions, objections, launch reaction, and topic
discovery. Recruiting can use the same public evidence to identify authors for
human review, but Listen does not document contact details, employment, title,
seniority, qualifications, or a complete commenter graph. Calling those people
"candidates" would overstate the source.

Use one agent per job, not a GTM/recruiting team behind one face. The two jobs
have different permissions, retention expectations, risk language, and output
contracts. A team adds routing and shared-state failure modes without adding a
new source today. Reconsider a team only when one face must coordinate several
independently permissioned sources or specialist agents. `teamSolve` is already
a consumer-defined persona capability, so no new team primitive is needed for
that future; persona-kit intentionally preserves unknown capabilities
unchanged ([source](https://github.com/AgentWorkforce/workforce/blob/8e10a7a45ce8/packages/persona-kit/src/types.ts#L458-L497),
[regression test](https://github.com/AgentWorkforce/workforce/blob/8e10a7a45ce8/packages/persona-kit/src/parse.test.ts#L1187-L1217)).

## What “askable” means

An askable agent has four contracts:

1. **Conversation is the primary query surface.** A relay DM reaches the
   deployed persona through `relay.inbox`, and the handler turns the question
   into an explicit provider query. It returns source URLs, timestamps, and
   coverage/freshness metadata with its synthesis.
2. **The provider is queried on demand.** Revternal is treated as a pull/search
   service reached through a Nango action, not a Nango sync whose rows become
   the conversational data model.
   The agent stores only durable watch definitions, dedupe identifiers, run
   provenance, and delivery state. It does not accumulate a general-purpose
   copy of Listen results.
3. **Capabilities are data.** The persona carries a versioned
   `capabilities.askable` object. The same exported object answers
   `capabilities --json` and human “what can you tell me?” requests. This uses
   persona-kit's existing consumer-defined capability pass-through instead of
   inventing a new top-level persona field ([type and contract](https://github.com/AgentWorkforce/workforce/blob/8e10a7a45ce8/packages/persona-kit/src/types.ts#L472-L505)).
4. **Watching is user-directed.** The user creates or removes durable watch
   definitions in conversation. A single deploy-time recurring sweep evaluates
   due watches. This is the mechanism available today; it is not represented as
   a dynamically created Relaycron recurrence.

The capability object must distinguish `verified`, `implemented_unverified`,
`documented_unverified`, and `blocked`. A catalog or another agent can therefore
avoid presenting a design target as a live capability.

## Revternal Listen: observed versus documented

The investigation fetched [the live Listen documentation](https://revternal.com/docs/listen)
and its deployed JavaScript bundle on 2026-08-07. Both returned HTTP 200. The
bundle identifies the base as `https://api.revternal.com` and the operation as
`POST /social/listen`.

Observed runtime behavior, with no valid credential used:

| Probe | Calls | Result |
| --- | ---: | --- |
| `GET /social/listen` | 1 | HTTP 405 with `Allow: POST` |
| `POST /social/listen` without `x-api-key` | 1 | HTTP 401 |
| `POST /social/listen` with a known-invalid placeholder | 1 | HTTP 401 |

The live docs say `x-api-key` is optional for Listen. The deployed 401 behavior
contradicts that statement, so this design treats the key as required. The
authorized 1Password CLI check could not complete unattended and timed out
after 8 seconds (exit 142). Per the credential-handling instruction, no other
credential location was searched and no keyed request was made.

The following are **documented, not successfully observed**:

- request fields: a 2–500 character query, one or more source configurations,
  filters, sort, page, and `per_page` from 1–100;
- a 15-minute server cache for identical requests;
- a shared-key limit of 60 requests/minute and HTTP 429 behavior;
- response groups `meta`, `results`, and `source_status`;
- result fields for source identity/URL, timestamps, title/body, public
  author/community, and engagement counts;
- source enums for Reddit, Hacker News, Dev.to, Twitter, and Product Hunt, while
  the same docs say only the Reddit fetcher is currently registered.

There is no successful-call latency, result-volume, pagination, freshness, or
ranking measurement to report. Therefore the central hypothesis—“one Listen
call answers a real question quickly enough that no cache is needed”—remains
unsettled. The first production gate is a small authenticated measurement set:
page 1, page 2, and an identical repeat, recording exact call count, query,
latency, result count, pagination overlap, `fetched_at`, and source status. Until
that passes, on-demand query is an architectural target rather than an
advertised live capability.

### Data boundary

Nango is the canonical credential-and-endpoint boundary, but it should not
become the agent's memory. Cloud's current Nango path
materializes provider records before dispatching deltas; that is a sync model,
not a conversational query contract
([sync runtime](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/core/src/sync/nango-sync-runtime.ts#L150-L215),
[webhook router](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/integrations/nango-webhook-router.ts#L7767-L7927)).

Askable persists only:

- the normalized query plan and user-requested cadence;
- the requesting relay identity;
- last-run time, source coverage, and provider freshness;
- source IDs/content hashes needed for change detection;
- delivery idempotency and failure state.

It does not persist raw result bodies merely to make later chat possible.
Historical trend questions are a separate, opt-in product capability with an
explicit retention policy.

The built prototype stores a versioned full-state snapshot in workspace memory
with the persona's 90-day TTL. That proves the conversation-to-state path, but
it is not a transactional watch database: concurrent updates have no
compare-and-set protection, and a watch that is never refreshed can expire.
A first-class watch table or Relayfile control record with concurrency control
is a production gate.

## User-directed scheduling, end to end

### What works now

The built GTM instance declares one static schedule in `agent.ts`:
`*/15 * * * *`. On deploy, Cloud statically extracts `defineAgent.schedules`
([extractor](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/proactive-runtime/persona-resolve.ts#L770-L805))
and registers the cron with Relaycron
([registration](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/proactive-runtime/persona-deploy.ts#L1847-L1894)).
Cloud's embedded `packages/relaycron` plus the published
`@relaycron/server@^0.1.3` is authoritative, not the older standalone checkout
([Cloud deployment](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/infra/relaycron.ts#L64-L149),
[package](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/relaycron/package.json#L1-L15)).

The conversational flow is:

```text
relay DM: "watch Acme migration pain every 6h"
  -> handler validates query and cadence
  -> handler persists a WatchDefinition in workspace memory
  -> reply includes watch id and the shared 15-minute sweep limitation
  -> next static Relaycron tick loads all watch definitions
  -> due watches become Listen requests
  -> source ids are diffed against per-watch seen ids
  -> only new evidence is DMed to the requesting relay identity
```

This turns an utterance into a durable recurring **query definition** evaluated
by one real recurring Relaycron schedule. It does not create one Relaycron
schedule per utterance. That distinction is load-bearing.

### What the dynamic API actually supports

The public runtime exposes only `ctx.schedule.at(Date, payload)` and
`ctx.schedule.cancel(name)`—there is no `every`, `cron`, or `interval`
([runtime type](https://github.com/AgentWorkforce/workforce/blob/8e10a7a45ce8/packages/runtime/src/types.ts#L292-L295)).
The generated cloud runner POSTs one future `scheduledAt`
([runner](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/persona-compile-worker/src/index.ts#L557-L598));
the database has a mandatory `scheduled_at` and terminal `fired` state but no
recurrence field
([schema](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/db/schema.ts#L400-L449));
and Relaycron registration hard-codes `schedule_type: "once"`
([client](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/proactive-runtime/agent-gateway-relaycron-client.ts#L194-L262)).
The later tick also carries only a summary-derived dynamic payload rather than
the arbitrary stored query object
([tick route](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/app/api/v1/workspaces/%5BworkspaceId%5D/deployments/%5BagentId%5D/schedules/%5BscheduleId%5D/ticks/route.ts#L154-L174)).

To make a literal utterance create its own recurring Relaycron entry, Cloud
would need a recurrence-aware dynamic schedule schema/API, `ctx.schedule.cron`
or equivalent, full payload delivery, update/cancel semantics, and policy limits.

## Capability discovery

The built persona's `capabilities.askable` is the source for:

- `capabilities --json` (machine-readable relay response);
- “what can you tell me?” (human-readable response);
- future catalog ingestion.

Persona-kit already preserves the custom block. Agentrelay.com does not yet
consume it: the site uses a hand-authored `Agent` interface and static array
without capability or commercial fields
([catalog type](https://github.com/AgentWorkforce/agentrelay.com/blob/89a062abd3e4/web/lib/agents.ts#L1-L54)),
and the detail page renders that object directly
([detail](https://github.com/AgentWorkforce/agentrelay.com/blob/89a062abd3e4/web/app/agents/%5Bslug%5D/AgentDetail.tsx#L1-L96)).
A catalog manifest ingestion/read API and UI rendering are required before a
user or remote agent can discover capabilities without messaging the deployed
agent.

## Concrete persona 1: GTM Signal Scout

Built in [`askable-gtm/`](askable-gtm/).

Questions it is designed to answer after the credential bridge and live-result
gate exist:

- Which high-engagement public Reddit posts mention a competitor this week?
- What objections or migration pain recur around a category?
- Which communities and public authors are discussing a launch or tool?
- What feature requests appear in the returned post text?

What it surfaces: source URL and id, timestamp/freshness, title/body excerpt,
public author handle/profile if supplied, community, score/comment counts, and
per-source coverage/status. Objection, theme, or sentiment labels are agent
inference and must be marked as such.

Watches: new competitor mentions, new launch reaction, new posts meeting an
engagement threshold, and periodic objection/feature-request digests. Current
implementation supports query-and-cadence watch definitions on the shared
15-minute sweep; threshold configuration is a design target.

Credential and endpoint: one Nango query path with two pair sources. The
primary pair comes from the user's connection; the managed Agent Workforce pair
comes from Nango environment variables and is selected inside the same action
only after paid entitlement and quota authorization. The API host travels with
the selected credential. Neither value is a persona input or handler
environment variable.

## Concrete persona 2: Recruiting Scout

Questions it could answer from the same public evidence:

- Who is publishing substantive public posts about a skill or tool in selected
  technical communities?
- Which public authors recur in high-engagement results over an opted-in
  retention window?
- Which posts contain explicit public job-search or hiring language?

What it surfaces: public handle/profile supplied by Listen, supporting posts,
source URLs/timestamps, community, and engagement. It must say “lead for human
review,” not “qualified candidate.”

Watches: first-time public authors on a niche topic, repeat authors over an
opted-in history window, and new posts containing explicit job-search/hiring
language.

Credential and endpoint: the same single Nango path as GTM. Recruiting also
needs a stricter retention/deletion policy and must not infer protected traits,
employment, contact information, or qualification from absent fields.

## Credential and commercial model

### Concrete answer: how a user adds the key

**Today, they cannot add a Revternal key in Agent Workforce.** Cloud has a real
Nango connection UX, but Revternal is absent. At Cloud commit `bc41e61aad15`, a
repository search found no `revternal` provider, UI card, Nango integration, or
action. The current Integrations page enumerates its supported providers and
does not list Revternal
([page](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/app/integrations/page.tsx#L117-L164)).

The required user path is concrete:

1. Open **Workspace Integrations** at `/integrations` and click **Connect
   Revternal**.
2. Cloud requests a server-issued, provider-restricted Nango Connect session;
   the existing UI already does this for registered providers
   ([session request and hosted UI](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/app/integrations/IntegrationConnectionControls.tsx#L103-L185)).
3. In Nango's hosted form, paste the Revternal API key. The user does **not**
   supply a base URL: the hosted Revternal endpoint is visibly shown and stored
   with the connection rather than silently compiled into the persona.
4. Nango stores the secret credential and the endpoint connection config as one
   connection. Cloud stores only the returned `connectionId` and
   `providerConfigKey`
   ([save contract](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/app/integrations/IntegrationConnectionControls.tsx#L188-L207)).

The future persona declaration is:

```ts
integrations: {
  revternal: { source: { kind: 'workspace' } }
}
```

Persona-kit already defines `source` as the connection resolver, and Cloud's
normalizer accepts `workspace`
([resolver contract](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/integrations/persona-integration-config.ts#L1-L35)).
The prototype deliberately does **not** declare this yet: deployment cannot
resolve a provider that Cloud has not registered.

Existing personas prove only the safe half of this shape. `neon-monitor`
declares a Neon integration, reads Relayfile VFS data, and receives no token
([persona](https://github.com/AgentWorkforce/agents/blob/a84c55cd2623/neon-monitor/persona.ts#L28-L61));
the Neon Nango code says an API-key connection is stored in Nango and injected
into Nango requests
([Nango adapter](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/nango-integrations/neon-relay/shared/neon-api.ts#L1-L2)).
No existing persona performs an on-demand generic Nango action. The proactive
runtime's integration environment resolver special-cases Daytona only
([runtime resolver](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts#L1698-L1733)).
Therefore a new secretless Cloud-to-Nango query bridge is required; the handler
must never receive the key or endpoint.

### Credential and endpoint are one fact

The Nango action resolves a pair, not two independent settings:

```text
user connection:    { connection credential, connection-config endpoint }
managed fallback:   { REVTERNAL_API_KEY, REVTERNAL_BASE_URL } from Nango environment
action output:       { results, credentialSource, endpointHost } (no secret)
```

This prevents a production credential from drifting onto a different host.
Sending a valid key to the wrong host is credential exposure, not merely
configuration failure. Existing PostHog integration code
can read `host`/`baseUrl` from Nango connection config, but falls back to a
hard-coded default
([implementation](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/nango-integrations/posthog-relay/shared.ts#L212-L222)).
Revternal should reuse the endpoint-bearing connection shape, not that fallback:
the agent bundle must contain neither an endpoint constant nor a default URL.
Every successful result discloses the selected host; the future gateway must
also expose normalized, non-secret connection metadata so “which host are you
using?” can be answered without making a provider request.
This is an Askable-agent class invariant for every external API: the connection
supplies the credential and endpoint together; the persona hardcodes neither.
Self-hosting is deferred, and the endpoint-bearing connection means supporting
it later is a connection-configuration change rather than an agent rewrite.

### One resolver, two secret sources

The future `revternal-relay/listen` Nango action is the only query path:

1. Resolve the workspace connection. If it contains a user API-key credential,
   use that credential with its connection-config endpoint and report
   `credentialSource: "user"`.
2. If the user key is absent, require a trusted Cloud entitlement decision and
   an atomic quota reservation **before** reading the managed Nango environment
   variables. Nango functions can read environment variables today
   ([existing use](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/nango-integrations/shared/composio-tool.ts#L54-L72)).
3. If entitlement or quota is absent, indeterminate, or exhausted, fail closed.
   Missing BYOK must never automatically unlock the managed credential.
4. Return non-secret `credentialSource` and a normalized, allowlisted display
   host with the result. The persona rejects userinfo, path, query, fragment,
   control characters, and overlong values before display. Managed answers and
   alerts say: “Using Agent Workforce managed Revternal access; usage counts
   against your paid allowance.”

There is an additional unimplemented edge: Cloud's current Nango action calls
are connection-bound, but a managed-only user has no API-key connection created
by Connect. Cloud must prove and implement a safe Nango-supported keyless
workspace/service-account connection, or an equivalently scoped broker, without
using a fake key, plaintext connection config, or persona input. That decision
cannot be hidden behind the persona prototype.

### Headline commercial gap: managed fallback is unsafe today

There is no Revternal paid entitlement, per-user/workspace Listen meter,
enforceable quota, or shared-key rate coordination. The existing spend writer
records model/harness token cost and merely logs when its soft cap is exceeded
([implementation](https://github.com/AgentWorkforce/cloud/blob/bc41e61aad15/packages/web/lib/billing/spend-writer.ts#L29-L87));
it is not a Listen gate.

Before the managed Nango environment fallback can be configured, Cloud needs:

- an authoritative paid entitlement checked on every fallback request;
- an atomic usage reservation and request ledger keyed to user and workspace;
- hard period, concurrency, and rate quotas plus idempotency;
- `user`/`managed` source audit, rotation, abuse controls, and a kill switch;
- agentrelay.com tier/entitlement UI that disables launch when authorization is
  absent.

A shared managed key with no hard policy boundary lets one tenant exhaust the
upstream allowance for every tenant. “Paid” display metadata is not enforcement.

## Not possible today

- Claiming successful Listen answers, latency, pagination, freshness, ranking
  quality, or result volume from this investigation; no keyed call completed.
- Treating Listen authentication as optional; deployed missing/invalid-key
  requests returned 401 despite the docs.
- Direct utterance-to-recurring-Relaycron creation through `ctx.schedule`.
- Arbitrary per-watch cron/timezone schedules; the built workaround uses one
  deploy-time 15-minute sweep and evaluates due watch state.
- Preserving arbitrary dynamic schedule payloads to the later tick.
- Native Listen subscriptions, webhooks, streaming, or API-configured Slack/
  email delivery.
- Guaranteed real-time behavior; the documented interface is pull-based and
  identical requests are documented as cached for 15 minutes.
- Reliable production coverage beyond Reddit; other platforms are schema enums,
  while the docs say only the Reddit fetcher is registered.
- Full comments/commenter graph, downvotes, exposed relevance scores, contact
  details, employer/title, candidate seniority, or verified qualifications from
  the documented response.
- Historical trends, repeat-author analysis, or exactly-once alerts without
  explicit Askable-owned retention/dedupe state.
- Transaction-safe concurrent watch edits or indefinite watch retention from
  the prototype's 90-day workspace-memory snapshot.
- Safe Boolean query grammar or known Listen credit cost; neither is documented.
- BYOK Revternal deployment through today's Cloud integration registry.
- Adding a Revternal credential or endpoint through today's `/integrations`
  catalog.
- Calling a generic Nango action from a deployed persona handler.
- Provisioning a proven connection-bound execution context for managed-only
  access without requiring a user key.
- Managed/premium Revternal access with today's catalog and billing enforcement.
- Automatic catalog discovery of `capabilities.askable`; agentrelay.com is still
  a static hand-authored catalog.

## Production gates

1. Complete the three-call authenticated Listen measurement described above.
2. Add the Revternal provider, endpoint-bearing Nango connection, single query
   action, secretless persona bridge, and redaction/host-validation tests.
3. Add recurrence policy only if per-watch native Relaycron entries are still
   preferable to the shared-sweep design.
4. Ingest and expose `capabilities.askable` through the catalog.
5. Add entitlement, atomic metering/hard quota, managed-key kill switch, and a
   proven managed-only connection context before configuring the managed Nango
   environment variables or marking the catalog entry paid.
6. Deploy to a non-production workspace and verify relay Q&A, watch persistence,
   tick delivery, result citations, dedupe, and credential non-disclosure.
