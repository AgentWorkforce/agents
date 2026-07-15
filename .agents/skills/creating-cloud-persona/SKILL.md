---
name: creating-cloud-persona
description: Use when creating, updating, or reviewing a Workforce cloud persona (`persona.json`/`persona.ts` + `agent.ts`) for the current deploy/runtime shape. Covers `cloud`, `useSubscription`, integrations with scope mounting and adapter config passthrough, inputs, memory, sandbox modes, `onEvent`, top-level runtime fields, `defineAgent(...)` triggers/schedules/watch/team-dispatcher launch, provider IO via `@relayfile/relay-helpers`, production-correctness traps, vendored examples, and deploy flow. Use for requests like “create a cloud persona”, “write a deployable workforce persona”, “add integrations to a persona”, “configure GitHub materialization for a persona”, “review a workforce persona”, or “author the agent.ts handler for a workforce persona”.
---

### Core rule

- `persona.json` declares **deployment metadata and runtime wiring**
- `agent.ts` implements the **actual behavior**

### First read

- `references/agents/review/persona.json`
- `references/agents/review/agent.ts`
- `references/agents/repo-hygiene/persona.json`
- `references/agents/repo-hygiene/agent.ts`
- `references/agents/linear/persona.json`
- `references/agents/linear/agent.ts`
- `references/agents/hn-monitor/persona.json`
- `references/agents/hn-monitor/agent.ts`
- `references/agents/cloud-team-implementer/persona.json`
- `references/agents/cloud-team-implementer/agent.ts`
- `references/agents/cloud-team-reviewer/persona.json`
- `references/agents/cloud-team-reviewer/agent.ts`
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
- `references/workforce/packages/persona-kit/src/types.ts`
- `references/workforce/packages/runtime/src/types.ts`
- `references/workforce/packages/persona-kit/schemas/persona.schema.json`
- `references/workforce/packages/deploy/src/preflight.ts`
- `references/workforce/packages/deploy/src/extract-agent.ts`
- `references/workforce/packages/cli/src/deploy-command.ts`
- `references/relayfile-adapters/packages/relay-helpers/README.md`

### Current persona shape to follow

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

### Mental model

- declares whether the persona is deployable
- chooses the harness/model/runtime knobs
- declares which integrations must be connected
- enables memory
- points at the handler entrypoint
- optionally declares capabilities/metadata
- exports `defineAgent({...})`
- declares `triggers`, `schedules`, and optionally `watch`; team-member agents
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

### Trigger model

