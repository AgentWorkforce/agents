/**
 * pr-reviewer handler — review, auto-fix, and shepherd a PR to the finish line.
 *
 *   an authorized approval (pull_request_review.submitted) → merge the PR.
 *   a check run that finished green (check_run.completed)   → nothing to do.
 *   anything else — opened, new commits (synchronize), a
 *   review comment, failed CI, changes requested            → (re)review and fix.
 *
 * The PR's repo is materialized into ctx.sandbox.cwd by cloud before the
 * harness runs. The agent fixes by editing files there; cloud commits and
 * pushes those edits after the harness exits — no git/gh in the harness.
 *
 * Slack policy: the channel only hears about a PR when it's a human's turn —
 * checks green, every bot/reviewer comment resolved, nothing left for the agent
 * to fix (the agent's READY sentinel). In-progress passes stay silent. The only
 * other pings are operator/terminal signals: a failed harness run and a merge.
 */
import {
  defineAgent,
  encodeSegment,
  readJsonFile,
  resolveMountRoot,
  type IntegrationClientOptions,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { githubClient, slackClient } from '@relayfile/relay-helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Pr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  author: string; // github login of whoever opened the PR
  headSha?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  labels?: unknown;
}

/** The materialized PR record at `…/pulls/{n}/meta.json`. Read for the
 *  authoritative author/labels/state — the webhook payload doesn't carry them
 *  on every trigger (check_run.completed has neither). Read defensively: the
 *  shape is the github adapter's projection and fields may be absent. */
interface PrMeta {
  state?: string; // 'open' | 'closed'
  merged?: boolean;
  draft?: boolean; // a held PR — the author isn't asking for review yet
  // The materialized meta.json has carried `author` both as a bare login
  // string and as an object — accept either so the allowlist isn't silently
  // bypassed by a shape mismatch.
  author?: string | { login?: string };
  labels?: unknown; // validated as Array<{ name?: string }> at read time
  [key: string]: unknown;
}

const DEFAULT_SKIP_LABEL = 'no-agent-relay-review';
const SLACK_THREAD_TAG = 'pr-reviewer:slack-thread';

function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

export default defineAgent({
  // Re-review on every PR change (open, new commits, review comments, finished
  // CI), and merge when you approve. Every `on` value autocompletes from
  // github's catalog (see relayfile-adapters DEFAULT_SUPPORTED_EVENTS).
  triggers: {
    github: [
      { on: 'pull_request.opened' },
      { on: 'pull_request_review.submitted' },
      { on: 'pull_request_review_comment.created' },
      { on: 'check_run.completed' },
      { on: 'pull_request.synchronize' }
    ]
  },
  handler: async (ctx, event) => {
  // `event` is narrowed to the declared github.* triggers. The provider
  // payload is reached via expand (no synchronous `event.payload` in v4).
  const data = (await event.expand('full')).data;

  // An approval from an authorized reviewer ends the loop: merge and stop.
  if (event.type === 'github.pull_request_review.submitted' && isApproval(data) && isAuthorizedApprover(ctx, data)) {
    const pr = readPr(data);
    if (pr) await mergePr(ctx, pr);
    return;
  }

  // A check run that finished without failing needs no action.
  if (event.type === 'github.check_run.completed' && !ciFailed(data)) return;

  // Everything else is a reason to (re)review and push fixes.
  const pr = readPr(data);
  if (pr) {
    const skip = await shouldSkipReview(ctx, pr);
    if (skip) {
      ctx.log?.('info', 'pr-reviewer skipped', { owner: pr.owner, repo: pr.repo, number: pr.number, reason: skip.reason });
      return;
    }
    await reviewAndFix(ctx, pr);
  } else if (event.type === 'github.check_run.completed') {
    // GitHub sometimes emits check_run.completed with pull_requests: [] for
    // fork PRs and org-level checks; surface so a "silent no-op" isn't
    // mistaken for "PR review skipped on purpose".
    ctx.log?.('info', 'check_run.completed with no associated PR; skipping', { eventId: event.id });
  }
  }
});

