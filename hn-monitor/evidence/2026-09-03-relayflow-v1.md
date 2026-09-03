# HN Monitor → Relayflow v1 evidence (2026-09-03)

## Scope and durability

The product surface is the deployed `hn-monitor/persona.ts` plus
`hn-monitor/agent.ts`. The implementation preserves the schedule, HN reads,
ranking, channel-scoped seen claim, header/thread delivery, exact Slack state,
semantic memory, durable partial-delivery recovery, and conversational Q&A.
Only scheduled digest curation moved behind a Relayflow v1 workflow.

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

After the path was recreated again, the required absolute-path durability
check found the intact review candidate and no cleanup source:

```text
$ pwd
/Users/khaliqgant/Projects/AgentWorkforce/agents-hn-relayflow-wt
$ git rev-parse --abbrev-ref HEAD
feat/hn-monitor-relayflow-v1-0903
$ git rev-parse HEAD
59b7151aa84c1688817ab3f3ee5be57ef9e71568
$ git worktree list --porcelain
worktree /Users/khaliqgant/Projects/AgentWorkforce/agents-hn-relayflow-wt
HEAD 59b7151aa84c1688817ab3f3ee5be57ef9e71568
branch refs/heads/feat/hn-monitor-relayflow-v1-0903
$ rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' 'git worktree remove|worktree prune|rm -r[fF]?.*(worktree|private/tmp)|/private/tmp|mktemp' .
hn-monitor/evidence/2026-09-03-relayflow-v1.md:... prior evidence text only
```

Only sample Git hooks exist, and the process scan found no worktree remove or
prune command. The subsequent review-fix checkpoint was committed and pushed
as `cadaea5`.

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

The final durability review also began red against the same product delivery
path:

```text
$ npm run test:hn
not ok - critical memory save returning no receipt aborts before any provider effect
not ok - partial multi-target header persists a phase-aware per-provider outbox
```

The first failure proved that `ctx.memory.save()` can resolve without a receipt
and the old path continued to a provider effect. The second proved that a
header-success/body-failure marker could not represent a partial header across
Slack and Telegram.

## Focused product and journal gates

```text
$ npm run test:hn
✔ defineAgent scan schedule invokes the durable Relayflow v1 digest before publishing
...
✔ pinned Relayflow v1 resumes a failed run without replaying completed HN step identities
✔ v1 resume reactivation rejects non-failed runs and touches only named descendants
✔ generated workflow dry run resolves least-privilege artifact grants and denies an unrelated secret
✔ tracked TypeScript generator emits a self-contained Relayflow workflow
✔ production Relayflow budget covers core v1 transient replays and caller overhead
✔ zero configured targets retire a pending outbox before the scheduled scan returns
ℹ tests 49
ℹ pass 49
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
$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npm run evals:hn
(exit 0; every checked-in non-live HN case passed)
```

Representative scheduled trace order:

```text
07. [PREVIEW] files.write workflow source bytes=14470
08. [PREVIEW] compose.run name=hn-monitor-scheduled-digest-v1 relayflowVersion=v1
09-10. [PREVIEW] files.write exact outbox claim → memory.save audit claim
11. [PREVIEW] memory.save tags=["hn-monitor:seen"]
12-13. [PREVIEW] files.write exact outbox headers → memory.save audit headers
14. [PREVIEW] provider.write slack.messages idempotencyKey=...:slack:header
15-18. [PREVIEW] exact + audit-memory header checkpoint → bodies
19. [PREVIEW] provider.write slack.messages idempotencyKey=...:slack:body parentRef=...
20-23. [PREVIEW] exact + audit-memory body checkpoint → state
24-25. [PREVIEW] files.write exact per-thread digest state + rolling index
26. [PREVIEW] memory.save tags=["hn-monitor:post"]
27-28. [PREVIEW] files.write exact cleared outbox → memory.save cleared audit
```

