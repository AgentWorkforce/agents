# agents evals

Repeatable dry-runs of the showcase agents. Each **case** (`cases.jsonl`) fires
one event at one agent's handler and checks what it did. This complements
`npm test` (the `node --test` unit suite + the persona-scope guard): the unit
tests assert handler internals with hand-rolled spies; these evals run the
**real handler** through the runtime's simulation API and, in live mode, against
an actual cheap model.

```sh
npm run evals                 # simulate mode, all cases (free, offline)
npm run evals -- --agent review
npm run evals -- --case linear-slack.chat
npm run evals -- --suite chat        # by kind: chat|triage|scheduled|guard
npm run evals -- --list
npm run evals:live            # real cheap-model replies + LLM judge
npm run evals:hn              # focused HN feed + follow-up-chat cases
```

`npm run evals` compiles personas first (they are gitignored — `*/persona.json`
is built from `persona.ts` on demand), then runs the suite.

## Two executors

**simulate** (default) runs each case through the runtime's local
`simulateInvocation`. The handler executes for real against an in-memory VFS
seeded from the case, but `harness.run` / `llm.complete` are **stubbed** (no
model, no tokens). We assert deterministic facts: the run succeeded (or failed
as expected), it routed to the expected `eventSource`, and the expected side
effects / log lines appeared. This is the fast, free **routing/plumbing
regression gate**.

**live** (`--live`) runs the real handler with `harness.run` and `llm.complete`
backed by a cheap **opencode** model (default `opencode/gpt-5-nano`, override
with `WD_EVAL_MODEL`), so chat cases get an **actual agent reply**. Add
`--judge` to grade each chat reply against the case `rubric` with the same cheap
model (LLM-as-judge). Needs `opencode` on PATH and `OPENCODE_API_KEY`. The judge
only grades `kind:"chat"` cases; for the rest the routing + side-effect checks
are the gate.

## How seeding works (and why it's `_index.json`)

The simulator backs the VFS as an in-memory map exposed only through
`ctx.files.read(exactPath)` — it has **no directory-listing primitive**. A
case's `seeds` list names provider dirs (`"linear/projects"`), which the runner
maps to `/linear/projects/_index.json` ← `seeds/linear-projects.json`. Agents
that enumerate a dir read that blessed `_index.json`; agents that list via
`sandbox.exec`/`find` see nothing (it's stubbed).

Seeds are **also materialized to the disk mount** (`RELAYFILE_MOUNT_ROOT`), so
agents that read through a relay-helpers client (e.g.
`linearClient().getIssue` resolves `/linear/issues/by-uuid/<id>.json`) get their
data too. Use the long seed form to drop a file at an exact VFS path:
`{ "vfs": "/linear/issues/by-uuid/issue-1.json", "file": "linear-issue-1.json" }`.

HTTP-backed agents can declare deterministic responses with an `http` list:

```json
"http": [
  { "match": "tags=front_page", "file": "hn-front-page.json" },
  { "match": "/api/v1/items/1001", "file": "hn-item-1001.json" }
]
```

The first URL substring match wins. Once a case declares HTTP fixtures, an
unmatched request fails the case instead of reaching the network. This makes
the HN relevance/feed/chat evals repeatable on both a laptop and the SF Mac
mini.

## What simulate can and can't see

Only `harness.run` and `llm.complete` are recorded as side effects.
`slackClient` / `linearClient` / `githubClient` writes are **not** recorded, and
real `fetch` calls (hn-monitor's HN Algolia, spotify-releases' Spotify API,
vendor-monitor's npm registry) hit the network or fail closed. So:

- **harness/llm agents** (linear-slack, linear, review, repo-hygiene, granola)
  assert the recorded side effect + a happy-path log.
- **cron warn-only team members** (cloud-team-implementer/reviewer) assert the
  misroute warning — their real work happens only in the team dispatcher's
  sandbox, which simulate does not run.
- **fetch-only agents with no recorded side effect** (spotify-releases,
  vendor-monitor) can't assert a positive in simulate, so their deterministic
  coverage is the **required-input guard**: a case with `expect.status:"failed"`
  + `expect.errorIncludes` proves the agent refuses to run without its inputs.

## Case shape (`cases.jsonl`, one JSON object per line)

```jsonc
{
  "id": "review.review", "agent": "review", "kind": "triage",
  "fixture": { "type": "github.pull_request.opened",
               "resource": { "pull_request": { "number": 7, ... }, "repository": { ... } } },
  "inputs": { "APPROVERS": "alice" },
  "seeds": [{ "vfs": "/github/repos/acme/widget/pulls/7/meta.json", "file": "github-pr-widget-7-meta.json" }],
  "expect": { "status": "succeeded", "eventSource": "github", "sideEffectsAll": ["harness.run"] },
  "rubric": "..."
}
```

`agent` is the dir path relative to the repo root — flat (`review`) or nested
team member (`competitor/market-competitor`), both work. `expect` keys:
`status` (`succeeded` | `failed`), `errorIncludes` (substring of the thrown
error, for guard cases), `eventSource`, `sideEffectsAll` (all must appear),
`sideEffectsAny` (≥1), `logsAny` (≥1 listed log message), `logsAll` (every
listed log message), `structuredLogsAll` (every `{message, attrs}` subset must
match a captured structured log), and `replyContains` (machine-checked
substrings in live replies; skipped in simulate mode where no model reply is
produced).

Artifacts land in `.evals/runs/<stamp>/{result.json,summary.md}` (gitignored).

## Fast HN iteration, including the Mac mini surface

Keep the inner loop deterministic and local:

```sh
npm run test:hn
npm run evals:hn
npm run preview:hn  # read-only live HN selection + Slack-text preview
```

Use the live executor only when changing model-facing curation/chat prompts:

```sh
npm run evals:live -- --agent hn-monitor --judge
```

The SF mini is a real proactive execution surface, not remote CI. Cloudflare
reaches its loopback-bound runner through the authenticated Tailscale Funnel at
`https://sf-mac-mini.tailf3b8ad.ts.net` (see the Cloud repo's
`docs/runbooks/mini-sandbox-runner.md`). After the local gates pass:

1. Use a dev Cloud stage whose deployed environment has
   `SANDBOX_PROVIDER=local`,
   `LOCAL_SANDBOX_URL=https://sf-mac-mini.tailf3b8ad.ts.net`, and the
   matching `MiniSandboxToken` secret.
2. Deploy or update `hn-monitor/persona.ts` in that stage and point
   `SLACK_CHANNEL` at a dev channel.
3. Run the same manual trigger used for any deployed proactive persona:

   ```sh
   agentworkforce trigger hn-monitor --workspace <workspace> --cloud-url <stage-url> --json
   agentworkforce deployments logs hn-monitor --workspace <workspace> --cloud-url <stage-url> --tail 100
   ```

4. Verify the run appears in the mini runner logs, the digest has a top-level
   header plus threaded body in Slack, and an `app_mention` follow-up is
   answered in that thread.

This is the final end-to-end gate: Cloud owns the schedule/event wakeup,
durability, credentials, and delivery; the mini runs the actual persona
sandbox. The trigger posts for real, so do not run it against a production
channel as part of the ordinary inner loop.