- **Clock** via `defineAgent({ schedules: [...] })`
- branch on `event.type === 'cron.tick'`
- the cron event carries `event.schedule` (the cron expr / one-shot id) and
- **Radio** via `defineAgent({ triggers: { <provider>: [...] } })`
- the event's `type` is the **provider-prefixed** `on` value: a trigger
- branch with `event.type === '<provider>.<on>'` (or
- **Relayfile watch** via `defineAgent({ watch: [...] })`
- for file/path-driven proactive behavior
- keep this for cases that are truly about Relayfile path changes, not provider event hooks
- **Team member** via `defineAgent({ launchedBy: 'team-dispatcher', handler })`
- no direct triggers/schedules/watch
- launched by a lead/team dispatcher to avoid duplicate subscriptions
- see `references/agents/cloud-team-implementer/agent.ts` and

### Event model (v4) — verified against runtime 4.1.14

#### The handler `event` is the relay SDK's normalized `AgentEvent`

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


### Authoring rules

#### 3. Only declare integrations the agent actually requires — with a `scope`

```ts
integrations: {
  // Replies in-thread (writeback to /slack/channels/{id}/messages), so scope channels.
  slack: { scope: { channels: '/slack/channels/**' } },
  // Read-only Linear context — scope the concrete subpaths the handler reads.
  linear: { scope: { projects: '/linear/projects/**', issues: '/linear/issues/**' } }
}
```

#### 3b. Gate conditional integrations with `optional` + `enabledByInput`

```ts
integrations: {
  slack: {
    optional: true,
    enabledByInput: 'SLACK_CHANNEL',          // set SLACK_CHANNEL → Slack connects
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

#### 4. Use `integrations.<provider>.config` for adapter behavior, not mount behavior

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


### Good starter pattern

#### persona.json

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

#### agent.ts

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


### Event-shape guidance

- cron events: `event.type === 'cron.tick'`, with `event.schedule` / `event.scheduledFor` (no `event.name`)
- provider events: `event.type === '<provider>.<on>'`; the payload is `(await event.expand('full')).data` (async), not `event.payload`
- treat the expanded `.data` as provider-normalized but still loosely typed
- write small local extractor helpers instead of spreading unsafe casts everywhere
- validate required identifiers early and fail clearly
- prefer `defineAgent({...})` + helper functions over giant inline `if` blocks

### Context usage guidance

#### Provider reads and writes — use `@relayfile/relay-helpers`

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


### When to use `ctx.harness.run(...)`

- PR review comments
- replies to mentions
- code-fix suggestions
- summarization
- clustering and writing human-facing output

### Inputs and env

- target repo
- topic list
- destination channel
- project code

### Common patterns

- `cloud: true`
- integration connection declarations like `github` or `slack`
- optional `inputs` for topics/repos/channels
- `defineAgent({ schedules: [...] })`
- branch on `event.type === 'cron.tick'` (multi-schedule: match `event.schedule`)
- fetch/search/gather
- summarize
- post or upsert
- save memory if the artifact matters later
- `integrations.<provider>` for connection requirements
- `useSubscription: true` if the judgment should run on the user’s linked provider path
- often `memory.workspace`
- `defineAgent({ triggers: { <provider>: [...] } })`
- branch on `event.type` (`'<provider>.<on>'`, or `.startsWith('<provider>.')`)
- extract target identifiers from `(await event.expand('full')).data`
- optionally load prior memory
- call harness for judgment/output
- write back with `@relayfile/relay-helpers`; use `writeJsonFile(...)` only
- responds to Slack mentions and also runs a daily cleanup
- reacts to GitHub events and runs a weekly scan
- `cloud: true`
- usually declares integrations needed by the member's sandbox/work
- harness/model/systemPrompt/harnessSettings describe the member role
- `onEvent: "./agent.ts"`
- `defineAgent({ launchedBy: 'team-dispatcher', handler })`
- no `triggers`, `schedules`, or `watch`
- handler should usually log and return if invoked directly
- do not subscribe team members to the same provider events as the lead, or the

### Production correctness checklist

These rules came from shipped Workforce/agents defects. Apply them after the basic persona shape is in place and before deploy.

### 1. THE INTEGRATION SCOPE TRAP — declared ≠ mounted

#### **A persona integration without a `scope` mounts nothing.** Cloud derives the

```ts
integrations: {
  github: {},
  slack: {}     // ← INERT: no trigger, no scope → zero /slack paths mounted
}
```


### 2. `sandbox: true` vs `sandbox: false`

- the harness needs the box and its mounted CLI

### 3. Inputs — declaration and resolution

#### Declare inputs in the persona spec:

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


### 4. Harness and model selection

- `harness`: which CLI runs `ctx.harness.run()` prompts — `'codex'` or
- `harnessSettings`: `reasoning`, `timeoutSeconds`, `sandboxMode`,
- Version pinning: capabilities, `integrations.<provider>.config`, and other

### 5. Teams — `teamSolve` capability and `team.json`

#### A lead persona opts into team orchestration via capabilities

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


### 6. The showcase quality bar (AgentWorkforce/agents repo)

- **No inline base64 blobs, no `node -e` one-liners, no hand-rolled shell
- **Pass data as JSON arguments** (a JSON file or single JSON env/arg), never
- **Golden tests are a merge gate.** Exported pure helpers (`readPr`,
- persona.json is **generated** from persona.ts in the agents repo (untracked

### 7. `onEvent` handler patterns

- **First line** (single-provider personas): `if (!event.type.startsWith('<provider>.')) return;` — multi-provider handlers branch per `event.type` prefix instead of returning early. (v4: there is no `event.source`.)
- **Terminal-event guards before work**: approval → merge → return;
- **Read materialized meta defensively.** Provider projections drift — accept
- **Cron**: branch on `event.type === 'cron.tick'`. The v4 cron event has **no
- **Sentinel contracts with the harness**: if the handler keys behavior off
- Log skips with reasons (`ctx.log?.('info', 'skipped', { reason })`) — a

### 8. Delegation — `ctx.workflow.run` vs `ctx.harness.run`

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

### 9. Relayfile — how provider clients actually resolve

- **The path must be mounted** (token-scoped + daemon-watched) or the draft
- **Anchor the mount root explicitly.** The runner's CWD is not the mount
- **A returned receipt is the success signal.** `result.receipt?.created/id`
- Item paths (ending `.json`) are direct read/write; collection paths take
- Terminal provider states (closed/merged/archived) stay readable as records

### Production pre-merge checklist

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

### Field gotchas (verified against runtime 4.1.14 / persona-kit & cli 4.1.12)

- **G1 — `intent` must be a `PERSONA_INTENTS` value.** `persona compile` rejects
- **G2 — cron has no schedule name.** See "Event model (v4)": branch on
- **G3 — an input can't set both `optional: true` and `default`.** `persona
- **G4 — `agentworkforce deploy` takes the `persona.json` file path**, not the
- **G5 — memory is append-only.** `ctx.memory` has only `save` (with `tags`,
- to read *the latest* of a tag, recall a handful and pick `max(createdAt)` —
- keep one **single author** per logical record (e.g. one "brief" writer) so
- **carry-forward**: re-synthesize the durable record from (previous record +
- set short per-write TTLs (`ttlSeconds`) on the handler `save`; the persona's
- to "garden" a noisy tag, write a consolidated/deduped note and let the
- **G6 — `teamSolve` fan-out is all-or-nothing on the lead's fire.** The cloud

### Anti-patterns

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

### Deploying: lead the human from local login to a live cloud agent

#### Authoring isn't finished at the files — **drive the deploy end to end** with the

```bash
agentworkforce deploy ./path/to/persona/persona.json --mode cloud --dry-run
```


### Validation checklist

- `persona.json` matches the current schema shape used in examples
- `cloud` personas include `onEvent`
- `agent.ts` uses `defineAgent(...)` with either a listener source:
- `triggers`, or
- `schedules`, or
- `watch`
- every declared trigger, schedule, or watch rule has a code path in `handler`
- every provider named in `agent.ts` listener config is also declared in `persona.json.integrations`
- `systemPrompt` describes the role clearly
- harness/model/settings fit the job
- memory config is intentional, not accidental
- the handler uses `ctx.log(...)` or durable side effects clearly enough for debugging

### Overview

Use this skill when authoring a deployable Workforce persona in the **current** shape.

### Output contract for this skill

- the full `persona.json`
- the full `agent.ts`
- a short note explaining:
- why the chosen listener declarations belong in `defineAgent(...)`
- why the chosen deploy/runtime config belongs in `persona.json`
- why the chosen behavior belongs in `agent.ts`
- which current Workforce example the shape most closely follows
- then **drive the deploy** per "Deploying" above — don't stop at the files.