The multi-turn fixture also proves the later Slack Q&A path still performs the
grounded item read, `model.complete`, and in-thread reply.

The live-model case was also invoked explicitly so its final source could not
be inferred from a batch wrapper:

```text
$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH ./node_modules/.bin/agentworkforce invoke ./hn-monitor/agent.ts --case ./hn-monitor/cases/live-model.case.yaml
preview: 1 run(s) — 1 ok, 0 failed
[ok] slack.message.created@1 ... (24 action(s))
policy: reads=fixtures writes=preview model=live shell=simulate compose=preview
```

This machine had no parent-side live model adapter, so the `model.complete`
action was recorded as `denied`/`source=unavailable` and the persona exercised
its grounded fallback answer. The case still proves the final event is Slack,
the schedule is Relayflow compose-previewed, HN item hydration is fixture-backed,
and every provider write is preview-only; it is not evidence of a successful
live model response.

## Live HN read without production writes

The first cold start timed out before readiness at 30 seconds. The same command
with a 60-second readiness allowance completed:

```text
$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=60000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=120000 npm run preview:hn -- --output /Users/khaliqgant/Projects/AgentWorkforce/agents-hn-relayflow-wt/hn-monitor/live-read-final-b9c1d7a.run.json
preview: 1 run(s) — 1 ok, 0 failed
policy: reads=live writes=preview model=stub shell=simulate compose=preview
```

Captured RunRecord summary:

```json
{
  "status": "succeeded",
  "actionCount": 28,
  "liveReads": ["show_hn:current", "front_page:current", "new:current"],
  "workflowSource": {"status":"previewed","path":"workflows/hn-monitor-scheduled-digest-v1.ts","bytes":14470},
  "workflow": {"status":"previewed","name":"hn-monitor-scheduled-digest-v1","version":"v1","batchKey":"hn-monitor:v1:49534948,49536840,49539792,49542723,49546659,49546831,49547372,49547527"},
  "providerWrites": ["slack.messages:previewed", "slack.messages:previewed"],
  "exactOutboxWrites": 7,
  "nonPreviewWrites": 0
}
```

The RunRecord was moved to the recoverable Trash path
`/Users/khaliqgant/.Trash/hn-monitor-live-read-final-b9c1d7a.run.json` after
extracting this evidence. No provider write had status `executed`, and no
deployment was performed.

## Existing deploy surface and packaged handler

```text
$ ./node_modules/.bin/agentworkforce deploy ./hn-monitor/persona.ts --mode cloud --dry-run --no-prompt
persona hn-monitor: 0 integration(s), 1 schedule(s)
--dry-run: persona validated; exiting before any side effects
ok: hn-monitor (dry-run)

$ ./node_modules/.bin/agentworkforce deploy ./hn-monitor/persona.ts --mode cloud --bundle-out ./.hn-bundle-final-b9c1d7a --no-prompt
bundle: staged to .hn-bundle-final-b9c1d7a/runner.mjs (708.4KB)
--bundle-out: bundle ready at .hn-bundle-final-b9c1d7a; skipping launch

$ node scripts/acceptance/hn-relayflow-bundle-smoke.mjs ./.hn-bundle-final-b9c1d7a
{"workflow":"hn-monitor-scheduled-digest-v1","version":"v1","sourceBytes":14470,"posts":2,"stateSaves":9,"emittedSourceDryRun":true}
```

The bundle smoke invokes `postFreshStories` from the emitted
`agent.bundle.mjs`, runs the bundled scheduled product entrypoint with a
deterministic HN fixture, proves the handler materializes a self-contained core
workflow before `ctx.workflow.run`, consumes a validated result, publishes the
same header/thread pair through the production digest-delivery seam with stable
keys, and completes the seen/outbox/exact-state transition.
The inspected bundle was then moved to the recoverable Trash path
`/Users/khaliqgant/.Trash/hn-bundle-final-b9c1d7a`.