// ── review gate ─────────────────────────────────────────────────────────────
// Decide whether to (re)review/fix this PR at all. Returns a skip reason, or
// null to proceed. Three gates, in order: already-merged, a disabling label,
// and an author allowlist. Prefer the live PR meta.json, but fall back to
// fields that are present on pull_request webhook payloads; check_run.completed
// payloads do not carry enough detail, so those fail open when meta is missing.
async function shouldSkipReview(ctx: WorkforceCtx, pr: Pr): Promise<{ reason: string } | null> {
  const meta = await loadPrMeta(pr);

  // Already merged/closed by the time we got here — don't post a stale review
  // on a finished PR. This is the cheap, agent-side half of the merge-race;
  // preserving the unpushed fixes via a recovery PR needs the cloud-side work
  // tracked in AgentWorkforce/cloud#1659 / #1660.
  const state = (meta?.state ?? pr.state ?? '').trim().toLowerCase();
  if (meta?.merged === true || pr.merged === true || state === 'closed') {
    return { reason: 'PR is already merged/closed' };
  }

  // A draft PR is held by its author — they aren't asking for review yet, and an
  // auto-push into a work-in-progress branch is unwanted. Gate on it
  // PREEMPTIVELY: the draft flag is set the instant the PR is opened as a draft,
  // so it closes the window the skip label misses (a label has to be applied by
  // hand, and the bot can fire before it lands). Read both the authoritative
  // meta.json and the webhook payload's draft flag; mark-ready-for-review fires
  // a `pull_request.synchronize`/`ready_for_review` event that re-opens the gate.
  if (meta?.draft === true || pr.draft === true) {
    return { reason: 'PR is a draft' };
  }

  // A disabling label turns the reviewer off entirely for this PR. `labels` is
  // validated here (not just type-asserted) since meta.json shape can drift.
  const skipLabels = skipLabelSet(ctx);
  const prLabels = labelNames(Array.isArray(meta?.labels) ? meta.labels : pr.labels);
  const hit = prLabels.find((name) => skipLabels.has(name));
  if (hit) {
    return { reason: `PR carries the "${hit}" label` };
  }

  // Author allowlist: when REVIEW_AUTHORS is set, only review/fix PRs opened by
  // those logins (e.g. "only my own PRs"). Unset → review every author.
  // Fail closed when configured: if the author can't be resolved confidently,
  // skip instead of risking a review on the wrong PR author.
  const allow = reviewAuthorAllowlist(ctx);
  const author = resolveAuthorLogin(meta, pr);
  const allowlistSkip = reviewAuthorAllowlistDecision(allow, author);
  if (allowlistSkip) {
    return allowlistSkip;
  }

  return null;
}

/** Lowercased PR author login, preferring the authoritative meta.json (string
 *  or `{ login }`) and falling back to the webhook payload. Returns '' when no
 *  login can be determined. */
export function resolveAuthorLogin(meta: PrMeta | undefined, pr: Pr): string {
  const fromMeta = typeof meta?.author === 'string' ? meta.author : meta?.author?.login;
  return (fromMeta ?? pr.author ?? '').trim().toLowerCase();
}

async function loadPrMeta(pr: Pr): Promise<PrMeta | undefined> {
  try {
    return await readJsonFile<PrMeta>(
      vfsClient(),
      'github',
      'getPr',
      `/github/repos/${encodeSegment(pr.owner)}/${encodeSegment(pr.repo)}/pulls/${pr.number}/meta.json`
    );
  } catch {
    return undefined;
  }
}

/** Lowercased label names that disable the reviewer. Defaults to
 *  "no-agent-relay-review" when SKIP_LABELS is unset. */
