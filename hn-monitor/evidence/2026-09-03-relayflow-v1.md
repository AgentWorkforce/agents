# HN Monitor → Relayflow v1 evidence (2026-09-03)

## Scope and durability

The product surface is the deployed `hn-monitor/persona.ts` plus
`hn-monitor/agent.ts`. The implementation preserves the schedule, HN reads,
ranking, channel-scoped seen claim, header/thread delivery, exact Slack state,
semantic memory, pending-body recovery, and conversational Q&A. Only scheduled
digest curation moved behind a Relayflow v1 workflow.

Initial worktree proof, before the red test:

```text
$ pwd
/Users/khaliqgant/Projects/AgentWorkforce/agents-hn-relayflow-wt
$ git rev-parse --abbrev-ref HEAD
feat/hn-monitor-relayflow-v1-0903
$ git rev-parse HEAD
0c13481cead33063bf6aa435185483b37fa4201b
```

The path had been removed twice by external workspace activity before edits.
The branch ref remained at the base commit, no install lifecycle hook or active
`git worktree remove`/cleanup process was found, and no prior changes existed.
All later commands used the absolute worktree and the first two checkpoints were
pushed as `18ab776` (red test) and `c1390fc` (product workflow). Deploy closure
was pushed as `7757261`.

## Red first

```text
$ npm run test:hn
✖ defineAgent scan schedule invokes the durable Relayflow v1 digest before publishing
AssertionError: runScheduledScan must be exported by the product schedule path
ℹ tests 30
ℹ pass 29
ℹ fail 1
```

This failed against the actual `defineAgent` cron entrypoint, not a meta
workflow. The red assertion required that the scheduled scan delegate to a
testable product seam and invoke a named v1 workflow before any provider write.

## Focused product and journal gates

```text
$ npm run test:hn
✔ defineAgent scan schedule invokes the durable Relayflow v1 digest before publishing
...
✔ pinned Relayflow v1 resumes a failed run without replaying completed HN step identities
✔ v1 resume reactivation rejects non-failed runs and touches only named descendants
✔ generated workflow dry run resolves least-privilege artifact grants and denies an unrelated secret
ℹ tests 36
ℹ pass 36
ℹ fail 0
```

The resume fixture intentionally fails `analyze-stories` after
`prepare-input`. On resume it proves the same run ID, no replay marker from the
completed preparation step, a successful analysis retry, and execution of the
reactivated `validate-digest` descendant:

```text
[workflow 00:00] [analyze-stories] Command failed (exit code 2)
[workflow 00:00] Starting workflow "hn-monitor-v1-resume-fixture-workflow"
[workflow 00:00] [analyze-stories] Output: resumed analysis
[workflow 00:00] [validate-digest] Output:
HN_DIGEST_NOTES_JSON:{"theme":"fixture","stories":[]}
3 passed, 0 failed, 0 skipped
```

The compatibility helper exists because pinned core `1.0.6` resets failed
steps but leaves their skipped descendants inert. It rejects running,
completed, and wrong-workflow runs, and updates only the explicitly named
skipped descendants; completed step rows and outputs are left untouched.

The focused suite also starts two scheduled scans concurrently from delayed,
stale memory snapshots and proves only one Relayflow and one header/body pair
execute. A separate failure/recovery test makes exact Slack state unavailable
after both messages are delivered, then proves the next scheduled tick restores
state without a second workflow or provider write.

```text
$ npm run typecheck
> tsc --noEmit
(exit 0)

$ node scripts/test.mjs tests/hn-monitor-cases.test.mjs
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

## Relayflow v1 dry run

```text
$ env DRY_RUN=1 invocationArgs='{"relayflowVersion":"v1","batchKey":"hn-monitor:v1:20","stories":[{"id":20,"title":"Show HN: Durable agent workflow journals","category":"agent orchestration","points":120,"comments":42,"feeds":["show_hn"],"url":"https://example.com/agent-workflows","hnUrl":"https://news.ycombinator.com/item?id=20"}]}' ./node_modules/.bin/tsx workflows/hn-monitor-scheduled-digest-v1.ts
Dry Run: hn-monitor-scheduled-digest-v1-workflow
Pattern: pipeline | Max Concurrency: 1
Agents (2): curator, reviewer
Execution Plan (4 steps, 4 waves):
  Wave 1: prepare-input
  Wave 2: analyze-stories
  Wave 3: review-digest
  Wave 4: validate-digest