## Repository regression result

```text
$ npm test
ℹ tests 351
ℹ pass 349
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
access, no inherited workspace paths, a `network: false` declaration, and only
its request/input plus one output grant. The hosting runtime remains responsible
for enforcing that compiled network policy. The executable adversarial dry-run fixture places a
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

## Independent review iteration 2

The fresh Codex reviewer returned `VERDICT: FINDINGS` on `88ed107` with one
high-severity compound-failure gap: failure to save the pre-body exact-state
recovery intent was logged and ignored, so a following successful body effect
plus exact-state failure could not be repaired. The executable test was added
first and failed as expected:

```text
$ npm run test:hn
not ok 14 - durable recovery-intent failure prevents body delivery before exact-state persistence can also fail
error: Slack digest posted, but deterministic HN grounding state could not be persisted
tests 37; pass 36; fail 1
```

The remediation makes that intent a hard pre-body durability gate and applies
the same gate when retrying a previously queued body. The focused regression
asserts the body is not sent and exact state is not attempted under the compound
failure; a second regression asserts the recovery path also performs no
provider effect until the intent succeeds.

The fresh Claude reviewer independently found a second high-severity issue on
the same candidate: pinned core v1 journals `workflow(publicName)` as
`${publicName}-workflow`, while the product resume guard compared the public
name. A production-name contract was added against the installed
`@relayflows/core` builder before the source change and failed because the new
contract export did not yet exist. The source now derives the journal name in
one explicit v1 helper, embeds that helper in the uploaded workflow, and the
mock journal uses the real suffixed name. The separate actual-core resume test
continues to prove completed steps are not replayed.

## Post-merge follow-up validation

PR #126 was merged externally at `cec97c5` while this required review/fix loop
was still active. This worker did not merge or deploy. The review remediations
remain isolated as a narrow follow-up diff on the required feature branch.

Automated review also identified an under-budgeted retry path and a bundle
smoke that captured but did not execute the emitted workflow source. The
workflow makes the supported retry path explicit: deterministic prepare and
both agent steps get one nominal attempt; the final validator gets one
reviewer-assisted repair and retry. The bundle smoke writes the exact source captured from `agent.bundle.mjs` into
a workspace-local scratch directory, runs its real Relayflow dry-run, checks
the journaled workflow name, and removes the scratch directory.

## Independent review iteration 3

A fresh Claude reviewer passed `59b7151` with no findings. A fresh Codex
reviewer found two high-severity delivery gaps plus timeout and evidence issues:
critical memory writes failed open on a receiptless success; a single marker
could not distinguish pre-effect from post-effect worker death or partial
Slack/Telegram progress; core v1.0.6 transient same-attempt replays were not
included in the timeout; and the live-model final event source was incorrectly
pinned to cron.

The remediation introduces one durable `claim → headers → bodies → state`
outbox, independent per-provider status, stable batch/provider/phase operation
keys on the real provider drafts, receipt-checked critical memory writes,
`failOnError: true` critical recalls, strict outbox validation, state-only
recovery after delivery, and an upgrade bridge for the old pending markers.
Slack uses its writeback idempotency key; Telegram reuses a deterministic
Relayfile item path because the Bot API has no native idempotency key.
The worst supported Relayflow path is now budgeted at about 451 seconds with a
480-second workflow timeout, 510-second completion wait, and 600-second persona
harness timeout. The live-model final source is explicitly Slack.

Iteration 3 input-candidate results (`59b7151`, before the findings above were
remediated):

```text
$ npm run test:hn
tests 39; pass 39; fail 0

$ npm run typecheck
> tsc --noEmit
(exit 0)

$ node scripts/test.mjs tests/hn-monitor-cases.test.mjs
tests 14; pass 14; fail 0

$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npm run evals:hn
all platform cases: 1 run(s) — 1 ok, 0 failed per case
(exit 0)

