---
name: creating-cloud-persona
description: Use when creating, updating, or reviewing a Workforce cloud persona (`persona.ts` + `agent.ts`) for the current deploy/runtime shape. Covers cloud, useSubscription, integrations with scope mounting/enabledByInput gating/adapter config passthrough, inputs, memory, sandbox modes, onEvent, runtime fields, capabilities, defineAgent triggers/schedules/watch/team-dispatcher launch, provider IO via @relayfile/relay-helpers, multi-transport delivery, ctx.relay messaging, and the deploy flow.
---

# Creating Cloud Persona

Use this skill when authoring a deployable Workforce persona in the **current** shape.

## Core rule

A cloud persona is two files that ship **as a pair**:

1. `persona.ts` (`definePersona({...})`) declares **deployment metadata and runtime wiring**, and points at the handler via `onEvent: './agent.ts'`. It compiles to `persona.json` (a generated, gitignored artifact — author `persona.ts`, never the compiled JSON).
2. `agent.ts` (`export default defineAgent({...})`) implements the **actual behavior**.

**Always ship both.** The runtime's composable-runtime closure treats `persona.ts`
as the canonical entry; a bare `agent.ts` with no sibling `persona.ts` falls back
to a **synthesized minimal-preview persona** (and emits a compatibility warning) —
you lose the real harness/model/integration/memory wiring. (The
`composable-runtime-closure` acceptance harness in the agents repo pins this: it
fails if a deploy synthesizes a persona instead of loading `persona.ts`.)

Important: **triggers, schedules, and watch rules are declared in `agent.ts` via `defineAgent(...)`, while `persona.ts` declares deploy/runtime config and integration connection requirements.**
The handler branches on `event.type` (a provider-prefixed dotted string like
`slack.message.created`, `linear.issue.create`, or `cron.tick`) and reads the
payload via `await event.expand('full')`. **See "Event model (v4)" below — the
pre-v4 `event.source` / `event.payload` / `event.name` shape is GONE in
runtime ≥ 4, and most of the inline examples further down still use it.**

## First read

Before authoring, read the vendored examples and current types in this skill's
`references/` directory. They are copied from the current Workforce and agents
repos so the skill is self-contained.

Production agents — each is a **`persona.ts` + `agent.ts` pair**. `persona.ts` is
the **authored source** (edit it, never the JSON). Each reference dir also carries
a `persona.json` — the **compiled artifact** (`agentworkforce persona compile
<dir>/persona.ts`, persona-kit 4.1.23) — vendored so you can see the shipped shape;
in the live agents repo that file is gitignored (`*/persona.json`) and regenerated
on demand:

- `references/agents/review/{persona.ts,agent.ts}` — PR reviewer: harness run + VFS github reads, per-PR Slack thread, merge, `capabilities.conflictResolve`
- `references/agents/repo-hygiene/{persona.ts,agent.ts}` — sandboxed shell + Notion writeback via VFS `writeJsonFile`/`draftFile`
- `references/agents/linear/{persona.ts,agent.ts}` — Linear Agent Session API (`linearClient().agentActivity/respond/acknowledge`) + thin-lead `ctx.workflow.run` delegation
- `references/agents/linear-slack/{persona.ts,agent.ts}` — harness-emits-fenced-actions rail, receipt-gated Linear writes
- `references/agents/hn-monitor/{persona.ts,agent.ts}` — `@agentworkforce/delivery` multi-transport, threaded digest, two-tier `ctx.memory` + `ctx.files` state
- `references/agents/joke-bot/{persona.ts,agent.ts}` — `sandbox: false` conversational bot, triple transport, `capabilities.conversational`
- `references/agents/inbox-buddy/{persona.ts,agent.ts}` — `sandbox: true` **required** for VFS Gmail reads, dual-transport, cross-turn memory
- `references/agents/gcp-watcher/{persona.ts,agent.ts}` — token-free VFS monitor, dedup by signature, pure exported `evaluateSignals`
- `references/agents/cloud-team-implementer/{persona.ts,agent.ts}` and `references/agents/cloud-team-reviewer/{persona.ts,agent.ts}` — team members (`launchedBy: 'team-dispatcher'`)

Workforce examples:

- `references/workforce/examples/review-agent/persona.json`
- `references/workforce/examples/review-agent/agent.ts`
- `references/workforce/examples/weekly-digest/persona.json`
- `references/workforce/examples/weekly-digest/agent.ts`
- `references/workforce/examples/linear-shipper/persona.json`
- `references/workforce/examples/linear-shipper/agent.ts`
- `references/workforce/examples/notion-essay-pr/persona.json`
- `references/workforce/examples/notion-essay-pr/agent.ts`
- `references/workforce/examples/proactive-issue-resolver/persona.json`
- `references/workforce/examples/proactive-issue-resolver/agent.ts`

Current types and deploy checks:

- `references/workforce/packages/persona-kit/src/types.ts`
- `references/workforce/packages/runtime/src/types.ts`
- `references/workforce/packages/persona-kit/schemas/persona.schema.json`
- `references/workforce/packages/deploy/src/preflight.ts`
- `references/workforce/packages/deploy/src/extract-agent.ts`
- `references/workforce/packages/cli/src/deploy-command.ts`
- `references/relayfile-adapters/packages/relay-helpers/README.md`

## Current persona shape to follow

Prefer the **actual shipped shape**, not older plan text.

For cloud personas, expect fields like:

- `id`
- `intent`
- `tags`
- `description`
- `cloud: true`
- `useSubscription` (optional)
- `integrations` (optional, for provider connection requirements, mount scope, and adapter config passthrough — see Authoring rules 3 and 4)
- `memory` (optional; production agents use both `true` and object form)
- `onEvent`
- top-level runtime fields, when the agent uses a harness:
  - `harness`
  - `model`
  - `systemPrompt`
  - `harnessSettings`
- optional `inputs`, `env`, `sandbox`, `skills`, `permissions`, `mount`, `mcpServers`, `capabilities`, `relay`

Do **not** author older `tiers` / `defaultTier` structures unless the repo explicitly still uses them. The latest Workforce examples use flat top-level runtime fields.

## Mental model

### `persona.json` does

- declares whether the persona is deployable
- chooses the harness/model/runtime knobs
- declares which integrations must be connected
- enables memory
- points at the handler entrypoint
- optionally declares capabilities/metadata

### `agent.ts` does

- exports `defineAgent({...})`
- declares `triggers`, `schedules`, and optionally `watch`; team-member agents
  can intentionally declare none and use `launchedBy: 'team-dispatcher'`
- receives `ctx` and `event` in `handler`
- branches on `event.type` (provider-prefixed dotted string, or `cron.tick`)
- reads the payload via `await event.expand('full')` (see "Event model (v4)")
- reads and writes provider data through **`@relayfile/relay-helpers`** clients (`linearClient().comment(...)`, `slackClient().post(...)`, `githubClient().mergePullRequest(...)`, or the generic `relayClient(provider)` / `providerClient(provider)`) — catalog-backed, no hardcoded paths. The raw `@agentworkforce/runtime` VFS helpers (`readJsonFile` / `writeJsonFile`) stay the lower-level fallback. There are **no** per-provider clients on `ctx` (no `ctx.github` / `ctx.linear`)
- optionally calls `ctx.harness.run(...)`
- optionally calls `ctx.llm.complete(...)` for smaller synthesis
- optionally delegates to `ctx.workflow.run(...)`
- optionally uses `ctx.files.*` or `ctx.sandbox.*`
- optionally uses `ctx.memory.*`
- performs the actual workflow

## Trigger model

Cloud agents currently have four practical shapes, and wakeups are authored in
`agent.ts`:

1. **Clock** via `defineAgent({ schedules: [...] })`
   - branch on `event.type === 'cron.tick'`
   - the cron event carries `event.schedule` (the cron expr / one-shot id) and
     `event.scheduledFor` — there is **no** `event.name`. For a single-schedule
     persona, treat any `cron.tick` as that schedule (see gotcha §G2).

2. **Radio** via `defineAgent({ triggers: { <provider>: [...] } })`
   - the event's `type` is the **provider-prefixed** `on` value: a trigger
     `{ slack: [{ on: 'message.created' }] }` delivers `event.type ===
     'slack.message.created'`
   - branch with `event.type === '<provider>.<on>'` (or
     `event.type.startsWith('<provider>.')` for a whole provider)
   - a trigger can carry `paths: ['/slack/channels/${SLACK_CHANNEL}/**']` to
     **scope wake-routing before provisioning** (and `match: '@mention'` /
     `where: 'field=value'` to gate further — see §2 wake-cost). The `${INPUT}`
     token is **deploy-time input-ref substitution inside a single-quoted
     string** (resolved from the persona input at deploy), **not** JS template
     interpolation — write it literally, don't backtick-interpolate it.
   - provider names in triggers are **canonicalized at deploy** via known
     aliases (e.g. `google-mail` → `gmail`), so an alias in a trigger still
     matches its integration; keep the `integrations` key in the form the
     adapter documents.