Validation: PASS (0 errors, 0 warnings)
HN_RELAYFLOW_DRY_RUN:{"name":"hn-monitor-scheduled-digest-v1-workflow","stepCount":4,"batchKey":"hn-monitor:v1:20","permissions":[{"agent":"curator","access":"restricted","readPaths":1,"writePaths":1,...},{"agent":"reviewer","access":"restricted","readPaths":2,"writePaths":1,...}]}
```

The `.ts` file in that command is the runtime materialization of the tracked,
typechecked source generator and is intentionally ignored by Git.

## Deterministic platform E2E

```text
$ env WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=30000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=60000 npm run evals:hn
(exit 0; every checked-in non-live HN case passed)
```

Representative scheduled trace order:

```text
07. [PREVIEW] memory.save tags=["hn-monitor:seen"]
08. [PREVIEW] files.write path=workflows/hn-monitor-scheduled-digest-v1.ts bytes=14095
09. [PREVIEW] compose.run name=hn-monitor-scheduled-digest-v1 relayflowVersion=v1 batchKey=hn-monitor:v1:1001,1002,1003
10. [PREVIEW] provider.write slack.messages (header)
11. [PREVIEW] memory.save tags=["hn-monitor:pending-post-state"]
12. [PREVIEW] provider.write slack.messages (thread body)
13. [PREVIEW] files.write exact per-thread digest state
14. [PREVIEW] files.write rolling digest index
15. [PREVIEW] memory.save tags=["hn-monitor:post"]
16. [PREVIEW] memory.save tags=["hn-monitor:pending-post-state"] (clear)
```

The multi-turn fixture also proves the later Slack Q&A path still performs the
grounded item read, `model.complete`, and in-thread reply.

## Live HN read without production writes

The first cold start timed out before readiness at 30 seconds. The same command
with a 60-second readiness allowance completed:

```text
$ env WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=60000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=120000 npm run preview:hn -- --output ./hn-monitor/live-read.run.json
preview: 1 run(s) — 1 ok, 0 failed
policy: reads=live writes=preview model=stub shell=simulate compose=preview
```

Captured RunRecord summary:

```json
{
  "status": "succeeded",
  "liveReads": ["show_hn:current", "front_page:current", "new:current"],
  "workflowSource": {"status":"previewed","path":"workflows/hn-monitor-scheduled-digest-v1.ts","bytes":14095},
  "workflow": {"status":"previewed","name":"hn-monitor-scheduled-digest-v1","version":"v1","batchKey":"hn-monitor:v1:49534948,49535390,49536840,49539792,49542723,49545164,49546659,49546831"},
  "providerWrites": ["slack.messages:previewed", "slack.messages:previewed"]
}
```

The RunRecord was deleted after extracting this evidence. No provider write had
status `executed`, and no deployment was performed.

## Existing deploy surface and packaged handler

```text
$ ./node_modules/.bin/agentworkforce deploy ./hn-monitor/persona.ts --mode cloud --dry-run --no-prompt
persona hn-monitor: 0 integration(s), 1 schedule(s)
--dry-run: persona validated; exiting before any side effects
ok: hn-monitor (dry-run)

$ ./node_modules/.bin/agentworkforce deploy ./hn-monitor/persona.ts --mode cloud --bundle-out ./.hn-bundle-review-i2 --no-prompt
bundle: staged to .hn-bundle-review-i2/runner.mjs (668.5KB)
--bundle-out: bundle ready at .hn-bundle-review-i2; skipping launch

$ node scripts/acceptance/hn-relayflow-bundle-smoke.mjs ./.hn-bundle-review-i2
{"workflow":"hn-monitor-scheduled-digest-v1","version":"v1","sourceBytes":14095,"posts":2,"stateSaves":4}
```

The bundle smoke invokes `postFreshStories` from the emitted
`agent.bundle.mjs`, proves the bundled handler materializes a self-contained
core workflow before `ctx.workflow.run`, consumes a validated result, publishes
the same header/thread pair, and saves seen/post state.

## Repository regression result

```text
$ npm test
ℹ tests 338
ℹ pass 336
ℹ fail 2
```

Both failures are pre-existing sibling-checkout prerequisites, not HN tests:

```text
ENOENT: /Users/khaliqgant/Projects/AgentWorkforce/workforce/packages/harness-kit/package.json
✖ required Workforce package closure covers the installed invoke path
✖ published package proof derives exact versions from the producer manifests
```

That sibling checkout is on `main` at `e95ecf2`, behind its origin, and its
`packages/harness-kit` contains only `dist/`. It was inspected but not changed.
All HN tests, typechecking, deterministic E2E, live-read preview, v1 dry-run,
persona compile/deploy validation, and packaged-handler smoke are green.

## Security and deferred seam

No credential values were added. Story titles are treated as untrusted data;
agents are instructed not to follow title instructions or browse, and a
deterministic gate requires the exact batch key and story IDs with bounded
text. Each agent runs from the batch artifact directory with `restricted`
access, no inherited workspace paths, no network, and only its request/input
plus one output grant. The executable adversarial dry-run fixture places a
credential-named unrelated file beside the workflow and fails unless Relayflow
resolves exactly 1 read + 1 write path for the curator and 2 reads + 1 write
path for the reviewer while denying unrelated paths.

The persona sends `relayflowVersion: 'v1'` in invocation metadata while the
current Cloud request intentionally omits a runtime selector, preserving its v1
default. After Cloud v2 is proven, migration is limited to
`SCHEDULED_DIGEST_VERSION`, the single workflow invocation, and removal of the
documented core-1.0.6 resume compatibility helper. No v2 fallback exists now.

## Independent review iteration 1

The fresh Codex reviewer returned `VERDICT: FINDINGS` on `ff9c34e` with four
items: a sequential-only dedupe test, no exact-state-only recovery after
delivery, overly broad agent workspace access, and resume mutation allowed for
running/all-skipped rows. The next candidate addresses each item with,
respectively, a per-workspace/agent scheduled critical section plus concurrent
stale-snapshot test; a pre-body finalization intent plus no-repost recovery
test; restricted three-artifact/no-network permissions plus an adversarial
permission-compiler test; and failed-only/named-descendant reactivation with
running/completed/wrong-workflow rejection coverage.

The iteration-1 Claude worker returned `BLOCKED` without reviewing because the
broker scheduled it to a Linux node that did not contain the macOS repository.
It is recorded as an infrastructure non-review and is not counted as signoff.