$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npm run preview:hn -- --output .../live-read-i3.run.json
policy: reads=live writes=preview model=stub shell=simulate compose=preview
fidelity: state=simulated inputs=current http=current model=simulated
3 current HN feed reads; 1 run — 1 ok, 0 failed

$ node scripts/acceptance/hn-relayflow-bundle-smoke.mjs ./.hn-bundle-review-i4
{"workflow":"hn-monitor-scheduled-digest-v1","version":"v1","sourceBytes":14435,"posts":2,"stateSaves":4,"emittedSourceDryRun":true}

$ npm test
tests 342; pass 340; fail 2
both failures: ENOENT .../workforce/packages/harness-kit/package.json
```

After the iteration-3 delivery, timeout, and source-closure remediations added
five focused cases, the later candidate produced:

```text
$ npm run test:hn
tests 44; pass 44; fail 0

$ npm run typecheck
> tsc --noEmit
(exit 0)
```

The live run record and bundle were moved to explicit Trash paths after
inspection; no production provider or state write was made.

## Independent review iteration 4 preflight

A final executable source-closure test was added after a literal standalone
materialization exposed a deployment-toolchain boundary:

```text
$ npm run test:hn
✖ tracked TypeScript generator emits a self-contained Relayflow workflow
ReferenceError: __name is not defined
tests 45; pass 44; fail 1
```

`tsx` can insert esbuild's `__name` calls into serialized function bodies. The
generator now carries that no-op naming helper into the new uploaded module.
The test was not weakened; its exact TypeScript materialize-then-execute path
now passes.

```text
$ npm run test:hn
tests 45; pass 45; fail 0

$ npm run typecheck
> tsc --noEmit
(exit 0)

$ node scripts/test.mjs tests/hn-monitor-cases.test.mjs
tests 14; pass 14; fail 0

$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npm run evals:hn
all platform cases: 1 run(s) — 1 ok, 0 failed per case
(exit 0)

$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=60000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=120000 npm run preview:hn -- --output .../live-read-final-091be58.run.json
policy: reads=live writes=preview model=stub shell=simulate compose=preview
fidelity: state=simulated inputs=current http=current model=simulated
3 current HN feed reads; 1 run — 1 ok, 0 failed

$ node scripts/acceptance/hn-relayflow-bundle-smoke.mjs ./.hn-bundle-final-091be58
{"workflow":"hn-monitor-scheduled-digest-v1","version":"v1","sourceBytes":14470,"posts":2,"stateSaves":9,"emittedSourceDryRun":true}

$ npm test
tests 347; pass 345; fail 2
both failures: ENOENT .../workforce/packages/harness-kit/package.json
```

`git diff --check` and an added-line credential-pattern scan passed. `npm
audit --omit=dev --audit-level=high` reports the repository's existing
transitive audit baseline (17 findings: 1 critical, 3 high, 13 moderate); this
HN-only diff changes no dependency manifest or lockfile. The required Veto MCP
tools were not exposed in this session, so the mandated Veto diff-review call
could not be run; fresh independent review and the local scans are used below,
and that tooling limitation is not represented as a pass.

While the final PR was being prepared, upstream PR #131 moved the materializer
and source generator under `hn-monitor/workflows/`. The branch merged that
change instead of duplicating the old top-level layout. The executable tracked
source test then failed red on its stale import (`MODULE_NOT_FOUND`), was updated
to the persona-local path, and returned to 45/45. Deterministic E2E, live HN
read/preview-only delivery, deploy dry-run, and emitted-bundle/source smoke were
rerun on merge-clean checkpoint `091be58`; PR #132 reports mergeable.

## Automated PR findings and final review preflight

Automated PR review found that `runScheduledScan` returned immediately when no
delivery targets were configured. If an earlier run had left a pending outbox,
temporarily removing all targets therefore prevented the outbox from being
retired; re-enabling a provider later could publish the stale digest. The
product-path regression was added first and failed:

```text
$ npm run test:hn
✖ zero configured targets retire a pending outbox before the scheduled scan returns
tests 46; pass 45; fail 1
```

The scheduled critical section now performs pending-outbox recovery before the
zero-target return. Recovery marks removed providers omitted and clears the
outbox without a provider effect. The unchanged regression then passed:

```text
$ npm run test:hn
tests 46; pass 46; fail 0