function skipLabelSet(ctx: WorkforceCtx): Set<string> {
  const raw = input(ctx, 'SKIP_LABELS') ?? DEFAULT_SKIP_LABEL;
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Lowercased github logins allowed to be reviewed/fixed. Empty = everyone. */
function reviewAuthorAllowlist(ctx: WorkforceCtx): Set<string> {
  const raw = input(ctx, 'REVIEW_AUTHORS') ?? '';
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function reviewAuthorAllowlistDecision(
  allow: Set<string>,
  author: string
): { reason: string; notify?: boolean } | null {
  if (allow.size === 0) {
    return null;
  }
  if (!author || author === 'unknown') {
    return { reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved', notify: true };
  }
  if (!allow.has(author)) {
    return { reason: `author @${author} is not in REVIEW_AUTHORS` };
  }
  return null;
}

export function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (l && typeof (l as { name?: unknown }).name === 'string' ? (l as { name: string }).name.trim().toLowerCase() : ''))
    .filter(Boolean);
}

async function reviewAndFix(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: reviewHarnessPrompt(pr)
  });

  const exitCode = (run as { exitCode?: unknown }).exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    await failReviewRun(ctx, pr, `The review harness exited with code ${exitCode}.`);
  }

  // The harness only writes a review when we explicitly post it. Strip the
  // READY sentinel (it's the slack/ready signal, not a review-body line) and
  // post whatever's left as a PR comment via the github VFS.
  const raw = (run.output ?? '').trimEnd();
  const harnessReady = lastLine(raw) === 'READY';
  const body = harnessReady ? stripLastLine(raw).trimEnd() : raw;
  if (!body) {
    await failReviewRun(ctx, pr, 'The review harness produced no review output.');
  }
  if (body) {
    await githubClient().comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, body);
  }
  const ready = harnessReady ? await verifyReadyForHumanReview(ctx, pr) : false;

  // Only ping Slack when the PR is actually a human's turn: checks green, all
  // bot/reviewer comments resolved, nothing left for the agent to fix (the
  // READY sentinel). Every in-progress pass — opened, new commits, failing CI,
  // unresolved bot threads — stays silent so the channel isn't a play-by-play.
  if (ready) {
    await announceReadyOnce(ctx, pr);
  }
}

// Announce "ready for your review" at most once per head commit. Re-reviews
// fire on many webhooks (a later check completing, a new bot comment) and the
// PR is no more "ready" than the last time we said so — re-announcing is the
// duplicate-reminder noise. A genuinely new head SHA (fresh commits that pass)
// is worth a new note, and postSlackPrUpdate threads it under the PR's first
// message so the channel stays a single conversation per PR.
const READY_ANNOUNCED_TAG = 'pr-reviewer:ready-announced';

export async function announceReadyOnce(ctx: WorkforceCtx, pr: Pr, client?: SlackThreadClient): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) return;
  const reservation = pr.headSha ? await reserveReadyAnnouncement(ctx, pr) : undefined;
  if (pr.headSha && !reservation) return;
  const who = `<https://github.com/${pr.author}|@${pr.author}>`; // the PR opener
  try {
    await postSlackPrUpdate(
      ctx,
      pr,
      `:white_check_mark: ${who} — PR #${pr.number} in *${pr.owner}/${pr.repo}* is ready for your review: ${pr.url}`,
      client
    );
  } catch (error) {
    if (pr.headSha && reservation && 'id' in reservation && typeof reservation.id === 'string') {
      await forgetReadyAnnouncementReservation(ctx, pr, reservation.id, 'failed');
    }
    throw error;
  }
  if (pr.headSha) await rememberReadyAnnounced(ctx, pr);
}

function readyAnnouncedTags(pr: Pr): string[] {
  return [
    READY_ANNOUNCED_TAG,
    `pr:${pr.owner}/${pr.repo}#${pr.number}`,
    ...(pr.headSha ? [`head:${pr.headSha}`] : []),
  ];
}

async function alreadyAnnouncedReady(ctx: WorkforceCtx, pr: Pr): Promise<boolean> {
  return (await readyAnnouncementItems(ctx, pr, 'announced')).length > 0;
}