3. **Relayfile watch** via `defineAgent({ watch: [...] })`
   - for file/path-driven proactive behavior
   - keep this for cases that are truly about Relayfile path changes, not provider event hooks

4. **Team member** via `defineAgent({ launchedBy: 'team-dispatcher', handler })`
   - no direct triggers/schedules/watch
   - launched by a lead/team dispatcher to avoid duplicate subscriptions
   - see `references/agents/cloud-team-implementer/agent.ts` and
     `references/agents/cloud-team-reviewer/agent.ts`

`persona.json.integrations` still matters, but for **connection/setup**, not for declaring which events fire the handler.

## Event model (v4) — verified against workforce 4.1.34 (agents repo pins runtime/persona-kit 4.1.23)

The handler `event` is the relay SDK's normalized `AgentEvent`
(`@agent-relay/events`), narrowed by `defineAgent` to the triggers/schedules you
declared. **The pre-v4 `{ source, payload, workspaceId }` shape — and
`WorkforceProviderEvent` / `WorkforceCronEvent` — were removed.** Authoring
against them fails to typecheck (`has no exported member 'WorkforceProviderEvent'`,
`Property 'source' does not exist`). Many examples below still show the old shape;
prefer this section.

- **Discriminant is `event.type`** — a dotted, provider-prefixed string:
  `cron.tick`, `slack.message.created`, `linear.issue.create`,
  `github.pull_request.opened`. There is no `event.source`.
- **Payload is async**: `const data = (await event.expand('full')).data;` — not a
  synchronous `event.payload`. `event.resource` is the resource handle;
  `event.id` / `event.workspace` / `event.occurredAt` still exist.
- **Cron**: `event.type === 'cron.tick'`; the fired schedule is `event.schedule`
  (cron expr / one-shot id) + `event.scheduledFor`. **No `event.name`.**
- **Import** `WorkforceEvent` (alias of `AgentEvent`) for helper signatures;
  don't import the removed `WorkforceProviderEvent`.

Canonical v4 handler:

```ts
import { defineAgent, type WorkforceCtx, type WorkforceEvent } from '@agentworkforce/runtime';

export default defineAgent({
  schedules: [{ name: 'daily', cron: '0 9 * * 1-5' }],
  triggers: { github: [{ on: 'pull_request.opened' }], slack: [{ on: 'message.created', match: '@mention' }] },
  handler: async (ctx, event) => {
    if (event.type === 'cron.tick') return runDaily(ctx);            // single schedule → no name gate
    if (event.type === 'github.pull_request.opened') {
      const data = (await event.expand('full')).data;               // payload is async
      return reviewPr(ctx, data);
    }
    if (event.type === 'slack.message.created') {
      const data = (await event.expand('full')).data;
      return replyMention(ctx, data);
    }
  }
});
```

Exhaustiveness note: when your declared triggers/schedules narrow `event` to a
closed union and you handle every case, a trailing `event.type` access is `never`
and won't typecheck — drop the unreachable fallback rather than casting.

## Authoring rules

### 1. Prefer one `defineAgent(...)` file

Default to one `agent.ts` per persona, exporting one `defineAgent({...})` with internal branching:

- `if (event.type === 'cron.tick') ...`
- `if (event.type === 'github.pull_request.opened') ...`

Do not split into many handlers unless the behavior is truly large.

### 2. Keep wakeups declarative in `defineAgent(...)`, behavior imperative in the handler

Use `defineAgent(...)` to declare **what can wake the agent**.
Do not try to encode the workflow in `persona.json`.
The actual routing and business logic belong in `agent.ts`.

### 3. Only declare integrations the agent actually requires — with a `scope`

If `agent.ts` never uses Slack behavior or Slack-backed writes, do not declare Slack in `persona.json` just because it might be useful later.

