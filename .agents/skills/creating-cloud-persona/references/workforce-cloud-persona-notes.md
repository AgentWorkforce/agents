# Workforce Cloud Persona Notes

Use these notes to ground the skill in the current repo shape.

## Current realities

- Cloud personas use flat top-level runtime fields:
  - `harness`
  - `model`
  - `systemPrompt`
  - `harnessSettings`
- `onEvent` points to the handler entrypoint, usually `./agent.ts`
- Trigger, schedule, and watch declarations now live in `agent.ts` via `defineAgent(...)`
- Team-member agents can intentionally have no trigger/schedule/watch and use
  `launchedBy: 'team-dispatcher'` so only the lead subscribes to provider events
- `persona.json.integrations` is for connection/setup requirements, not event trigger declaration
- Runtime events use the **v4 `AgentEvent`** model (`@agent-relay/events`): discriminate on
  `event.type` (a provider-prefixed dotted string like `cron.tick`,
  `github.pull_request.opened`, `linear.AgentSessionEvent.created`), and read the payload via
  `await event.expand('full')` (async). The pre-v4 `{ source, name, payload }` envelope —
  and `WorkforceProviderEvent` / `WorkforceCronEvent` — are **removed**. Runtime re-exports typed
  guards: `isCronTickEvent`, `isRelaycastMessageEvent`, `isRelayfileChangeEvent`, `isStartupEvent`.
- There are **no** per-provider clients on `ctx` (`ctx.github` / `ctx.linear` were removed). Provider reads/writes use **`@relayfile/relay-helpers`** — catalog-backed factory clients (`linearClient().comment(...)`, `slackClient().post(...)`, `githubClient().mergePullRequest(...)`, generic `relayClient(provider)` / `providerClient(provider)`). Writes are draft files the Relayfile writeback worker materializes into real provider calls. The raw `@agentworkforce/runtime` VFS helpers (`readJsonFile`/`writeJsonFile`/`draftFile`/`resolveMountRoot`) are the lower-level fallback for non-catalog reads
- **Thread Slack digests instead of dumping one wall of text.** For an agent that posts a multi-item digest to a channel (HN/vendor/Neon/GCP monitors, x-reply-radar), post a compact **count header** first, then thread the detail under it so the channel stays scannable. Use the server-side threading path: `slackClient().post(channel, headerText)` returns `{ ts, ref }`; pass that `ref` as `opts.replyTo` on each follow-up `post(channel, body, { replyTo: ref })` and the cloud orders the reply after the header delivers and sets `thread_ts` itself — **no parent-receipt round-trip**, so nothing blocks waiting for the header's `ts`. (Lower-level equivalent: `slackClient({ writebackTimeoutMs: 0 }).messages.write({ channelId }, { parentRef, ...body })`, writing `parentRef` FIRST so the cloud can lift it from the streamed head.) Idempotency caveat: once the header has posted, **do not throw** out of the post block — a thrown handler is retried by the runtime and re-posts a duplicate header. Claim "seen"/dedupe state as soon as the header lands and swallow+log later failures; only release the claim and rethrow while nothing has posted yet. See `references/agents/hn-monitor/agent.ts` (`postFreshStories`) for the reference implementation. For replying under a known message (an `app_mention` whose real `ts` you already have), use ts-based threading instead: `slackClient().reply(channel, ts, text)`.
- Deploy is **agent-driven** via the `agentworkforce` CLI: the agent runs `deploy <persona> --mode cloud --dry-run` then `deploy <persona> --mode cloud --on-exists update` (default `--on-exists` is `cancel`, a silent no-op) and reports the live link; the human runs the interactive `login` and finishes each integration-connect popup. Login now resolves a workspace descriptor (`GET /api/v1/workspaces/<ws>/resolve`) and stores a **workspace key** in the agent-relay cloud session store — it no longer writes a `~/.agentworkforce/active.json` pointer, so don't gate "is the human logged in?" on that file; a 401 from a CLI call is the reliable signal.

## Good source files to inspect

The skill vendors the reference files it depends on. Inspect these local paths
inside `skills/creating-cloud-persona/references/`:

Agents ship as a `persona.ts` + `agent.ts` pair. `persona.ts` is the authored
source; each dir also has the compiled `persona.json` vendored (via
`agentworkforce persona compile`, persona-kit 4.1.23) so you can see the shipped
shape. In the live agents repo the `.json` is gitignored and regenerated on
demand — edit `persona.ts`, never the artifact:

- `references/agents/review/{persona.ts,agent.ts}`
- `references/agents/repo-hygiene/{persona.ts,agent.ts}`
- `references/agents/linear/{persona.ts,agent.ts}`
- `references/agents/linear-slack/{persona.ts,agent.ts}`
- `references/agents/hn-monitor/{persona.ts,agent.ts}`
- `references/agents/joke-bot/{persona.ts,agent.ts}` (`sandbox: false` conversational)
- `references/agents/inbox-buddy/{persona.ts,agent.ts}` (`sandbox: true` for VFS reads)
- `references/agents/gcp-watcher/{persona.ts,agent.ts}` (token-free VFS monitor)
- `references/agents/cloud-team-implementer/{persona.ts,agent.ts}`
- `references/agents/cloud-team-reviewer/{persona.ts,agent.ts}`
- `references/agents/shared/telegram.ts` (dual-transport helper imported by joke-bot/inbox-buddy)

Workforce examples (these DO commit `persona.json`):

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
- `references/relayfile-adapters/packages/relay-helpers/README.md` — the ergonomic provider clients (now **36** named clients: 31 generated + 5 bespoke) plus the `relayClient`/`providerClient` escape hatches, and the `/transport` preview + write-authorizer subpath
- `references/workforce/packages/runtime/src/clients/index.ts` (the VFS helpers, re-exported from `@relayfile/adapter-core/vfs-client` — the lower-level fallback)
- `references/workforce/packages/cli/src/deploy-command.ts` (the `login` / `deploy` flow)
- `references/workforce/packages/deploy/src/extract-agent.ts` (why a bare `export default handler(...)` is rejected — `defineAgent` is required)

## Important nuance

Older plan/docs may still mention `tiers`, old proactive shapes, or trigger
declarations on the persona. Prefer the vendored production agents, Workforce
examples, `defineAgent(...)` examples, and current `persona-kit` / runtime types
over older planning text when they conflict.

## Authoring heuristic

- Put deploy/runtime config and integration connection requirements in `persona.json`
- Put wakeup declarations in `defineAgent(...)` inside `agent.ts`
- For team-member personas, omit wakeups and use `launchedBy: 'team-dispatcher'`
- Put branch logic and side effects in the handler
- Keep one persona/agent = one coherent job
- Keep the handler imperative and readable