$ npm run typecheck
> tsc --noEmit
(exit 0)

$ node scripts/test.mjs tests/hn-monitor-cases.test.mjs
tests 14; pass 14; fail 0
```

The first deterministic E2E attempt used the default five-second local-preview
readiness timeout and failed while the worker was cold under concurrent machine
load. The same exact code completed with the documented readiness allowance:

```text
$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=60000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=120000 npm run evals:hn
(exit 0; every checked-in non-live HN case passed)
```

The final current-HN preview on `65506ed` made three live GETs and kept the
workflow, exact-state files, and both Slack messages in preview status. The
deploy dry-run again reported zero integrations and one schedule, then exited
before side effects. The emitted bundle executed the exact captured workflow
source and reported:

```text
{"workflow":"hn-monitor-scheduled-digest-v1","version":"v1","sourceBytes":14470,"posts":2,"stateSaves":9,"emittedSourceDryRun":true}
```

The repository-wide result on the same code is:

```text
$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH npm test
tests 348; pass 346; fail 2
```

The next automated sweep found three more executable issues: semantic memory
recall has no newest-first or completeness guarantee, so an omitted cleared
marker could expose an older active outbox; writeback `receipt.created` metadata
could be mistaken for a Slack timestamp or Telegram message id; and a removed,
already-settled provider caused an unchanged outbox checkpoint on every
state-only retry. Tests were added first and failed together:

```text
$ npm run test:hn
✖ provider receipt creation metadata is not used as the delivered message identity
✖ an exact cleared outbox prevents replay when bounded memory recall returns an older checkpoint
✖ removed delivered providers do not append unchanged outbox checkpoints during state-only retry
tests 49; pass 46; fail 3
```

The repair makes a workspace/agent-sharded exact Relayfile the current outbox
pointer and keeps semantic memory only as receipt-checked audit history. Each
exact checkpoint precedes its audit entry, and clearing the exact pointer
precedes the cleared audit entry. Provider identity ignores `created`, and the
configuration-change flag is set only when a pending status actually changes.
The unchanged tests then passed:

```text
$ npm run test:hn
tests 49; pass 49; fail 0

$ npm run typecheck
> tsc --noEmit
(exit 0)

$ node scripts/test.mjs tests/hn-monitor-cases.test.mjs
tests 14; pass 14; fail 0

$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=60000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=120000 npm run evals:hn
(exit 0; every checked-in non-live HN case passed)

$ PATH=/opt/homebrew/Cellar/node/26.5.0/bin:$PATH WF_LOCAL_PREVIEW_READY_TIMEOUT_MS=60000 WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS=120000 npm run preview:hn -- --output .../live-read-final-b9c1d7a.run.json
1 run ok; 3 current HN reads; 28 actions; 7 exact outbox writes; 0 non-preview writes

$ node scripts/acceptance/hn-relayflow-bundle-smoke.mjs ./.hn-bundle-final-b9c1d7a
{"workflow":"hn-monitor-scheduled-digest-v1","version":"v1","sourceBytes":14470,"posts":2,"stateSaves":9,"emittedSourceDryRun":true}

$ npm test
tests 351; pass 349; fail 2
```

The two repository-wide failures remain only the absent sibling-package
prerequisites listed above. Code checkpoint
`b9c1d7a4cdf9ddf86276297557fac00d52328323` contains these repairs. A final
documentation checkpoint follows so fresh Claude and Codex reviewers can
inspect one exact code-and-evidence SHA.