And for the integrations you *do* declare, **also declare a mount `scope`**. The
persona-kit type is
`PersonaIntegrationConfig { source?: IntegrationSource; scope?: Record<string, string>; config?: Record<string, unknown>; optional?: boolean; enabledByInput?: string }`,
where `scope` maps a resource name to an absolute relayfile glob, `config`
passes provider-owned adapter settings through unchanged, and `optional` /
`enabledByInput` gate the integration on a deploy input (see §3b). An **unscoped
provider mirror is dropped** — `slack: {}` (and `scope: {}`) mounts no provider
data, so reads come back empty and writes land on unmounted disk as silent
no-ops. Prefer the concrete subpaths the handler actually reads and writes back
to (least privilege — the relayfile token's path scope derives from the mount);
a broad `/provider/**` is valid but mounts the whole provider, and a mid-path
`*` mounts nothing (see §1):

```ts
integrations: {
  // Picker-narrowed: cloud rewrites this to /slack/channels/<resolved id>/** at
  // deploy. Needs `enabledByInput` AND a matching `picker` on that input — see
  // "scope is a boot cost" below. Leave the scope string as the bare collection.
  slack: {
    optional: true,
    enabledByInput: 'SLACK_CHANNEL',
    scope: { channels: '/slack/channels/**' }
  },
  // Read-only Linear context — scope the concrete subpaths the handler reads.
  linear: { scope: { projects: '/linear/projects/**', issues: '/linear/issues/**' } }
},
inputs: {
  SLACK_CHANNEL: {
    description: 'Channel the agent posts to.',
    env: 'SLACK_CHANNEL',
    picker: { provider: 'slack', resource: 'channels' }   // ← what enables the rewrite
  }
}
```

**Scope is a boot cost, not just a permission.** The mount is *traversed* when
the sandbox starts, so its size is paid on every run. Collections that grow with
workspace *history* rather than with configuration — `/slack/channels/**`,
`/google-mail/messages/**`, `/google-mail/threads/**` — get big enough to matter:
`/slack/channels/**` measured ~5,950 entries (2,008 files, 3,940 directories) in
one real workspace. That mount could not converge inside its budget, so runs
either came up degraded (`scoped initial sync failed; continuing without
preloaded reads`) or, once cloud began cancelling non-converging mounts at the
hard deadline, failed outright with exit 124. Narrowing to the single channel
took the same agent's bootstrap to a clean 127s.

Two corollaries worth internalizing:

- **Scope the one path you write to — not the collection around it.** The agent
  above kept posting through the runs that logged `scoped initial sync failed;
  continuing without preloaded reads`: the mount was up, only the *preload* had
  been skipped, and the writeback receipt still came back. Mirroring 6,000
  entries to send one message bought nothing.

  Do not read that as "writes don't need the mount". They do. A mirror that is
  genuinely *stuck* — as opposed to merely un-preloaded — cannot acknowledge a
  writeback either, which returns `ts: ''` and marks the whole run FAILED on the
  teardown flush (see §1). The narrow scope is the fix for both: it is cheap
  enough to actually converge.
- **`scope` does NOT interpolate inputs, though trigger `paths` DO.** You can
  write `paths: ['/slack/channels/${SLACK_CHANNEL}/**']` in `defineAgent`, but the
  same `${…}` in `scope` is not substituted — it is matched literally and mounts
  nothing.

  **Do not work around this by hard-coding the id in `scope`.** That pins one
  channel and takes the choice away from whoever deploys; override the input and
  the agent silently writes to a channel it has no grant for. Use the gate above
  instead: cloud's `pickerTargetPath` (in `persona-deploy.ts`) rewrites a
  picker-gated collection scope to the single record the input resolves to, for
  reads and writebacks alike. Requirements, all four:

  1. `optional: true` (persona-kit requires it alongside the gate),
  2. `enabledByInput: '<INPUT>'` on the integration,
  3. a `picker` on that input whose `provider` matches the integration and whose
     `resource` matches the collection segment,
  4. the scope left as the bare collection (`/slack/channels/**`) — the rewrite
     matches that exact path and nothing else.

  Miss any one and it silently falls back to mirroring the whole collection.
  A hard-coded constant is the fallback only for an agent whose channel genuinely
  is fixed and not operator-chosen; if you do that, drive the input `default` from
  the same constant and assert in a test that the two agree.

`deploy` runs `lintScopes()` (persona-kit >= 4.1.42) over these globs and warns
non-fatally on the history-sized collections above, on provider-root mirrors, and
on `/`-leading globs the mount would reject outright. A correctly picker-gated
collection is **not** flagged — the lint stays quiet exactly where cloud narrows
for you, so a warning on one means the narrowing is not actually wired up.
Warnings are advice, not a gate: if the agent genuinely reads the whole
collection, keep it.

The full mechanics and the labelled-mirror sub-trap are in the
production-correctness checklist below (§1).

### 3b. Gate conditional integrations with `optional` + `enabledByInput`

By default every declared integration is connected at deploy: its provider
credential is required and its triggers register. That is wrong for an
integration only *some* deploys use — declaring it unconditionally forces every
deployer to connect a provider they may not want.

`optional: true` + `enabledByInput: '<INPUT>'` (persona-kit ≥ 4.1.12,
workforce#252) make an integration **opt-in**: its provider connection, trigger
registration, and mount happen ONLY when the named input resolves to a non-empty
value (resolution order: `--input` flag > env var > input default). When the
input is empty the whole integration is pruned before connection. `optional: true`
**requires** `enabledByInput` (the parser rejects one without the other).

The canonical use is a **dual-transport agent** — one agent that declares both
`slack` and `telegram` and lets configuration pick which one(s) run, so a
Slack-only deploy never has to wire up a Telegram bot, and vice versa:

```ts
integrations: {
  slack: {
    optional: true,
    enabledByInput: 'SLACK_CHANNEL',          // set SLACK_CHANNEL → Slack connects
    // Broad here only because this agent replies wherever it is mentioned. If
    // yours targets known channels, scope them individually (§3) — `scope` is a
    // boot cost and does not interpolate `SLACK_CHANNEL`.
    scope: { channels: '/slack/channels/**' }
  },
  telegram: {
    optional: true,
    enabledByInput: 'TELEGRAM_CHAT',          // set TELEGRAM_CHAT → Telegram connects
    scope: { chats: '/telegram/chats/**', layout: '/telegram/LAYOUT.md' }
  }
},
inputs: {
  SLACK_CHANNEL: { env: 'SLACK_CHANNEL', optional: true, picker: { provider: 'slack', resource: 'channels' } },
  TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', optional: true }
}
```

The handler then registers both triggers (`slack: [...]`, `telegram: [...]`),
dispatches by `event.type` (`slack.*` vs `telegram.*`), and replies on the
**origin transport** so a message asked in one channel isn't mirrored to the
other. The unconfigured transport's trigger never fires because it was pruned.

Authoring rules:

- **Gate-on-id semantics:** the gating input typically doubles as the
  channel/chat/user id, so providing it both *enables* and *restricts* that
  transport. Decide deliberately — if you need "enabled but unrestricted", gate
  on a separate dedicated input instead of the id.
- Keep always-on data sources (e.g. a `google-mail` read mount) **non-optional** —
  only gate the transports/integrations a deploy can legitimately skip.
- Require persona-kit ≥ 4.1.12 in the agents repo. Older versions silently drop
  `optional`/`enabledByInput` (the integration would connect unconditionally),
  so verify the compiled `persona.json` actually carries the fields before
  deploy.

### 4. Use `integrations.<provider>.config` for adapter behavior, not mount behavior

`integrations.<provider>.config` is a forward-compatible adapter passthrough.
Persona-kit validates only that it is a plain object and preserves it for the
cloud adapter. It does **not** mount files, grant writeback path scope, or wake
the handler. Keep using `scope` and `defineAgent(...)` triggers for those.

Use `config` only for adapter settings that the provider explicitly documents.
It is not a portable cross-provider materialization API. The current production
case is **GitHub-only** materialization from `relayfile-adapters#193`: a persona
can keep GitHub lazy by default while eagerly materializing issues or pulls for
selected repositories.

```ts
integrations: {
  github: {
    scope: { paths: '/github/**' },
    config: {
      materialization: {
        default: 'lazy',
        webhookWritesForLazyRepos: true,
        rules: [
          {
            repos: ['AgentWorkforce/cloud'],
            issues: {
              mode: 'eager',
              filter: { state: 'open', labels: ['factory'] }
            },
            pulls: 'lazy'
          }
        ]
      }
    }
  }
}
```

Authoring rules:

- Use canonical GitHub materialization modes: `'lazy'` and `'eager'`. Adapter
  runtime aliases like `'all'` / `'none'` are not typed persona authoring
  values.
- Do not copy `config.materialization` to Slack, Linear, Notion, Jira, or other
  providers unless that adapter has shipped and documented the same setting.
  For unsupported providers, use `scope` plus handler-side filtering, or open an
  adapter follow-up instead of inventing persona config.
- Pair materialization with a concrete `scope` for any files the handler reads
  beyond the triggering subtree. `config.materialization` decides what the
  adapter syncs; `scope` decides what the persona mount can see.
- Keep `config` provider-owned. Do not put listener fields (`triggers`,
  `schedules`, `watch`) in it or under `integrations`; those belong in
  `defineAgent(...)`.
- Verify the compiled persona preserves both `integrations.<p>.scope` and
  `integrations.<p>.config` before deploy.

### 5. Schedules are named APIs

Declare schedules in `defineAgent({ schedules: [...] })`, not in `persona.json`.

Every schedule name should mean something operationally useful — it documents
the wakeup and (for multi-schedule personas) maps to the `event.schedule` cron
expression you match on. (v4: the handler does NOT receive `event.name`; see
"Event model (v4)" and G2.)

Good:

- `weekly`
- `daily-triage`
- `stale-pr-scan`

Bad:

- `job1`
- `schedule-a`

### 6. Memory should match the job

Examples:

- `workspace` scope for shared team/project context
- `user` scope for per-user assistant continuity
- `global` only when cross-workspace memory is truly intended

Do not enable memory by reflex if the persona is purely stateless.

### 7. `systemPrompt` should define the agent’s role, not the listener plumbing

The prompt should say what kind of agent this is and what quality bar it follows.
Do not stuff listener-routing details into the prompt when they are already in code.

## Good starter pattern

Use this shape unless there is a strong reason not to.

### persona.json

```json
{
  "id": "review-agent",
  "intent": "review",
  "tags": ["review", "github"],
  "description": "Reviews PRs, responds to mentions, and reacts to failed CI.",
  "cloud": true,
  "useSubscription": true,
  "integrations": {
    "github": { "scope": { "paths": "/github/**" } },
    "slack": { "scope": { "paths": "/slack/channels/**" } }
  },
  "memory": {
    "enabled": true,
    "scopes": ["workspace"]
  },
  "onEvent": "./agent.ts",
  "harness": "codex",
  "model": "gpt-5.5",
  "systemPrompt": "Review pull requests for correctness, regression risk, security concerns, and missing tests. Be concise and concrete.",
  "harnessSettings": {
    "reasoning": "medium",
    "timeoutSeconds": 1200,
    "sandboxMode": "workspace-write",
    "workspaceWriteNetworkAccess": true
  }
}
```

> **Scope warning — a Slack trigger does NOT cover a Slack write.** Cloud mounts
> an integration's relayfile paths from triggers and from `scope`, nothing else.
> A trigger mounts a *read* mirror at the display-labelled path
> `/slack/channels/{id}__{name}/...`, but `slackClient().post()` writes to the
> canonical bare-id path `/slack/channels/{id}/messages` — the two never
> coincide, so a slack trigger alone leaves every write a silent no-op. That is
> why this example **scopes** `slack` rather than using `"slack": {}`, even
> though `agent.ts` below declares a slack trigger. Any integration the handler
> **writes** through needs a non-empty `scope`
> (`"slack": { "scope": { "paths": "/slack/channels/**" } }`); github/linear
> writes are the exception only because their trigger and writeback paths share
> one bare-id form. The scope is broad here because this reviewer answers
> mentions anywhere; an agent that posts to known channels should scope them
> individually, since the whole mirror is traversed at boot (§3).
> `github` is still scoped here so the reviewer's **reads**
> (the PR records and `/github/LAYOUT.md` it walks beyond its trigger subtree)
> are mounted — an unscoped `"github": {}` mirror is dropped. `scope: {}` is
> discarded by persona-kit, and scope values must be strings. Full rules are in
> the production-correctness checklist below (§1).

### agent.ts

```ts
import { defineAgent } from '@agentworkforce/runtime';

export default defineAgent({
  triggers: {
    github: [
      { on: 'pull_request.opened' },
      { on: 'issue_comment.created', match: '@mention' },
      { on: 'check_run.completed', where: 'conclusion=failure' }
    ],
    slack: [{ on: 'app_mention' }]
  },
  schedules: [{ name: 'daily-triage', cron: '0 9 * * 1-5', tz: 'UTC' }],
  handler: async (ctx, event) => {
    // event.type is provider-prefixed; payload is async (see "Event model (v4)").
    if (event.type === 'github.pull_request.opened') {
      const data = (await event.expand('full')).data;
      return; // review flow
    }
    if (event.type === 'github.issue_comment.created') {
      const data = (await event.expand('full')).data;
      return; // mention reply flow
    }
    if (event.type === 'github.check_run.completed') {
      const data = (await event.expand('full')).data;
      return; // failed-CI reaction flow
    }
    if (event.type === 'slack.app_mention') {
      const data = (await event.expand('full')).data;
      return; // slack reply flow
    }
    if (event.type === 'cron.tick') {
      return; // scheduled flow (single schedule → no name gate)
    }
  }
});
```

## Event-shape guidance

Use the runtime’s current v4 event model (see "Event model (v4)"):

- cron events: `event.type === 'cron.tick'`, with `event.schedule` / `event.scheduledFor` (no `event.name`)
- provider events: `event.type === '<provider>.<on>'`; the payload is `(await event.expand('full')).data` (async), not `event.payload`

Do not invent custom event wrappers when `@agentworkforce/runtime` already provides them.

When reading provider payloads:

- treat the expanded `.data` as provider-normalized but still loosely typed
- write small local extractor helpers instead of spreading unsafe casts everywhere
- validate required identifiers early and fail clearly
- prefer `defineAgent({...})` + helper functions over giant inline `if` blocks

## Context usage guidance

The useful pieces on `ctx` are typically:

- `ctx.persona`
- `ctx.harness.run(...)`
- `ctx.llm.complete(...)`
- `ctx.memory.save(...)`
- `ctx.memory.recall(...)`
- `ctx.sandbox.*`
- `ctx.files.*`
- `ctx.schedule.*`
- `ctx.workflow.*`
- `ctx.relay.dm(to, text)` / `ctx.relay.post(channel, text)` — **agent-to-agent** messaging over the relay (DM a peer agent by registered name, or post to a relay channel). Returns `{ ok, messageId? }` and **never throws** (`{ ok: false }` on failure). Use it to answer a relay-inbox DM (`isRelaycastMessageEvent`) or hand off to a peer agent — not for user-facing provider posts (those go through `@relayfile/relay-helpers`).
- `ctx.trajectory.*` — auto-recorded decision trail (no-op unless `persona.memory.trajectories` is opted in); always safe to call.
- `ctx.log(...)`

Prefer direct typed runtime helpers over invoking external commands.

### Provider reads and writes — use `@relayfile/relay-helpers`

There are **no** `ctx.<provider>` clients. The ergonomic way to talk to a
provider is **`@relayfile/relay-helpers`** — opt-in factory clients whose paths
come from the adapter catalog (so they can't drift from the adapter). Add
`@relayfile/relay-helpers` to the persona's `package.json`, then:

```ts
import { linearClient, slackClient, githubClient } from '@relayfile/relay-helpers';

const linear = linearClient();                   // binds the mount root once (RELAYFILE_MOUNT_ROOT)
const issue = await linear.getIssue(issueId);    // read
await linear.comment(issueId, ':rocket: done');  // write

await githubClient().comment({ owner, repo, number }, 'LGTM');
await githubClient().mergePullRequest({ owner, repo, number, method: 'squash' });
await slackClient().post('#eng', 'shipped');
await slackClient().dm(userId, 'heads up');
```

A write is a draft file the Relayfile writeback worker turns into the real
provider call (with retry/durability) — handlers never hold a token or call a
provider REST API directly.

The catalog now exposes **36 provider clients** (31 generated + 5 bespoke —
`githubClient`, `linearClient`, `slackClient`, `redditClient`, `telegramClient`),
plus the `providerClient` / `relayClient` escape hatches. (The old "all-29" count
is stale; the number is catalog-driven and grows as adapters ship, enforced by an
in-sync test.) When a provider has no bespoke method for what you need, use the
generic resource access — `providerClient('notion').pages.write({ databaseId }, {...})`
— or `relayClient('linear').write('issues', {}, {...})` when you need the raw
writeback **receipt** (`{ path, receipt: { url, id, identifier } }` — the created
record's URL/id).

**Delivery status is explicit now — don't treat a returned handle as delivered.**
The github/linear **create** helpers return a discriminated `CreatedResult`:
`status: 'confirmed' | 'pending' | 'dropped'`, plus `path` (the draft handle,
always present), `id` (falls back to `path` until a provider receipt supplies a
real id), and `url` (empty string until confirmed — never a filesystem path).
Idempotency rules: on **`pending`**, do NOT throw or retry (a retry can duplicate
the provider-side effect); **`dropped`** requires positive evidence the draft
won't be handled; genuinely ambiguous failures (admission timeout) still throw.
Never promote `pending` → `dropped` yourself. Slack's `post`/`dm`/`reply` keep
the older shape — they return `{ ts }` (`ts: ''` when no receipt arrived, a
**silent** non-delivery — see §1/§9), not a `CreatedResult`.

**Multi-transport delivery — `@agentworkforce/delivery`.** For an agent that
fans one message out to whichever transports are configured (Slack and/or
Telegram), prefer the delivery helper over hand-rolling per-provider posts:
`createDelivery(ctx, undefined, ['slack', 'telegram'])` exposes `.targets`,
`.publish()`, and `.send(text, { replyTo, nonBlocking })`. **Thread by passing a
header's `DeliveryResult` as `replyTo`** (not a raw `thread_ts`). hn-monitor uses
this for its threaded digest; agents that still hand-roll (spotify-releases) call
`slackClient().dm()` + a shared `../shared/telegram.ts` helper. Either way, the
idempotency rule from the notes holds: once the header has posted, don't throw —
a retried handler re-posts a duplicate header.

**Preview-safety (composable-runtime closure).** Handlers run under a closure that
records every side effect: provider writes land as `previewed` actions,
`memory`/`files` writes replay, and — importantly — **undeclared outbound HTTP is
denied**. A raw `GET`/`HEAD` via `node:http`/`fetch` that isn't allow-listed in
`capabilities.httpRead` is rejected before it runs (POSTs always denied). If a
handler must read a live URL, declare it (see §5b `httpRead`); otherwise
prefer VFS/provider reads.

**Lower-level escape hatch.** For reads that are *not* catalog writeback
resources (e.g. a github PR's record JSON, a provider's `_index.json`), drop to
the generic VFS helpers from `@agentworkforce/runtime`
(`readJsonFile`/`listJsonFiles`/`writeJsonFile`/`draftFile`).

> **`writeJsonFile` now THROWS on non-success.** The runtime's `writeJsonFile`
> wrapper (re-exported from `@relayfile/adapter-core/vfs-client`) normalizes the
> writeback status and **throws `WritebackError` unless the state is
> `succeeded`** — the one exception is `writebackTimeoutMs: 0` + `no_receipt`,
> which returns the result without throwing (used for fire-and-thread posts). This
> is a change from older runtimes where the low-level write returned silently on
> timeout. Two consequences: (a) a raw `writeJsonFile` to an **unmounted** path
> now surfaces as a thrown `WritebackError` rather than a silent no-op — good, but
> catch it where a partial failure shouldn't fail the whole handler; (b) the
> **relay-helpers Slack client still returns `ts: ''` silently** (it uses its own
> transport, not this wrapper), so the §1 "make delivery loud" rule for Slack
> still stands.

**Never assume a record path — the mount self-describes its layout.** The
relayfile adapter publishes a guide per provider at `/<provider>/LAYOUT.md`
(e.g. `/github/LAYOUT.md`) and an `_index.json` at each level. Its first rule is
literally *"always run `ls` before constructing a path"*, because record
directory names are **not guessable**: a GitHub PR is
`pulls/<number>__<slug>/meta.json` (number + sanitized title slug), **not**
`pulls/<number>/meta.json`. Read `LAYOUT.md`, walk the `_index.json` files, and
`ls`/inspect a directory before reading from it:

```ts
import { readJsonFile, resolveMountRoot } from '@agentworkforce/runtime';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const root = resolveMountRoot({});
// LAYOUT.md + _index.json are the source of truth — read them, don't hardcode.
const pullsDir = path.join(root, 'github', 'repos', owner, repo, 'pulls');
const entry = (await readdir(pullsDir)).find((d) => d.startsWith(`${prNumber}__`));
if (!entry) throw new Error(`PR #${prNumber} not found under ${pullsDir}`);
const meta = await readJsonFile(
  { relayfileMountRoot: root }, 'github', 'getPr',
  `/github/repos/${owner}/${repo}/pulls/${entry}/meta.json`
);
```

> **Scope it in.** `LAYOUT.md` lives at `/github/LAYOUT.md` — a sibling of
> `repos/`, **not** under it. A scope like `/github/repos/<owner>/**` does NOT
> mount the guide; use `/github/**` (or otherwise include `/github/LAYOUT.md`)
> if the handler should read it.

When unsure of a resource or path, prefer the in-mount `LAYOUT.md` / `_index.json`
(runtime truth), then the catalog (`@relayfile/adapter-core/writeback-paths`) or
the adapter's `resources.ts` — never guess a filename.

## When to use `ctx.harness.run(...)`

Use the harness when the persona needs real judgment or synthesis, for example:

- PR review comments
- replies to mentions
- code-fix suggestions
- summarization
- clustering and writing human-facing output

Do not use the harness for simple deterministic routing, field extraction, or formatting that plain TypeScript can do more safely.

**`[[NO_REPLY]]` — the supported silent-reply marker.** When a conversational
harness prompt decides there's nothing worth saying, have it emit the reserved
`[[NO_REPLY]]` marker. The runtime **strips the marker** before returning
`output` and sets `result.suppressed = true` (with `result.containsMarker`); a
`suppressed` result on `exitCode 0` is an intentional silent success, **not** a
failure — branch on it to skip the reply rather than posting an empty message.
`HarnessRunResult` also now carries `stderr` (folded into `output` on a non-zero
exit, so failure reasons are visible to callers that only read `output`).

## Inputs and env

Use `inputs` when the value is a declared runtime parameter for the persona, like:

- target repo
- topic list
- destination channel
- project code

Use `env` only for environment variables the harness process needs.
Do not put secrets into `inputs`.

## Common patterns

### Scheduled digest

Use when the agent runs on a cron schedule and writes a summary somewhere.

Persona:

- `cloud: true`
- integration connection declarations like `github` or `slack`
- optional `inputs` for topics/repos/channels

Agent:

- `defineAgent({ schedules: [...] })`
- branch on `event.type === 'cron.tick'` (multi-schedule: match `event.schedule`)
- fetch/search/gather
- summarize
- post or upsert
- save memory if the artifact matters later

### Integration-triggered reviewer

Use when the agent wakes on GitHub, Linear, Slack, etc.

Persona:

- `integrations.<provider>` for connection requirements
- `useSubscription: true` if the judgment should run on the user’s linked provider path
- often `memory.workspace`

Agent:

- `defineAgent({ triggers: { <provider>: [...] } })`
- branch on `event.type` (`'<provider>.<on>'`, or `.startsWith('<provider>.')`)
- extract target identifiers from `(await event.expand('full')).data`
- optionally load prior memory
- call harness for judgment/output
- write back with `@relayfile/relay-helpers`; use `writeJsonFile(...)` only
  for lower-level VFS/resource cases that the helper catalog does not cover

### Mixed schedule + integrations agent

Fine to combine both in one cloud agent when the role is coherent.
Examples:

- responds to Slack mentions and also runs a daily cleanup
- reacts to GitHub events and runs a weekly scan

Do not combine unrelated jobs into one agent just because the runtime allows it.

### Team member agent

Use when the persona is launched by a team dispatcher, not directly by provider
events.

Persona:

- `cloud: true`
- usually declares integrations needed by the member's sandbox/work
- harness/model/systemPrompt/harnessSettings describe the member role
- `onEvent: "./agent.ts"`

Agent:

- `defineAgent({ launchedBy: 'team-dispatcher', handler })`
- no `triggers`, `schedules`, or `watch`
- handler should usually log and return if invoked directly
- do not subscribe team members to the same provider events as the lead, or the
  lead and every member can fire for the same issue/PR

## Production correctness checklist

These rules came from shipped Workforce/agents defects. Apply them after the basic persona shape is in place and before deploy.

## 1. THE INTEGRATION SCOPE TRAP — declared ≠ mounted

**A persona integration without a `scope` mounts nothing.** Cloud derives the
relayfile mount paths (and the relayfile token's path scope) from exactly two
sources: the agent's **triggers** and each integration's **scope**
(`cloud → packages/web/lib/proactive-runtime/persona-deploy.ts`,
`relayfilePathsFromScope`). A bare declaration like:

```ts
integrations: {
  github: {},
  slack: {}     // ← INERT: no trigger, no scope → zero /slack paths mounted
}
```

means `slackClient().post(...)` writes its draft JSON to **unmounted local
disk**, polls ~3s for a writeback receipt that can never arrive, and returns
`{channel, ts: ''}` **without throwing** (adapter-core `vfs-client`
`writeJsonFile` → `waitForReceipt` returns `undefined` on timeout). The
notification is a perfectly silent no-op — this shipped as the pr-reviewer
Slack bug (agents#40).

The same `ts: ''` signature also appears when the scope **is** set but the
mount's read-side mirror never finished bootstrapping (e.g. a file/dir path
collision aborts every sync cycle), so the writeback can't be acknowledged — and
that one additionally marks the whole cloud run FAILED on the teardown flush. If
you see `ts: ''`, rule out a stuck mirror, not just a missing scope (see
[`setting-up-relayfile` → "cloud run marked FAILED but the handler logged
`runner.handler.ok`"](../setting-up-relayfile/SKILL.md#symptom-cloud-run-marked-failed-but-the-handler-logged-runnerhandlerok)).

Why github "just works" in most personas while slack doesn't: github usually
appears in `triggers`, and trigger paths are mounted independently of scope.
Any integration the handler only **writes** through (slack notifications,
linear comments on non-trigger issues) has no trigger to save it.

**The labelled-mirror sub-trap — a trigger that LOOKS like it covers the write
but doesn't.** A trigger mounts the watched subtree as a *read* mirror, and for
some providers the mirror path is **display-labelled** while the writeback path
is **canonical bare-id**. Slack is the production case: the trigger mirrors the
channel at `/slack/channels/{id}__{name}/messages` (channel id + `__` + name),
but `slackClient().post()` writes to `/slack/channels/{id}/messages` (bare id).
The two **never coincide**, so a Slack trigger does NOT cover a Slack write —
the draft still lands on unmounted disk and the post is a silent no-op even
though the run logs `handler.ok`. This shipped as the **linear-slack bug
(2026-06)**: the agent had a `slack` trigger on its board channel and *still*
posted into the void; the orphaned draft was recovered from the live sandbox.
github/linear are immune because their trigger and writeback paths share one
bare identifier form (`/github/repos/{owner}/{repo}/...`,
`/linear/issues/{issueId}/...`).

Rules:

- Every integration the handler writes through needs a trigger **or** a
  non-empty `scope` — **except Slack (and any display-labelled mirror): a Slack
  WRITE always needs a `scope`; a trigger is never enough.** Safest default:
  give every write-through integration an explicit `scope`.
- **Make delivery loud.** `post()`/`reply()`/`dm()` resolve with `ts: ''`
  instead of throwing when the writeback gets no receipt (the `ts: ''` signature
  above), so a dropped post still logs `handler.ok`. Treat an empty `ts` as
  failure (`if (!result.ts) throw …`) so the runtime surfaces `handler.error`
  instead of a silent no-op.
- **`scope: {}` does NOT work.** persona-kit's `parseIntegrationConfig`
  discards empty scope objects client-side before upload, so cloud's
  `/<provider>/**` provider-root fallback is unreachable from a persona.
- Scope values must be **strings** (persona-kit `parseStringMap` throws on
  arrays). A value starting with `/` is used verbatim as a mount glob; a bare
  value `v` under key `k` becomes `/<provider>/<k>/<v>/**`.
- When the target is picked at deploy time (e.g. a `SLACK_CHANNEL` input),
  scope the subtree, not the instance:

```ts
slack: {
  scope: { paths: '/slack/channels/**' }   // covers any picked channel, excludes DMs/users
}
```

- **A scope root must be a concrete prefix — a mid-path `*` mounts NOTHING.**
  Cloud reduces each scope to a remote root via `scopedRemoteRoot`
  (`cloud/packages/core/src/relayfile/mount-script.ts`): it strips a trailing
  `/**`, then **discards the path entirely if any `*` remains** (and
  `relayfile-mount --remote-path` only accepts a concrete prefix, never a glob).
  So a `*` is allowed *only* in the final `/**`:

  ```ts
  // ❌ silently dropped — the mid-path `*` survives the /** strip → mounts nothing
  github: { scope: { paths: '/github/repos/AgentWorkforce/*/pulls/**' } }
  // ✅ concrete root — mounts; filter to the repos/PRs you want in the handler
  github: { scope: { paths: '/github/**' } }
  ```

  This is doubly silent: the deploy still mints a matching fs token and the path
  passes string validation, so nothing errors — the handler just reads an empty
  tree. It bit daily-ship (every digest said "No PRs merged"). Pick the broadest
  concrete root and narrow in code. (Platform hardening tracked in
  `AgentWorkforce/cloud#1986`.)

- **Verify after compiling**: run `agentworkforce persona compile <dir>/persona.ts`
  and check the generated persona.json still carries `integrations.<p>.scope`
  and any `integrations.<p>.config` adapter settings. If persona-kit dropped the
  field, the deployed persona is silently inert or falls back to adapter defaults.
- Pin a test (see §6): parse `persona.integrations` through persona-kit's
  `parseIntegrations` and assert the scope survives as a non-empty map covering
  the writeback subtree your client uses; assert adapter `config` survives when
  a GitHub persona depends on materialization or a provider documents another
  provider-owned setting.

## 2. `sandbox: true` vs `sandbox: false`

`sandbox` is a top-level boolean on the persona spec
(persona-kit `parse.js` `parseSandbox`; default **true** when omitted).

| | `sandbox: true` (default) | `sandbox: false` |
|---|---|---|
| Daytona box | provisioned per fire (seconds of cold start) | **none** — handler runs in the persona runner (ms) |
| `ctx.sandbox.exec()` | available | **rejects** (`SandboxNotAvailableError`) |
| `ctx.files.read/write` | available | unavailable |
| Relayfile **filesystem mount** (`resolveMountRoot` + `readJsonFile`/`readdir` against the mount path) | mirrored by the mount daemon | **NOT mounted** — the daemon is skipped, so mount-path reads come back **empty**. Reads must go over the relayfile **HTTP API** (relay-helpers clients / API-mode reads), not the filesystem. |
| `ctx.harness.run()` | available | **unusable** — harness CLI credentials are NOT mounted (`EMPTY_HARNESS_CLI_CREDENTIAL_MOUNT`) and no `CLAUDE_CODE_OAUTH_TOKEN`/`CODEX_OAUTH_CREDENTIAL` env is set, so the claude/codex/opencode CLI cannot authenticate. The method exists but a real harness run fails (`deployment-trigger-delivery.ts`). |
| Harness CLI credentials | mounted | not mounted |
| `ctx.llm.complete()` | available | available **only with an explicit credential** — set `useSubscription: true` (or a credentialSelection) so the credential rides in `providerEnv`; the harness-mount fallback that normally backs `ctx.llm` is gone under `sandbox: false` |
| PR-reviewer checkout / PR writeback / conflict-autofix / git workspace clone | available when capabilities declared | **disabled even if declared** (cloud gates them on `!lightweightSandbox`, `deployment-trigger-delivery.ts`) |

Pick `sandbox: false` **only** for read-classify-reply personas that answer via
`ctx.llm.complete()` (set `useSubscription: true` or a credentialSelection so the
credential survives in `providerEnv`) and whose provider I/O rides the relayfile
**HTTP API** — i.e. **writes** through `@relayfile/relay-helpers` clients
(`slackClient().post()` etc.). joke-bot is the model: a zero-data-dependency
conversational bot that only writes.

> **`sandbox: false` gets no filesystem mount.** If the handler **reads
> materialized provider data from the mount** (`resolveMountRoot()` +
> `readJsonFile`/`readdir`, e.g. `/google-mail/threads/**`), those reads come back
> **empty** under `sandbox: false` — the mount daemon is skipped. inbox-buddy is
> the cautionary case: it reads Gmail from the VFS mount, so it **must** be
> `sandbox: true` even though it uses no harness. Rule of thumb: **write-only →
> `sandbox: false` is fine; read-from-mount → needs `sandbox: true`** (or restructure
> reads to go over the relayfile HTTP API).

Any persona that calls
`ctx.harness.run()` — i.e. a claude/codex/opencode conversational or coding agent —
**must keep `sandbox: true`**: the harness needs the box and its mounted CLI
credentials (`sandbox: false` drops them, so the run fails). Also keep the default
for anything that clones repos, runs shells, or uses PR capabilities.

> **Wake cost (sandbox-per-message trap).** A channel-wide trigger like
> `slack: [{ on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'] }]`
> wakes — and on `sandbox: true` **provisions a Daytona box + runs the harness** —
> for **every** message in the channel, even ones the handler self-filters and
> drops. The handler's own skip-guards run AFTER provisioning, so they don't save
> the box. Gate the wake at the trigger so the box is only provisioned when the
> agent is actually addressed: add **`match: '@mention'`** (fires only when the
> message contains a Slack mention token) or **`where: 'field=value'`** (exact
> payload-field condition). A pure reply bot can instead use `ctx.llm.complete` +
> `sandbox: false` and skip the box entirely.

## 3. Inputs — declaration and resolution

Declare inputs in the persona spec:

```ts
inputs: {
  SLACK_CHANNEL: {
    description: 'Channel for review pings.',
    env: 'SLACK_CHANNEL',
    optional: true,                                  // no default → unset means feature off
    picker: { provider: 'slack', resource: 'channels' } // deploy-UI picker; stores channel ID
  }
}
```

Resolution facts (verified against cloud delivery + runtime):

- Cloud does **not** export each input as a bare env var in the sandbox.
  Input values travel inside `WORKFORCE_AGENT_CONTEXT` (JSON) and surface as
  `ctx.persona.inputs` (the runtime merges the `inputValues` / `input_values`
  aliases).
- The conventional handler accessor checks env first (local dev), then ctx:

```ts
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  return typeof v === 'string' && v.trim() ? v : undefined;
}
```

- An **optional input with no default that gates a feature** means the feature
  is off-by-config when undeployed — fine, but document it, and remember it
  compounds with §1: the feature needs the input set **and** the path mounted.
- Picker types observed in production: `{provider:'slack', resource:'channels'}`,
  `{provider:'github', resource:'users'}`. Pickers store provider IDs
  (e.g. `C…` channel IDs), not display names.

## 4. Harness and model selection

- `harness`: which CLI runs `ctx.harness.run()` prompts — `'codex'` or
  `'claude'`. `model` must match the harness family (e.g. `gpt-5.x` for codex;
  `claude-*` for claude).
- `harnessSettings`: `reasoning`, `timeoutSeconds`, `sandboxMode`,
  `workspaceWriteNetworkAccess`, and
  `dangerouslyBypassApprovalsAndSandbox: true` — required for codex in cloud
  fires because **Daytona is the trust boundary** and codex's nested bubblewrap
  sandbox needs user namespaces Daytona doesn't allow. Say so in a comment when
  you set it.
- Version pinning: capabilities, `integrations.<provider>.config`, and other
  spec fields are parsed **client-side by persona-kit before upload**. A
  persona-kit older than the field you're using silently strips it (this shipped
  as the teamSolve-capability strip). Exact-pin `@agentworkforce/persona-kit`
  (and cli/runtime) in the repo and verify the compiled artifact carries every
  field you depend on.

## 5. Teams — `teamSolve` capability and `team.json`

A lead persona opts into team orchestration via capabilities
(`cloud → packages/core/src/proactive-runtime/capabilities.ts`):

```json
"capabilities": {
  "teamSolve": {
    "enabled": true,
    "maxMembers": 1,          // default 4, hard-capped at 4
    "roles": ["implementer"], // default ["lead","impl","reviewer","prober"]
    "tokenBudget": 400000,    // default 400000
    "timeBudgetSeconds": 1800 // default 1800
  }
}
```

Multi-member rosters bind through `team.json`
(`cloud → packages/core/src/proactive-runtime/team-spec.ts`, loaded from the
persona directory; bound via `PUT /api/v1/workspaces/{id}/teams`):

```json
{
  "id": "my-team",                      // must match the team directory name
  "lead": "alice",                      // must reference a member name
  "members": [
    { "name": "alice", "persona": "alice-persona-slug", "role": "lead" },
    { "name": "bob",
      "persona": { "slug": "bob-persona-slug", "version": 2 },
      "role": "implementer",
      "owns": [ { "issue.labels": ["bug"] } ] }
  ],
  "tokenBudget": 1000000,
  "timeBudgetSeconds": 3600
}
```

Validation: unique member names and persona refs, no duplicate `owns`
ownership, `inline` persona refs rejected (Phase 1). Members resolve to
already-deployed personas in the workspace — deploy members first, then bind.
Spawning is cloud-side (`launchMember`); there is **no in-box
`ctx.team.spawn`** — don't write handler code that assumes one.

## 5b. Other persona `capabilities`

Beyond `teamSolve`, the persona spec now carries several capability blocks. Like
all capabilities they're parsed **client-side by persona-kit** — pin a recent
persona-kit and verify the compiled artifact carries them (§4).

- **`httpRead` — live outbound-read allowlist.** Handlers run under a
  preview-safe closure that **denies undeclared outbound HTTP** (see "Preview
  safety" in the reads/writes section). To let a handler read a live URL,
  allow-list it:

  ```json
  "capabilities": {
    "httpRead": {
      "enabled": true,
      "allow": [
        { "method": "GET",  "urlGlob": "https://hacker-news.firebaseio.com/**" },
        { "method": "HEAD", "urlGlob": "https://example.com/status" }
      ]
    }
  }
  ```

  Only `GET`/`HEAD` are expressible (`method` + `urlGlob` both required); POSTs
  are always denied. Prefer VFS/provider reads; reach for `httpRead` only for a
  genuine external API the catalog doesn't mirror. See
  `references/agents/hn-monitor/persona.json` (compiled) for a live example — it
  allow-lists the Hacker News Algolia API (`https://hn.algolia.com/api/v1/...`).

- **`conversational` — cloud chat routing.** Opts a persona into cloud's
  `app_mention`/chat responder routing (used by joke-bot):
  `{ enabled, defaultResponder, channels, identity }`. Pair it with the transport
  triggers/handler branches the persona actually implements.

- **`conflictResolve` — PR conflict autofix directive** (review agent):
  `{ directive: '@relay fix conflicts', resolveMarkers: true }` — declares the
  comment directive and marker-resolution behavior the reviewer honors. Requires
  `sandbox: true` (it clones/edits — gated on `!lightweightSandbox`, §2).

## 6. The showcase quality bar (AgentWorkforce/agents repo)

The agents repo is a public showcase. Merges get blocked on brittleness even
when the code works and is approved. The bar:

- **No inline base64 blobs, no `node -e` one-liners, no hand-rolled shell
  quoting** inside handlers or workflows. Extract checked-in helper scripts.
- **Pass data as JSON arguments** (a JSON file or single JSON env/arg), never
  as positional shell argv that needs quoting.
- **Golden tests are a merge gate.** Exported pure helpers (`readPr`,
  `labelNames`, allowlist deciders) get node:test coverage in `tests/`; persona
  config invariants (like §1's scope) get pinned with a test proven **red**
  against the broken shape before the fix lands.
- persona.json is **generated** from persona.ts in the agents repo (untracked
  since agents#24) — edit persona.ts, never the artifact.

## 7. `onEvent` handler patterns

Declare wakeups in `defineAgent({...})` (triggers / schedules / watch);
branch imperatively in the handler. Hard-won guard patterns:

- **First line** (single-provider personas): `if (!event.type.startsWith('<provider>.')) return;` — multi-provider handlers branch per `event.type` prefix instead of returning early. (v4: there is no `event.source`.)
- **Terminal-event guards before work**: approval → merge → return;
  green check_run → return; only then the expensive review path.
- **Read materialized meta defensively.** Provider projections drift — accept
  both shapes when one has shipped (`author?: string | { login?: string }`),
  and decide explicitly whether a gate **fails open or closed** when meta is
  missing (author allowlist: fail closed; skip-label check on a payload that
  lacks labels: fail open). Comment the choice.
- **Cron**: branch on `event.type === 'cron.tick'`. The v4 cron event has **no
  `event.name`** — only `event.schedule` (the cron expr / one-shot id) and
  `event.scheduledFor`. For a single-schedule persona, treat any `cron.tick` as
  that schedule; do NOT gate on a schedule name (it isn't delivered, so the gate
  becomes a permanent silent no-op). For a multi-schedule persona, discriminate
  by matching `event.schedule` against the cron expressions you declared.
- **Sentinel contracts with the harness**: if the handler keys behavior off
  harness output (e.g. a literal `READY` last line), spell the contract out in
  the prompt and parse only the last line — and remember output-tail
  truncation preserves the end, not the start.
- Log skips with reasons (`ctx.log?.('info', 'skipped', { reason })`) — a
  silent return is indistinguishable from a delivery failure during triage.

## 8. Delegation — `ctx.workflow.run` vs `ctx.harness.run`

Two ways to do heavy work; pick by shape:

| | `ctx.harness.run(args)` | `ctx.workflow.run(name, args)` |
|---|---|---|
| What | one prompt through the persona's harness CLI | a multi-step agent-relay workflow (DAG of deterministic + agent steps) |
| Returns | `{ output, exitCode, durationMs }` directly | `{ runId, completion() }`; `await completion()` → `{ output, status }` |
| Use for | single coding/review task in the box | clone → implement → open-PR pipelines, multi-agent coordination |

The **thin-lead pattern** (linear chat lead,
`references/agents/linear/agent.ts`):
classify intent with a cheap harness/LLM call → **reply to the user
immediately** ("starting an implementation workflow…") → delegate via
`ctx.workflow.run` → on completion, post the result (e.g. extract the PR URL
from `completion.output`). The chat handler stays responsive; the workflow
carries the long work. Keep workflow definitions as checked-in files under
`workflows/` (see §6) rather than assembling source strings in the handler.

That agent also shows the **Linear Agent Session API** via `linearClient()`:
triggers `on: 'AgentSessionEvent.created' | 'AgentSessionEvent.prompted' |
'AppUserNotification.issueCommentMention'` (delivered provider-prefixed, e.g.
`event.type === 'linear.AgentSessionEvent.created'`), and the handler streams
progress with `linearClient().agentActivity(sessionId, { type: 'thought' |
'response' | 'elicitation' | 'action' | 'error', body })`, `respond(sessionId,
body)`, and `acknowledge(sessionId)`. Key session-scoped memory on the
`sessionId`.

## 8b. THE STATIC RESOLVE TRAP — `persona.ts` is parsed, not executed

The Launch Agent button in every agent README opens
`agentrelay.com/cloud/deploy?persona=<github blob url>`, which **reads your
`persona.ts` as text**. It never runs it, so every value must be readable
without evaluating anything.

**The failure is silent.** One unsupported node aborts the whole resolve — not
just the field using it — and the page then shows demo data claiming
"This persona does not require external integrations". A user following the
one-click flow deploys an agent with no provider connected. Compile, typecheck
and tests all pass; the only signal is a banner reading
`live resolve failed: persona.<field> uses unsupported dynamic syntax (<Node>)`.

**Write literals.** Strings, numbers, objects, arrays. Also fine: backticks
with no `${}`, `['a', 'b'].join(' ')`, a `const` declared in `persona.ts`, a
`readFileSync(new URL('./SPEC.md', import.meta.url))` sibling, and a named
import of a `const` literal from a relative sibling (one level, cloud#3245).

**Never build a value.** No interpolation (`` `text ${X}` ``), no concatenation
(`'a' + b`), no calls of your own, no `.map`, no ternaries. The two calls above
are specific exceptions the resolver implements, not a general permission. A
derived value — say a prompt line generated from your capability manifest —
cannot survive here: inline the result and pin it with a test that fails when
the source changes.

**Guard it.** Compiling proves nothing: `persona.json` comes from *executing*
the module, which is what the page will not do. Parse the persona object and
reject those node kinds — see askable-gtm's
`persona.ts stays statically resolvable for the launch page` test. Compare
`ts.SyntaxKind` **numerically**; it is a reverse-mapped enum, so
`SyntaxKind[NoSubstitutionTemplateLiteral]` is `"FirstTemplateToken"` and a
name-based check silently passes a plain backtick.

Cheapest real check: open your Launch Agent URL and confirm the "It will
connect" panel lists your providers.

## 9. Relayfile — how provider clients actually resolve

`slackClient()` / `linearClient()` / `githubClient()` / `providerClient(p)`
from `@relayfile/relay-helpers` are **not** HTTP clients. A `write` resolves a
catalog path (`/slack/channels/{channelId}/messages`), drops a uniquely-named
draft JSON under the **mount root**, and waits for the writeback worker to
replace it with a receipt. Reads (`readJsonFile`, `.list()`) read materialized
JSON from the same tree.

Consequences:

- **The path must be mounted** (token-scoped + daemon-watched) or the draft
  sits on local disk forever and the call returns silently — see §1.
- **Anchor the mount root explicitly.** The runner's CWD is not the mount
  root (CWD `…/workforce-runtime` vs mount `…/workspace` shipped as a real
  ENOENT bug). Pass `{ relayfileMountRoot: resolveMountRoot({}) }` or rely on
  the `RELAYFILE_MOUNT_ROOT` env — never on relative paths from CWD.
- **A returned receipt / `confirmed` status is the success signal.**
  `result.receipt?.created/id` present (or a `CreatedResult.status === 'confirmed'`)
  → delivered; absent/`pending` after the wait → not yet delivered. Two write
  surfaces now behave differently: the **relay-helpers clients** (`slackClient`,
  `githubClient`, `linearClient`) do **not** throw on a missing receipt — Slack
  returns `ts: ''` and github/linear return a `pending`/`dropped` `CreatedResult`
  — so you must inspect the return; the lower-level **runtime `writeJsonFile`**
  now **throws `WritebackError`** on non-success instead. Either way, if delivery
  is load-bearing, check the result and surface the failure. Do **not** retry a
  `pending` create (duplicate-effect risk — see the idempotency rules above).
- Item paths (ending `.json`) are direct read/write; collection paths take
  drafts and `.list()`. Encode user-supplied path segments with
  `encodeSegment(...)`.
- Terminal provider states (closed/merged/archived) stay readable as records
  with terminal status — never model them as deletions.

## Production pre-merge checklist

1. Every written-to integration has a trigger or a non-empty, string-valued
   scope (§1) — and the **compiled** persona.json still carries it.
2. `sandbox` matches the capability set (§2) — no `ctx.sandbox.exec` /
   PR-capability reliance under `sandbox: false`.
3. Feature-gating inputs documented; resolution goes through a `input(ctx, …)`
   helper, not bare `process.env` (§3).
4. Harness/model pair valid; persona-kit/cli/runtime pinned; compiled artifact
   carries every capability you declared (§4, §5).
5. Tests pin the config invariants and were proven red against the broken
   shape (§6).
6. Handler guards: `event.type` prefix check first, terminal events
   early-returned, defensive meta reads with explicit fail-open/closed choices,
   no schedule-name gate on `cron.tick` (there is no `event.name` — §7, G2).
7. Writeback receipts checked where delivery matters (§9).
8. `persona.ts` is statically resolvable: no interpolation, no string
   concatenation, no computed values (§8b). Compiling does not prove this —
   open the Launch Agent URL and confirm the providers panel lists your
   integrations.

## Field gotchas (verified against workforce 4.1.34; agents repo pins runtime/persona-kit/cli 4.1.23)

These each cost a compile/deploy failure in practice; check them before deploy.

- **G1 — `intent` must be a `PERSONA_INTENTS` value.** `persona compile` rejects
  anything else: `persona compile: intent "planning" is invalid`. The shipped set
  includes `relay-orchestrator`, `requirements-analysis`, `architecture-plan`,
  `review`, `documentation`, `verification`, … (see persona-kit `constants.ts`
  `PERSONA_INTENTS`). Note `planning` is a valid **tag**, not an intent — don't
  confuse the two. `tags` is open-ish; `intent` is a closed enum.
- **G2 — cron has no schedule name.** See "Event model (v4)": branch on
  `event.type === 'cron.tick'`; the only schedule fields are `event.schedule`
  (cron expr) and `event.scheduledFor`. Single-schedule personas just run their
  one behavior on `cron.tick`.
- **G3 — an input can't set both `optional: true` and `default`.** `persona
  compile` errors: `cannot set both 'optional: true' and 'default' — pick one`.
  A `default` already makes the input always-resolved; use `default` alone for a
  fallback, or `optional: true` alone for a may-be-empty feature gate.
- **G4 — `agentworkforce deploy` takes a persona FILE path, not a directory**
  (a dir → `EISDIR`). It now accepts the authored **`persona.ts`** source
  directly (compiled in place) as well as a compiled `persona.json`. See the
  deploy runbook.
- **G5 — memory is append-only.** `ctx.memory` has only `save` (with `tags`,
  `scope`, `ttlSeconds` / `expiresInMs`) and `recall` (by relevance + `limit`).
  There is **no delete or upsert**, and `recall` ranks by **relevance, not
  recency**. Consequences for "tight"/"current" memory:
  - to read *the latest* of a tag, recall a handful and pick `max(createdAt)` —
    a naive `limit:1` can return a stale-but-relevant item;
  - keep one **single author** per logical record (e.g. one "brief" writer) so
    copies don't compete;
  - **carry-forward**: re-synthesize the durable record from (previous record +
    recent notes) so it survives raw-note TTL expiry;
  - set short per-write TTLs (`ttlSeconds`) on the handler `save`; the persona's
    `memory.ttlDays` is only a backstop default;
  - to "garden" a noisy tag, write a consolidated/deduped note and let the
    originals lapse via TTL — you can't delete them.
- **G6 — `teamSolve` fan-out is all-or-nothing on the lead's fire.** The cloud
  dispatcher launches the **whole** roster when the lead triggers, and the
  capability is wired to the GitHub-issue launch path — so it can't give roster
  members independent cadences (e.g. a nightly member + an hourly member). When
  teammates need different clocks, prefer an **independent collective**:
  separately-deployed agents that each own their trigger/schedule and cooperate
  through shared **workspace** memory tags, rather than a `team.json` roster.

## Anti-patterns

Avoid these:

- writing old `tiers`-based personas when the repo uses flat runtime fields
- putting business logic into `persona.json`
- declaring integrations that `agent.ts` never uses
- declaring `defineAgent(...).triggers`, `schedules`, or `watch` without implementing branches for them
- using `systemPrompt` as a substitute for explicit code routing
- giant unstructured handlers with no helper functions
- reaching for `ctx.github` / `ctx.linear` / etc. — those per-provider clients no longer exist; use `@relayfile/relay-helpers` (or the runtime VFS helpers)
- hardcoding `/<provider>/...` mount paths in the handler when a `@relayfile/relay-helpers` client already resolves them from the catalog
- invoking external commands (`curl`, `gh`, provider SDKs) for provider reads/writes that relay-helpers / the VFS helpers already cover via Relayfile draft writes
- assuming all provider payload fields exist without validation

## Deploying: lead the human from local login to a live cloud agent

Authoring isn't finished at the files — **drive the deploy end to end** with the
`agentworkforce` CLI. Run every non-interactive step yourself, hand the human
only the steps that genuinely need a browser, and narrate what each command
printed so they always know the state.

**What you (the agent) can do vs. what the human must do**

- **Human-only (interactive browser):** `agentworkforce login` (OAuth sign-in)
  and the per-provider **connect** popups during deploy. You can't complete a
  browser OAuth flow — ask the human to run the command / finish the popup, then
  continue.
- **You run:** the dry-run, the deploy itself (once the human is logged in),
  `deployments list`, reading the printed deployment URL/status, and `destroy`.
  (If your environment can't run the CLI at all, hand the human the exact
  commands below in order and tell them what each should print.)

**Runbook**

1. **Check auth.** If a CLI call 401s, the human isn't logged in. Ask them to run
   `agentworkforce login` — it opens the browser to `https://agentrelay.com`, they
   pick a workspace, and it resolves the workspace descriptor
   (`GET /api/v1/workspaces/<ws>/resolve`) and stores a **workspace key** in the
   agent-relay cloud session store — then wait for them to confirm before
   continuing. `--workspace <id-or-slug>` skips the picker. (Login **no longer
   writes** a `~/.agentworkforce/active.json` pointer, so don't test for that file
   — a 401 is the reliable "not logged in" signal.)

2. **Dry-run — you run this.** Validate before any side effects:

   ```bash
   agentworkforce deploy ./path/to/persona/persona.ts --mode cloud --dry-run
   ```

   **Pass a FILE, not the directory** (a directory → `EISDIR`). Deploy now
   accepts the authored **`persona.ts`** source directly (it compiles it in
   place via `compileAgentSource`/`loadPersonaSourceFile`) — you no longer need a
   separate `agentworkforce persona compile` step first; a `persona.json` path
   still works too. A clean
   dry-run prints e.g. `persona <id>: N integration(s), M schedule(s)` then
   `ok: <id> (dry-run)` — eyeball those counts. Fix any preflight error (missing
   `onEvent`, wrong shape, an integration the `agent.ts` listens on but
   `persona.json` doesn't declare; an invalid `intent`) and re-run until clean.

3. **Deploy — you run this; the human completes any connect popups.**

   ```bash
   agentworkforce deploy ./path/to/persona/persona.ts --mode cloud --on-exists update
   ```

   - It compiles + bundles the persona spec + `agent.ts` and, for each provider in
     the persona's `integrations` that isn't connected yet, opens a connect flow —
     relay that to the human and wait for them to finish before continuing.
   - `--on-exists update` redeploys over an existing persona of the same id.
     **Gotcha:** the default is `cancel`, a silent no-op — if a deploy "did
     nothing", you wanted `--on-exists update`.
   - `--reconnect <provider>` forces a fresh connect — it now also covers the
     **harness LLM credential** (e.g. `--reconnect openai/codex`,
     `--reconnect anthropic/claude`), and is repeatable; `--no-connect` fails
     instead of prompting (use only when everything's already connected);
     `--input key=value` overrides a declared input; `--detach` backgrounds the runner.
   - `--harness-source <managed|byok|oauth>` selects how the harness LLM
     authenticates (`managed` = platform-managed credential, `byok` = your own
     API key, `oauth` = OAuth). **`plan` is a legacy alias for `managed`** — the
     old `--harness-source plan` still works but prefer `managed`.

4. **Confirm it's live — you run this.** Capture the deployment URL/status the
   deploy printed, then:

   ```bash
   agentworkforce deployments list       # what's running in the workspace
   ```

   Report back to the human: **the deployment link**, which triggers/schedules
   registered, and which integrations are connected. Tear down with
   `agentworkforce destroy ./path/to/persona` when needed.

Triggers/schedules/watch declared in `defineAgent(...)` register at deploy time,
so every integration the agent listens on must be connected — an unconnected
provider means its triggers never fire.

## Validation checklist

Before declaring the persona done:

1. `persona.json` matches the current schema shape used in examples
2. `cloud` personas include `onEvent`
3. `agent.ts` uses `defineAgent(...)` with either a listener source:
   - `triggers`, or
   - `schedules`, or
   - `watch`
   or an intentional team-member shape like `launchedBy: 'team-dispatcher'`
4. every declared trigger, schedule, or watch rule has a code path in `handler`
5. every provider named in `agent.ts` listener config is also declared in `persona.json.integrations`
6. `systemPrompt` describes the role clearly
7. harness/model/settings fit the job
8. memory config is intentional, not accidental
9. the handler uses `ctx.log(...)` or durable side effects clearly enough for debugging

## Output contract for this skill

When creating or editing a cloud persona, return:

1. the full `persona.json`
2. the full `agent.ts`
3. a short note explaining:
   - why the chosen listener declarations belong in `defineAgent(...)`
   - why the chosen deploy/runtime config belongs in `persona.json`
   - why the chosen behavior belongs in `agent.ts`
   - which current Workforce example the shape most closely follows
4. then **drive the deploy** per "Deploying" above — don't stop at the files.
   Run the dry-run and deploy yourself; ask the human to run `agentworkforce
   login` and to finish each integration-connect popup; and finish by reporting
   the live deployment link, the registered triggers/schedules, and the
   connected integrations.