async function reserveReadyAnnouncement(ctx: WorkforceCtx, pr: Pr): Promise<{ id: string } | {} | undefined> {
  if (await alreadyAnnouncedReady(ctx, pr)) return undefined;
  const saved = await rememberReadyAnnouncementReservation(ctx, pr);
  if (!saved?.id) return {};
  const [winner] = await readyAnnouncementItems(ctx, pr, 'reservation');
  if (!winner || winner.id === saved.id) return saved;
  await forgetReadyAnnouncementReservation(ctx, pr, saved.id, 'cancelled');
  return undefined;
}

async function readyAnnouncementItems(ctx: WorkforceCtx, pr: Pr, kind: 'announced' | 'reservation') {
  const items = await ctx.memory.recall(`pr-reviewer ready announced for ${pr.owner}/${pr.repo}#${pr.number}`, {
    scope: 'workspace',
    tags: readyAnnouncedTags(pr),
    limit: 100,
  });
  const parsed = items.flatMap((item) => {
    try {
      const content = JSON.parse(item.content) as { headSha?: string; kind?: string; reservationId?: string };
      return content.headSha === pr.headSha ? [{ item, content }] : [];
    } catch {
      return [];
    }
  });
  const inactiveReservationIds = new Set(
    parsed
      .filter(({ content }) => content.kind === 'failed' || content.kind === 'cancelled')
      .map(({ content }) => content.reservationId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  return parsed
    .filter(({ item, content }) => {
      try {
        return content.kind === kind && !inactiveReservationIds.has(item.id);
      } catch {
        return false;
      }
    })
    .map(({ item }) => item)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

async function rememberReadyAnnounced(ctx: WorkforceCtx, pr: Pr): Promise<{ id: string } | void> {
  return await saveReadyAnnouncementMarker(ctx, pr, 'announced');
}

async function rememberReadyAnnouncementReservation(ctx: WorkforceCtx, pr: Pr): Promise<{ id: string } | void> {
  return await saveReadyAnnouncementMarker(ctx, pr, 'reservation');
}

async function forgetReadyAnnouncementReservation(
  ctx: WorkforceCtx,
  pr: Pr,
  reservationId: string,
  kind: 'failed' | 'cancelled'
): Promise<{ id: string } | void> {
  return await saveReadyAnnouncementMarker(ctx, pr, kind, reservationId);
}

async function saveReadyAnnouncementMarker(
  ctx: WorkforceCtx,
  pr: Pr,
  kind: 'announced' | 'reservation' | 'failed' | 'cancelled',
  reservationId?: string
): Promise<{ id: string } | void> {
  return await ctx.memory.save(JSON.stringify({ headSha: pr.headSha, kind, ...(reservationId ? { reservationId } : {}) }), {
    scope: 'workspace',
    tags: readyAnnouncedTags(pr),
  });
}

export function reviewHarnessPrompt(pr: { owner: string; repo: string; number: number }): string {
  return [
    `Review pull request #${pr.number} in ${pr.owner}/${pr.repo}. The PR code is checked out in the current directory.`,
    `Focus on the actual PR changes: read .workforce/pr.diff first, then .workforce/changed-files.txt and .workforce/context.json.`,
    `Use the checked-out repo to trace the impact of this diff across callers, types, tests, config, and related files.`,
    `Flag and fix breakage even when the affected file is outside the changed-file set, but do not do an unrelated full-repo audit.`,
    `Then proactively FIX everything that needs changing — your own findings and any other bot reviews on the PR —`,
    `and resolve failing CI checks and merge conflicts by editing the code. Don't use git or the gh CLI; cloud commits`,
    `and pushes your file edits to the PR after this run. In your output, do not claim that fixes were pushed,`,
    `a GitHub review was submitted, or CI was verified; those are post-harness actions that cloud reports separately.`,
    `Validate every finding — yours or another bot's — against the CURRENT checkout before editing: review comments`,
    `are often stale (already fixed by a later push). Reproduce the problem in the code as it is now, or skip it.`,
    `Make the smallest fix that addresses a demonstrated problem. Do not rewrite, restructure, or "harden" working`,
    `code beyond what the finding requires.`,
    `Stay within this PR's purpose (.workforce/pr.diff is the change; use .workforce/context.json for available PR`,
    `metadata). A reviewer suggestion that changes files or behavior unrelated to`,
    `that purpose — refactoring a module`,
    `the PR doesn't touch, renaming resources in an adapter the PR never edits, a cross-cutting "while you're here"`,
    `cleanup — does NOT belong in this PR: record it as an advisory note under a "## Advisory Notes" heading in your review and leave the code unchanged.`,
    `Folding an unrelated change into the PR is how you break an unrelated package's build; when in doubt, scope out.`,
    `Account for every bot and reviewer comment explicitly in your output under an "## Addressed comments" heading:`,
    `one bullet per comment naming the bot/reviewer and what they raised, followed by either the file:line where you`,
    `fixed it (e.g. "fixed in src/foo.ts:42") or, if you did not change anything, a one-line reason (stale —`,
    `already handled by a later commit, or invalid because <reason>). This is how the comment authors and the human`,
    `see that each thread was handled and exactly where, so be specific with the path and line; do not say a comment`,
    `was addressed without pointing to the fix.`,
    `Verify every edit before you finish, and verify it the way CI does — not just the unit test next to the file.`,
    `Run the repo's canonical build and test command end to end (read package.json / turbo.json / the CI workflow to`,
    `find what CI actually runs, focusing only on build/test/typecheck steps; install dependencies if needed) so you catch breakage DOWNSTREAM of the file you`,
    `edited. In a monorepo, editing one source file can break a generated/committed artifact (a catalog, lockfile,`,
    `snapshot, or generated types) or a different package that imports it: when a finding makes you touch a source`,
    `that feeds a generated file, regenerate that file with the repo's own generator and rebuild the packages that`,
    `consume it. A green "tests for the file I touched" while the full build/test is red is exactly the failure that`,
    `ships — the working tree must pass the full command with your edits in place. When you change code that`,
    `GENERATES commands, scripts, or queries, also execute a sample of the generated output against a throwaway`,
    `fixture — tests that only assert on the generated string prove nothing about its behavior.`,
    `Never make a check pass by weakening the test: do not delete it, skip it, loosen an assertion, narrow its`,
    `inputs, or replace a real assertion with a trivially-true one. A test that no longer fails when the behavior it`,
    `guards regresses is worse than no test, and it passes CI while hiding the bug. When an edit makes a test fail,`,
    `fix the CODE; only change a test's EXPECTATION when the test encoded the OLD, now-intentionally-changed contract`,
    `and the new expected value is demonstrably correct — and say which in your "## Addressed comments" notes. If you`,
    `cannot make a test genuinely pass, leave the code unfixed and raise it as advisory rather than gutting the test.`,
    `If you cannot verify an edit (tests cannot run in this sandbox and you cannot make them run), do not leave it`,
    `in the working tree: discard it with "git restore <file>" — the one exception to the no-git rule, because`,
    `rewriting a file back from memory is error-prone — delete files you created, and present the proposed change as`,
    `advisory text in your review instead. Anything left in the working tree is committed and pushed to the PR after`,
    `you exit — an unverified push is worse than no push.`,
    `Only end your output with READY on its own last line when the PR genuinely needs a human now — meaning you have`,
    `resolved or addressed every bot and reviewer comment, every required CI check has completed (none are pending`,
    `or in-progress) and all are passing, the PR has no merge conflicts (GitHub reports it as mergeable), and the`,
    `remaining decision requires human judgment. If any check is still pending, in-progress, or failed, or if the PR`,
    `has merge conflicts, do NOT print READY.`
  ].join('\n');
}

async function verifyReadyForHumanReview(ctx: WorkforceCtx, pr: Pr): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr',
      'view',
      String(pr.number),
      '--repo',
      `${pr.owner}/${pr.repo}`,
      '--json',
      'state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid',
    ], { cwd: ctx.sandbox.cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const state = parsePrReadyState(stdout);
    // Populate the head SHA from GitHub's authoritative current head. Some
    // webhook payloads (e.g. check_run.completed) don't carry it, and without a
    // SHA the ready-announce dedupe can't key on the commit and would re-ping.
    if (typeof state.headRefOid === 'string' && state.headRefOid.trim()) {
      pr.headSha = state.headRefOid.trim();
    }
    const ready = prReadyStateAllowsHumanReview(state);
    if (!ready) {
      ctx.log?.('warn', 'pr-reviewer.ready-sentinel.downgraded', {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        reason: describeNotReadyState(state),
      });
    }
    return ready;
  } catch (error) {
    ctx.log?.('warn', 'pr-reviewer.ready-sentinel.verification-failed', {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

interface PullRequestReadyState {
  state?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  reviewDecision?: unknown;
  statusCheckRollup?: unknown;
  headRefOid?: unknown;
}

function parsePrReadyState(stdout: string): PullRequestReadyState {
  const parsed = JSON.parse(stdout) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as PullRequestReadyState : {};
}

/** Whether the PR is still open. A missing `state` is treated as open so the
 *  check stays backward-compatible with callers that don't query it; only an
 *  explicit non-OPEN value (MERGED/CLOSED) blocks the ready ping. */
function prIsOpen(state: PullRequestReadyState): boolean {
  const s = normalizeState(state.state);
  return s === undefined || s === 'OPEN';
}

export function prReadyStateAllowsHumanReview(state: PullRequestReadyState): boolean {
  // Never announce "ready for review" on a PR that merged or closed between the
  // harness run and this check — that's the stale "ready" ping on a done PR.
  if (!prIsOpen(state)) return false;
  // A draft PR isn't up for review yet.
  if (normalizeState(state.mergeStateStatus) === 'DRAFT') return false;
  // No merge conflicts.
  if (state.mergeable !== 'MERGEABLE') return false;
  // A reviewer or bot still asking for changes means it isn't the human's turn.
  if (normalizeState(state.reviewDecision) === 'CHANGES_REQUESTED') return false;
  // Checks must all be complete and passing. An *empty* rollup is ambiguous: it
  // can mean "no CI configured" (fine to proceed) or "checks queued but not yet
  // registered" (still pending — the original bug where `every` passed
  // vacuously). Disambiguate with GitHub's own mergeStateStatus: only an empty
  // rollup on a CLEAN PR (nothing blocking) counts as ready; a transient
  // pre-registration window reports UNSTABLE/BLOCKED/UNKNOWN, not CLEAN.
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (checks.length === 0) return normalizeState(state.mergeStateStatus) === 'CLEAN';
  return checks.every(checkPassedAndComplete);
}

// A check that's complete and not blocking. SUCCESS and NEUTRAL pass; SKIPPED
// passes too — a conditionally-skipped job is GitHub's "not applicable", not a
// failure, and must not pin the PR out of "ready" forever (it also mirrors the
// trigger's ciFailed(), which treats skipped as non-failing).
function checkPassedAndComplete(check: unknown): boolean {
  if (!check || typeof check !== 'object') return false;
  const record = check as Record<string, unknown>;
  const state = normalizeState(record.state);
  if (state) return state === 'SUCCESS' || state === 'NEUTRAL' || state === 'SKIPPED';
  const status = normalizeState(record.status);
  const conclusion = normalizeState(record.conclusion);
  return status === 'COMPLETED' && (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED');
}

function normalizeState(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim().toUpperCase() : undefined;
}

function describeNotReadyState(state: PullRequestReadyState): string {
  if (!prIsOpen(state)) {
    return `state=${String(state.state ?? 'missing')}`;
  }
  if (normalizeState(state.mergeStateStatus) === 'DRAFT') {
    return 'mergeStateStatus=DRAFT';
  }
  if (state.mergeable !== 'MERGEABLE') {
    return `mergeable=${String(state.mergeable ?? 'missing')}`;
  }
  if (normalizeState(state.reviewDecision) === 'CHANGES_REQUESTED') {
    return 'reviewDecision=CHANGES_REQUESTED';
  }
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (checks.length === 0) {
    return `no status checks reported and mergeStateStatus=${String(state.mergeStateStatus ?? 'missing')} (not CLEAN)`;
  }
  const blocked = checks.find((check) => !checkPassedAndComplete(check));
  if (!blocked || typeof blocked !== 'object') {
    return 'statusCheckRollup contains a non-passing check';
  }
  const record = blocked as Record<string, unknown>;
  const name = record.name ?? record.context ?? record.workflowName ?? 'unknown';
  const stateText = record.state ?? record.status ?? 'missing';
  const conclusionText = record.conclusion ?? 'missing';
  return `check=${String(name)} state=${String(stateText)} conclusion=${String(conclusionText)}`;
}

async function failReviewRun(ctx: WorkforceCtx, pr: Pr, reason: string): Promise<never> {
  const message = [
    `pr-reviewer could not complete review for #${pr.number} in ${pr.owner}/${pr.repo}.`,
    reason,
    'No review was posted; this needs operator attention.',
  ].join('\n');
  ctx.log?.('error', 'pr-reviewer harness failed', {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    reason,
  });
  await githubClient().comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, message);
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (channel) {
    await postSlackPrUpdate(
      ctx,
      pr,
      `:warning: pr-reviewer failed for PR #${pr.number} in *${pr.owner}/${pr.repo}*: ${reason}`
    );
  }
  throw new Error(message);
}

async function mergePr(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  const result = await githubClient().mergePullRequest({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    method: 'squash',
    ...(pr.headSha ? { sha: pr.headSha } : {})
  });
  // mergePullRequest surfaces the writeback worker's merge outcome as `merged`.
  // A false/unconfirmed result means we shouldn't pretend the merge landed.
  if (!result.merged) {
    throw new Error(`GitHub did not confirm PR #${pr.number} in ${pr.owner}/${pr.repo} was merged.`);
  }
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (channel) {
    await postSlackPrUpdate(ctx, pr, `:tada: Merged PR #${pr.number} in ${pr.owner}/${pr.repo}.`);
  }
}

interface SlackThreadMemory {
  channel: string;
  threadTs: string;
}

interface SlackThreadClient {
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  reply(channel: string, threadTs: string, text: string): Promise<{ channel: string; ts: string }>;
}

export async function postSlackPrUpdate(
  ctx: WorkforceCtx,
  pr: Pr,
  text: string,
  client: SlackThreadClient = slackClient({ writebackTimeoutMs: 15_000 })
): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) return;

  const remembered = await recallSlackThread(ctx, pr, channel);
  if (remembered) {
    await client.reply(channel, remembered.threadTs, text);
    return;
  }

  const posted = await client.post(channel, text);
  if (posted.ts) {
    await rememberSlackThread(ctx, pr, { channel, threadTs: posted.ts });
  } else {
    ctx.log?.('warn', 'pr-reviewer.slack-thread.no-receipt', {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      channel,
    });
  }
}

async function recallSlackThread(ctx: WorkforceCtx, pr: Pr, channel: string): Promise<SlackThreadMemory | undefined> {
  const [item] = await ctx.memory.recall(slackThreadQuery(pr, channel), {
    scope: 'workspace',
    tags: slackThreadTags(pr, channel),
    limit: 1,
  });
  try {
    const parsed = item ? JSON.parse(item.content) as Partial<SlackThreadMemory> : undefined;
    return parsed?.channel === channel && parsed.threadTs
      ? { channel, threadTs: parsed.threadTs }
      : undefined;
  } catch {
    return undefined;
  }
}

async function rememberSlackThread(ctx: WorkforceCtx, pr: Pr, thread: SlackThreadMemory): Promise<void> {
  await ctx.memory.save(JSON.stringify(thread), {
    scope: 'workspace',
    tags: slackThreadTags(pr, thread.channel),
  });
}

function slackThreadQuery(pr: Pr, channel: string): string {
  return `Slack thread for PR ${pr.owner}/${pr.repo}#${pr.number} in ${channel}`;
}

function slackThreadTags(pr: Pr, channel: string): string[] {
  return [
    SLACK_THREAD_TAG,
    `pr:${pr.owner}/${pr.repo}#${pr.number}`,
    `slack:${channel}`,
  ];
}

// ── parsing the github webhook payload ──────────────────────────────────────
// The PR lives in different places per event: `pull_request` (opened /
// synchronize / review / review_comment), `check_run.pull_requests[0]`
// (check_run.completed), or the top-level `number`.
export function readPr(payload: unknown): Pr | undefined {
  const p = payload as {
    number?: number;
    pull_request?: {
      number?: number;
      html_url?: string;
      user?: { login?: string };
      head?: { sha?: string };
      state?: string;
      merged?: boolean;
      draft?: boolean;
      labels?: unknown;
    };
    check_run?: { pull_requests?: Array<{ number?: number; html_url?: string; head_sha?: string }> };
    repository?: { name?: string; owner?: { login?: string } };
    sender?: { login?: string };
  } | null;
  const prRef = p?.pull_request ?? p?.check_run?.pull_requests?.[0];
  const number = prRef?.number ?? p?.number;
  const owner = p?.repository?.owner?.login;
  const repo = p?.repository?.name;
  // Validate `number` is a real integer — it's interpolated into a shell command.
  if (typeof number !== 'number' || !Number.isInteger(number) || !owner || !repo) return undefined;
  const headSha = p?.pull_request?.head?.sha ?? p?.check_run?.pull_requests?.[0]?.head_sha;
  return {
    owner,
    repo,
    number,
    url: prRef?.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`,
    author: p?.pull_request?.user?.login ?? (p?.pull_request ? p?.sender?.login : undefined) ?? 'unknown',
    ...(headSha ? { headSha } : {}),
    ...(p?.pull_request?.state ? { state: p.pull_request.state } : {}),
    ...(typeof p?.pull_request?.merged === 'boolean' ? { merged: p.pull_request.merged } : {}),
    ...(typeof p?.pull_request?.draft === 'boolean' ? { draft: p.pull_request.draft } : {}),
    ...(p?.pull_request?.labels !== undefined ? { labels: p.pull_request.labels } : {})
  };
}
function isApproval(payload: unknown): boolean {
  return (payload as { review?: { state?: string } } | null)?.review?.state?.toLowerCase() === 'approved';
}
/** Honor approvals only from APPROVERS (comma-separated github logins). When
 *  APPROVERS is unset, any approval merges. */
function isAuthorizedApprover(ctx: WorkforceCtx, payload: unknown): boolean {
  const allow = (input(ctx, 'APPROVERS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length === 0) return true;
  const approver = (payload as { review?: { user?: { login?: string } } } | null)?.review?.user?.login?.toLowerCase();
  return approver !== undefined && allow.includes(approver);
}
/** A finished check run that didn't pass — failure, timed out, cancelled, etc. */
function ciFailed(payload: unknown): boolean {
  const conclusion = (payload as { check_run?: { conclusion?: string } } | null)?.check_run?.conclusion?.toLowerCase();
  return conclusion !== undefined && conclusion !== 'success' && conclusion !== 'neutral' && conclusion !== 'skipped';
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function lastLine(text: string): string {
  return text.trimEnd().split('\n').pop()?.trim() ?? '';
}
function stripLastLine(text: string): string {
  const i = text.lastIndexOf('\n');
  return i < 0 ? '' : text.slice(0, i);
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
