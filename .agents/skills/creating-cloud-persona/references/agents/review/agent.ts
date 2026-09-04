/**
 * pr-reviewer handler — review, apply mechanical safe fixes, and shepherd a PR
 * to the finish line.
 *
 *   an authorized approval (pull_request_review.submitted) → merge the PR.
 *   merge-on-green label + green checks + bot approvals     → merge the PR.
 *   a check run that finished green (check_run.completed)   → maybe merge-on-green, otherwise nothing to do.
 *   anything else — opened, new commits (synchronize), a
 *   review comment, failed CI, changes requested            → (re)review and fix.
 *
 * The PR's repo is materialized into ctx.sandbox.cwd by cloud before the
 * harness runs. The agent may leave only mechanical fixes there; cloud commits
 * and pushes those edits after the harness exits — no git/gh in the harness.
 *
 * Slack policy: the channel only hears about a PR when it's a human's turn —
 * checks green, every bot/reviewer comment resolved, nothing left for the agent
 * to fix (the agent's READY sentinel). In-progress passes stay silent. The only
 * other pings are operator/terminal signals: a failed harness run and a merge.
 */
import {
  defineAgent,
  encodeSegment,
  listJsonFiles,
  readJsonFile,
  resolveMountRoot,
  type IntegrationClientOptions,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { githubClient, slackClient } from '@relayfile/relay-helpers';

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
const MERGE_ON_GREEN_LABEL = 'merge-on-green';
const AGENT_WORKFORCE_ORG = 'agentworkforce';
const SLACK_THREAD_TAG = 'pr-reviewer:slack-thread';

// The opt-in directive a commenter posts to ask for merge-conflict resolution.
// Accepts "@relay fix conflicts" / "@relay-bot resolve conflict" (case- and
// whitespace-insensitive). Deliberately narrow: it must be an explicit ask, not
// any mention, so an ordinary "there's a conflict here" comment never fires it.
const CONFLICT_DIRECTIVE_PATTERN = /@relay(?:-?bot)?\s+(?:fix|resolve)\s+conflicts?\b/i;

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
      { on: 'pull_request.synchronize' },
      { on: 'issues.labeled' },
      // Opt-in merge-conflict resolution: a PR-conversation comment carrying the
      // CONFLICT_DIRECTIVE phrase asks the agent to resolve conflict markers.
      { on: 'issue_comment.created' }
    ],
    slack: [
      {
        on: 'message.created',
        paths: ['/slack/channels/${SLACK_CHANNEL}/**']
      }
    ]
  },
  handler: async (ctx, event) => {
  // `event` is narrowed to the declared provider triggers. The provider
  // payload is reached via expand (no synchronous `event.payload` in v4).
  const data = (await event.expand('full')).data;

  if (event.type.startsWith('slack.')) {
    await handleSlackMergeRequest(ctx, data);
    return;
  }

  const pr = readPr(data);

  if (pr && mergeOnGreenEventType(event.type)) {
    const outcome = await maybeMergeOnGreen(ctx, pr);
    if (outcome === 'merged') return;
    if (event.type === 'github.issues.labeled') return;
  }

  // An approval from an authorized reviewer ends the loop: merge and stop.
  if (event.type === 'github.pull_request_review.submitted' && isApproval(data) && isAuthorizedApprover(ctx, data)) {
    if (pr) await mergePr(ctx, pr);
    return;
  }

  // A PR-conversation comment opts this PR into merge-conflict resolution, but
  // ONLY when it carries the directive phrase and comes from an authorized
  // commenter. Every other issue_comment is ignored here (ordinary review still
  // runs off the pull_request / review_comment triggers).
  if (event.type === 'github.issue_comment.created') {
    if (!matchesConflictDirective(commentBody(data))) return;
    const pr = readPr(data);
    if (!pr) return;
    const commander = commenterLogin(data);
    if (!isAuthorizedConflictCommander(ctx, commander, pr)) {
      ctx.log?.('info', 'pr-reviewer conflict directive ignored: commander not authorized', {
        owner: pr.owner, repo: pr.repo, number: pr.number, commander: commander || 'unknown',
      });
      return;
    }
    const skip = await shouldSkipReview(ctx, pr);
    if (skip) {
      ctx.log?.('info', 'pr-reviewer conflict directive skipped', { owner: pr.owner, repo: pr.repo, number: pr.number, reason: skip.reason });
      return;
    }
    await resolveConflicts(ctx, pr);
    return;
  }

  // A check run that finished without failing needs no action.
  if (event.type === 'github.check_run.completed' && !ciFailed(data)) return;

  // Everything else is a reason to (re)review and apply safe mechanical fixes.
  // `pr` was read above for the merge-on-green path and is reused here.
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

function mergeOnGreenEventType(eventType: string): boolean {
  return eventType === 'github.issues.labeled' ||
    eventType === 'github.check_run.completed' ||
    eventType === 'github.pull_request_review.submitted' ||
    eventType === 'github.pull_request.synchronize' ||
    eventType === 'github.pull_request.opened';
}

type MergeOnGreenOutcome = 'merged' | 'ready' | 'blocked' | 'pending' | 'skipped';

interface MergeOnGreenDecision {
  outcome: MergeOnGreenOutcome;
  reasons: string[];
  pr?: Pr;
  state?: PullRequestReadyState;
}

async function maybeMergeOnGreen(ctx: WorkforceCtx, pr: Pr): Promise<MergeOnGreenOutcome> {
  const decision = await mergeOnGreenDecision(ctx, pr);
  if (decision.outcome !== 'ready' || !decision.pr) {
    logMergeOnGreenDecision(ctx, decision, pr);
    return decision.outcome;
  }
  await mergePr(ctx, decision.pr);
  return 'merged';
}

async function mergeOnGreenDecision(ctx: WorkforceCtx, pr: Pr): Promise<MergeOnGreenDecision> {
  if (!mergeOnGreenRepoAllowed(pr)) {
    return { outcome: 'skipped', reasons: [`${pr.owner}/${pr.repo} is outside AgentWorkforce`], pr };
  }
  const state = await readMergeOnGreenState(ctx, pr);
  const currentPr = {
    ...pr,
    ...(typeof state.headRefOid === 'string' && state.headRefOid.trim() ? { headSha: state.headRefOid.trim() } : {}),
    ...(typeof state.state === 'string' ? { state: state.state.toLowerCase() } : {}),
    ...(typeof state.isDraft === 'boolean' ? { draft: state.isDraft } : {}),
  };
  const gate = evaluateMergeOnGreenState(state);
  return { outcome: gate.outcome, reasons: gate.reasons, pr: currentPr, state };
}

function mergeOnGreenRepoAllowed(pr: Pr): boolean {
  return pr.owner.trim().toLowerCase() === AGENT_WORKFORCE_ORG;
}

function logMergeOnGreenDecision(ctx: WorkforceCtx, decision: MergeOnGreenDecision, pr: Pr): void {
  if (decision.outcome === 'skipped') return;
  ctx.log?.('info', 'pr-reviewer.merge-on-green.held', {
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    outcome: decision.outcome,
    reasons: decision.reasons,
  });
}

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

// ── conflict resolution (opt-in, comment-driven) ────────────────────────────
// Cloud has merged the base branch into the working tree before this runs, so
// conflict markers sit in the conflicted files (listed in
// `.workforce/conflicted-files.txt`). The harness resolves the markers; cloud
// finalizes the merge commit and pushes it after the harness exits. The harness
// itself never runs git — same boundary as ordinary review.
async function resolveConflicts(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: conflictResolveHarnessPrompt(pr)
  });

  const exitCode = (run as { exitCode?: unknown }).exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    await failReviewRun(ctx, pr, `The conflict-resolution harness exited with code ${exitCode}.`);
  }

  const body = (run.output ?? '').trim();
  if (!body) {
    await failReviewRun(ctx, pr, 'The conflict-resolution harness produced no output.');
  }
  if (body) {
    await githubClient().comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, body);
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
    `Auto-edit only lint, formatting, spelling, typo, import-order, or other mechanical non-semantic changes.`,
    `Do not auto-edit semantic or safety-critical logic. For behavior changes, architecture changes, and any reviewer`,
    `request that needs human judgment, leave a clear suggestion or review comment instead of changing files.`,
    `If the PR already has a human review or approval, switch to suggestion/comment-only for everything except`,
    `obvious mechanical cleanup that cannot change runtime behavior.`,
    `Resolve failing CI checks by editing the code only when the fix is mechanical and non-semantic. Don't use git or the gh CLI; cloud commits`,
    `and pushes your file edits to the PR after this run. In your output, do not claim that fixes were pushed,`,
    `a GitHub review was submitted, or CI was verified; those are post-harness actions that cloud reports separately.`,
    `Validate every finding — yours or another bot's — against the CURRENT checkout before editing: review comments`,
    `are often stale (already fixed by a later push). Reproduce the problem in the code as it is now, or skip it.`,
    `Make the smallest fix that addresses a demonstrated problem. Do not rewrite, restructure, or "harden" working`,
    `code beyond what the finding requires.`,
    `Never change semantic or safety defaults: do not turn fail-closed states into fail-open states such as`,
    `"timeout", "pending", throw, or undefined becoming "acked", true, {}, or another success/default path; do not`,
    `swap truthiness checks for presence checks; do not edit guard default values. If a reviewer asks for one of`,
    `these changes, explain the risk in your review and leave the code unchanged.`,
    `Never touch lifecycle, termination, reaper, in-flight, dispatch, broker ownership, or process-cleanup code. Those`,
    `areas are safety-critical; raise findings as comments for a human-authored patch instead.`,
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
    `Never add or modify tests to make your own change pass. If a change needs a new or updated test, that is a`,
    `human decision; describe the needed test in your review and leave the working tree unchanged.`,
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

export function conflictResolveHarnessPrompt(pr: { owner: string; repo: string; number: number }): string {
  return [
    `Resolve the merge conflicts on pull request #${pr.number} in ${pr.owner}/${pr.repo}. The PR is checked out in the`,
    `current directory and cloud has already merged the base branch into the working tree, so conflict markers`,
    `(<<<<<<<, =======, >>>>>>>) are present in the conflicted files. Read .workforce/conflicted-files.txt for the`,
    `exact list, and .workforce/pr.diff plus .workforce/context.json to understand what this PR changed versus base.`,
    `Resolve EVERY conflict with the smallest correct merge that preserves BOTH sides' intent: understand what each`,
    `side changed and why, then combine them so neither change is silently dropped. Do not blindly pick one side.`,
    `Remove every conflict marker you resolve — leave no <<<<<<<, =======, or >>>>>>> behind in any file you touch.`,
    `Do NOT use git or the gh CLI. Cloud finalizes the merge commit and pushes it to the PR after you exit; your job`,
    `is only to leave a correctly merged working tree. Do not claim the merge was committed or pushed — that is a`,
    `post-harness action cloud reports separately.`,
    `Stay strictly within resolving the conflicts. Do not refactor, "harden", or fold in unrelated changes while`,
    `merging — a conflict resolution that smuggles in extra edits is how an unrelated build breaks.`,
    `Never resolve a conflict by changing a semantic or safety default: do not turn a fail-closed state into a`,
    `fail-open one (a "timeout"/"pending"/throw/undefined becoming "acked"/true/{}/a success path), do not swap a`,
    `truthiness check for a presence check, and do not alter guard default values to make the merge simpler.`,
    `Never touch lifecycle, termination, reaper, in-flight, dispatch, broker ownership, or process-cleanup code to`,
    `resolve a conflict; if the conflict is in one of those areas, treat it as needing human judgment (below).`,
    `Never weaken or delete a test to resolve a conflict: do not skip it, loosen an assertion, or replace a real`,
    `assertion with a trivially-true one. When both sides changed a test, merge both expectations honestly.`,
    `If a conflict genuinely needs human judgment — the two sides are semantically incompatible, combining them is`,
    `ambiguous or risky, or it lands in safety-critical code — do NOT guess. Leave that file's conflict markers in`,
    `place, and list the file under a "## Unresolved conflicts" heading with a one-line reason. Cloud aborts the`,
    `merge and posts your explanation when any conflict is left unresolved, so a risky half-merge is never pushed.`,
    `After resolving, verify the merged tree the way CI does — run the repo's canonical build/test/typecheck command`,
    `end to end (read package.json / turbo.json / the CI workflow to find what CI runs; install dependencies if`,
    `needed) so you catch breakage caused by combining the two sides, not just within one conflicted file. If you`,
    `cannot make the merged tree pass and cannot fix it without human judgment, leave the remaining markers and`,
    `record them under "## Unresolved conflicts" rather than pushing an unverified merge.`,
    `Account for every conflicted file in your output: list each resolved file under a "## Resolved conflicts"`,
    `heading with a one-line note on how you combined the two sides (e.g. "src/foo.ts — kept base's retry plus the`,
    `PR's new timeout arg"), and list any you left for a human under "## Unresolved conflicts".`
  ].join('\n');
}

async function verifyReadyForHumanReview(ctx: WorkforceCtx, pr: Pr): Promise<boolean> {
  try {
    const state = await readPrReviewState(pr);
    // Populate the head SHA from the adapter's projected head. Some webhook
    // payloads (e.g. check_run.completed) don't carry it, and without a SHA the
    // ready-announce dedupe can't key on the commit and would re-ping.
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
  isDraft?: unknown;
  labels?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  reviewDecision?: unknown;
  reviewRequests?: unknown;
  latestReviews?: unknown;
  statusCheckRollup?: unknown;
  headRefOid?: unknown;
  url?: unknown;
}

async function readMergeOnGreenState(_ctx: WorkforceCtx, pr: Pr): Promise<PullRequestReadyState> {
  return readPrReviewState(pr);
}

// ── PR review state from the GitHub VFS (no gh CLI) ──────────────────────────
// `gh pr view` is unavailable here: the sandbox snapshot ships no gh binary, and
// the harness never shells to git/gh (the cloud writeback commits file edits).
// Rebuild the same PullRequestReadyState the gates consume from the GitHub
// adapter's VFS projection instead:
//   • pulls/{n}/meta.json            → state, draft, labels, head.sha
//   • pulls/{n}/checks/_summary.json → the adapter's aggregated CI rollup
//   • pulls/{n}/reviews/*.json       → the latest review per author
// The adapter does NOT project mergeability (GitHub computes it asynchronously
// and it isn't ingested), so the merge-conflict check is delegated to the merge
// API: mergePullRequest() returns merged:false on a dirty PR and mergePr throws
// rather than land it. Every read fails CLOSED — a missing/empty projection
// yields a state the gates treat as not-ready / pending, never a green light.
async function readPrReviewState(pr: Pr): Promise<PullRequestReadyState> {
  const [meta, checks, reviews] = await Promise.all([
    loadPrMeta(pr),
    loadCheckSummary(pr),
    loadReviews(pr),
  ]);
  const headSha = readMetaHeadSha(meta);
  return {
    state: typeof meta?.state === 'string' ? meta.state : undefined,
    isDraft: meta?.draft === true,
    // The VFS carries no mergeability field (the adapter doesn't project it), so
    // default to MERGEABLE rather than gate on a value we can't read — otherwise
    // the ready/merge gates could never pass at all. Safety rests on the merge
    // API, not this field: a conflicted PR can NEVER be auto-merged, because
    // mergePr throws when GitHub rejects the merge (merged:false). The residual
    // is cosmetic — a conflicted PR may still be pinged as "ready for human
    // review" (the ready path doesn't hit the merge API); a human resolving the
    // conflict at review time absorbs that. True conflict-awareness needs the
    // github adapter to project mergeable/mergeStateStatus (tracked alongside the
    // cloud credential/projection work).
    mergeable: 'MERGEABLE',
    // Drafts surface via isDraft; mirror onto mergeStateStatus too so the ready
    // gate (which keys on DRAFT) still holds a draft back.
    ...(meta?.draft === true ? { mergeStateStatus: 'DRAFT' } : {}),
    labels: meta?.labels,
    statusCheckRollup: rollupFromCheckSummary(checks),
    latestReviews: reviews,
    reviewDecision: deriveReviewDecision(reviews),
    ...(headSha ? { headRefOid: headSha } : {}),
  };
}

/** The adapter's per-PR aggregated check status at `…/pulls/{n}/checks/_summary.json`. */
interface CheckSummary {
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  conclusion?: string;
}

async function loadCheckSummary(pr: Pr): Promise<CheckSummary | undefined> {
  try {
    return await readJsonFile<CheckSummary>(
      vfsClient(),
      'github',
      'getChecks',
      `/github/repos/${encodeSegment(pr.owner)}/${encodeSegment(pr.repo)}/pulls/${pr.number}/checks/_summary.json`
    );
  } catch {
    return undefined;
  }
}

async function loadReviews(pr: Pr): Promise<Array<Record<string, unknown>>> {
  try {
    const files = await listJsonFiles<Record<string, unknown>>(
      vfsClient(),
      'github',
      'listReviews',
      `/github/repos/${encodeSegment(pr.owner)}/${encodeSegment(pr.repo)}/pulls/${pr.number}/reviews`
    );
    // Guard each entry: a malformed file must not throw out of the map and blank
    // the whole review set (the catch below would return []), which would drop an
    // active CHANGES_REQUESTED review and could let a blocked PR merge.
    return Array.isArray(files)
      ? files
          .map((file) => file?.value)
          .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
      : [];
  } catch {
    return [];
  }
}

/** The PR head SHA from the meta.json projection's `head: { sha }`. */
function readMetaHeadSha(meta: PrMeta | undefined): string | undefined {
  const head = meta?.head;
  if (head && typeof head === 'object' && typeof (head as { sha?: unknown }).sha === 'string') {
    return ((head as { sha: string }).sha).trim() || undefined;
  }
  return undefined;
}

/**
 * Turn the adapter's aggregated check counts into the statusCheckRollup shape
 * the gate evaluators already understand. The decision keys on the counts, not
 * on per-check files (which can linger from a prior head), so the gate matches
 * GitHub's own "is everything done and green" verdict:
 *   • no checks ingested yet (total 0 / missing) → empty rollup → the evaluators
 *     fall through to mergeStateStatus, which we never report CLEAN → HOLD.
 *   • any failing check  → a FAILURE entry → blocked.
 *   • any pending check  → an IN_PROGRESS entry → pending.
 *   • all complete+passing → a single SUCCESS entry → green.
 */
export function rollupFromCheckSummary(summary: CheckSummary | undefined): Array<Record<string, unknown>> {
  const failed = typeof summary?.failed === 'number' ? summary.failed : 0;
  const pending = typeof summary?.pending === 'number' ? summary.pending : 0;
  const passed = typeof summary?.passed === 'number' ? summary.passed : 0;
  // Fall back to the component counts when `total` is missing/malformed, so a
  // summary that carries failed/pending/passed but no `total` still reports the
  // real check states instead of being treated as "no checks" and held generically.
  const total = typeof summary?.total === 'number' ? summary.total : failed + pending + passed;
  if (!summary || total === 0) return [];
  const rollup: Array<Record<string, unknown>> = [];
  if (failed > 0) {
    rollup.push({ name: `${failed} failing check${failed === 1 ? '' : 's'}`, status: 'COMPLETED', conclusion: 'FAILURE' });
  }
  if (pending > 0) {
    rollup.push({ name: `${pending} pending check${pending === 1 ? '' : 's'}`, status: 'IN_PROGRESS', conclusion: null });
  }
  if (failed === 0 && pending === 0) {
    rollup.push({ name: `${passed} check${passed === 1 ? '' : 's'}`, status: 'COMPLETED', conclusion: 'SUCCESS' });
  }
  return rollup;
}

/**
 * Derive gh's `reviewDecision` from the projected reviews: if any author's
 * latest review requested changes, the PR isn't the human's turn. Mirrors the
 * one reviewDecision value the ready gate keys on (CHANGES_REQUESTED).
 */
export function deriveReviewDecision(reviews: Array<Record<string, unknown>>): string | undefined {
  for (const [, review] of latestReviewsByAuthor(reviews)) {
    if (normalizeState(review.state) === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  }
  return undefined;
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

interface MergeOnGreenGate {
  outcome: Exclude<MergeOnGreenOutcome, 'merged' | 'skipped'>;
  reasons: string[];
}

export function evaluateMergeOnGreenState(state: PullRequestReadyState): MergeOnGreenGate {
  const reasons: string[] = [];
  if (!prIsOpen(state)) reasons.push(`PR is ${String(state.state ?? 'not open')}`);
  if (state.isDraft === true || normalizeState(state.mergeStateStatus) === 'DRAFT') reasons.push('PR is a draft');
  if (!mergeOnGreenLabels(state.labels).has(MERGE_ON_GREEN_LABEL)) reasons.push(`PR is missing the "${MERGE_ON_GREEN_LABEL}" label`);
  if (state.mergeable === 'CONFLICTING') reasons.push('PR has merge conflicts');
  const checkReason = mergeOnGreenChecksReason(state);
  if (checkReason) reasons.push(checkReason);
  const reviewReason = mergeOnGreenBotReviewReason(state);
  if (reviewReason) reasons.push(reviewReason);

  if (reasons.length === 0) return { outcome: 'ready', reasons: [] };
  const blocked = reasons.some((reason) =>
    /fail|error|not passing|changes requested|requested changes|conflict|closed|merged|draft/i.test(reason)
  );
  return { outcome: blocked ? 'blocked' : 'pending', reasons };
}

function mergeOnGreenLabels(labels: unknown): Set<string> {
  return new Set(labelNames(labels));
}

function mergeOnGreenChecksReason(state: PullRequestReadyState): string | null {
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (checks.length === 0) {
    return normalizeState(state.mergeStateStatus) === 'CLEAN'
      ? null
      : 'checks are not reported as complete yet';
  }
  const blocked = checks.find((check) => !checkPassedAndComplete(check));
  if (!blocked || typeof blocked !== 'object') return null;
  const record = blocked as Record<string, unknown>;
  const name = String(record.name ?? record.context ?? record.workflowName ?? 'unknown');
  const stateText = String(record.state ?? record.status ?? 'missing');
  const conclusionText = String(record.conclusion ?? 'missing');
  if (stateText.toUpperCase() === 'PENDING' || stateText.toUpperCase() === 'IN_PROGRESS') {
    return `check "${name}" is still ${stateText.toLowerCase()}`;
  }
  if (stateText.toUpperCase() !== 'COMPLETED' && record.status !== undefined) {
    return `check "${name}" is still ${stateText.toLowerCase()}`;
  }
  return `check "${name}" is not passing (${stateText}/${conclusionText})`;
}

function mergeOnGreenBotReviewReason(state: PullRequestReadyState): string | null {
  const latest = latestReviewsByAuthor(state.latestReviews);
  for (const [login, review] of latest) {
    const author = reviewAuthor(review);
    if (!isBotLogin(author.login, author.type)) continue;
    if (normalizeState(review.state) === 'CHANGES_REQUESTED') {
      return `bot @${login} requested changes`;
    }
  }
  for (const login of requestedBotReviewLogins(state.reviewRequests)) {
    const review = latest.get(login);
    if (normalizeState(review?.state) !== 'APPROVED') {
      return `bot @${login} has not approved yet`;
    }
  }
  return null;
}

function requestedBotReviewLogins(reviewRequests: unknown): string[] {
  if (!Array.isArray(reviewRequests)) return [];
  const logins = new Set<string>();
  for (const request of reviewRequests) {
    if (!request || typeof request !== 'object') continue;
    const record = request as Record<string, unknown>;
    const reviewer = record.requestedReviewer && typeof record.requestedReviewer === 'object'
      ? record.requestedReviewer as Record<string, unknown>
      : record;
    const login = readLogin(reviewer.login);
    const type = typeof reviewer.type === 'string'
      ? reviewer.type
      : typeof reviewer.__typename === 'string'
        ? reviewer.__typename
        : undefined;
    if (login && isBotLogin(login, type)) logins.add(login);
  }
  return [...logins].sort();
}

function latestReviewsByAuthor(reviews: unknown): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(reviews)) return latest;
  for (const review of reviews) {
    if (!review || typeof review !== 'object') continue;
    const record = review as Record<string, unknown>;
    const author = reviewAuthor(record);
    if (!author.login) continue;
    const existing = latest.get(author.login);
    if (!existing || reviewTimestamp(record) >= reviewTimestamp(existing)) {
      latest.set(author.login, record);
    }
  }
  return latest;
}

function reviewAuthor(review: Record<string, unknown> | undefined): { login: string; type?: string } {
  if (!review) return { login: '' };
  const author = review.author && typeof review.author === 'object'
    ? review.author as Record<string, unknown>
    : review.user && typeof review.user === 'object'
      ? review.user as Record<string, unknown>
      : {};
  return {
    login: readLogin(author.login),
    type: typeof author.type === 'string'
      ? author.type
      : typeof author.__typename === 'string'
        ? author.__typename
        : undefined,
  };
}

function reviewTimestamp(review: Record<string, unknown>): number {
  const date = typeof review.submittedAt === 'string'
    ? review.submittedAt
    : typeof review.submitted_at === 'string'
      ? review.submitted_at
      : '';
  const ms = Date.parse(date);
  if (Number.isFinite(ms)) return ms;
  return typeof review.id === 'number' ? review.id : 0;
}

function readLogin(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isBotLogin(login: string, type?: string): boolean {
  return type === 'Bot' || type === 'BotUser' || login.endsWith('[bot]');
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

interface SlackMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  isBot: boolean;
  subtype?: string;
}

interface SlackThreadMemory {
  channel: string;
  threadTs: string;
}

interface SlackThreadClient {
  post(channel: string, text: string): Promise<{ channel: string; ts: string }>;
  reply(channel: string, threadTs: string, text: string): Promise<{ channel: string; ts: string }>;
}

export async function handleSlackMergeRequest(
  ctx: WorkforceCtx,
  payload: unknown,
  client: SlackThreadClient = slackClient({ writebackTimeoutMs: 15_000 }),
  decide: (ctx: WorkforceCtx, pr: Pr) => Promise<MergeOnGreenDecision> = mergeOnGreenDecision,
  merge: (ctx: WorkforceCtx, pr: Pr) => Promise<void> = mergePr
): Promise<void> {
  const msg = readSlackMessage(payload);
  if (!msg || msg.isBot || msg.subtype) return;
  const configuredChannel = input(ctx, 'SLACK_CHANNEL');
  if (configuredChannel && msg.channel !== configuredChannel) return;
  const request = parseSlackMergeRequest(msg.text);
  if (!request) return;

  if (!request.pr) {
    await replyToSlackMessage(client, msg, 'I can check merge-on-green status, but I need a GitHub pull request URL.');
    return;
  }

  try {
    const decision = await decide(ctx, request.pr);
    if (decision.outcome === 'ready' && decision.pr) {
      await merge(ctx, decision.pr);
      await replyToSlackMessage(
        client,
        msg,
        `Merged ${decision.pr.owner}/${decision.pr.repo}#${decision.pr.number} because checks are green and bot reviews are satisfied.`
      );
      return;
    }

    const reasons = decision.reasons.length > 0 ? decision.reasons : ['merge-on-green gates are not satisfied yet'];
    await replyToSlackMessage(
      client,
      msg,
      `I cannot merge ${request.pr.owner}/${request.pr.repo}#${request.pr.number} yet: ${reasons.join('; ')}.`
    );
  } catch (error) {
    await replyToSlackMessage(
      client,
      msg,
      `An error occurred while processing the merge request for ${request.pr.owner}/${request.pr.repo}#${request.pr.number}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readSlackMessage(payload: unknown): SlackMessage | undefined {
  const p = payload as {
    channel?: string;
    ts?: string;
    thread_ts?: string;
    threadTs?: string;
    text?: string;
    is_bot?: boolean;
    isBot?: boolean;
    bot_id?: string;
    subtype?: string;
    message?: {
      channel?: string;
      ts?: string;
      thread_ts?: string;
      text?: string;
      is_bot?: boolean;
      bot_id?: string;
      subtype?: string;
    };
  } | null;
  const source = p?.message ?? p ?? {};
  const channel = typeof source?.channel === 'string' ? source.channel : '';
  const ts = typeof source?.ts === 'string' ? source.ts : '';
  const text = typeof source?.text === 'string' ? source.text : '';
  if (!channel || !ts || !text) return undefined;
  return {
    channel,
    ts,
    threadTs: typeof source.thread_ts === 'string'
      ? source.thread_ts
      : typeof p?.threadTs === 'string'
        ? p.threadTs
        : undefined,
    text,
    isBot: source.is_bot === true || p?.isBot === true || typeof source.bot_id === 'string',
    subtype: typeof source.subtype === 'string' ? source.subtype : undefined,
  };
}

export function parseSlackMergeRequest(text: string): { pr?: Pr } | null {
  const normalized = text.toLowerCase();
  if (!mentionsPrReviewer(normalized)) return null;
  if (!/(merge|ship|land)/.test(normalized)) return null;
  const pr = parseGithubPullRequestUrl(text);
  return { ...(pr ? { pr } : {}) };
}

function mentionsPrReviewer(normalizedText: string): boolean {
  return /<@[A-Z0-9]+>/i.test(normalizedText) ||
    normalizedText.includes('pr-reviewer') ||
    normalizedText.includes('review agent');
}

function parseGithubPullRequestUrl(text: string): Pr | undefined {
  const match = text.match(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)/i);
  if (!match) return undefined;
  return {
    owner: match[1],
    repo: match[2],
    number: Number.parseInt(match[3], 10),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    author: 'unknown',
  };
}

async function replyToSlackMessage(
  client: SlackThreadClient,
  msg: SlackMessage,
  text: string
): Promise<void> {
  await client.reply(msg.channel, msg.threadTs ?? msg.ts, text);
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
// (check_run.completed), `issue` (issue_comment.created — the issue IS the PR
// when `issue.pull_request` is present), or the top-level `number`.
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
    issue?: {
      number?: number;
      html_url?: string;
      user?: { login?: string };
      state?: string;
      draft?: boolean;
      labels?: unknown;
      // Present only when the issue is actually a pull request. Its absence is
      // how a plain issue_comment is told apart from a PR comment.
      pull_request?: unknown;
    };
    check_run?: { pull_requests?: Array<{ number?: number; html_url?: string; head_sha?: string }> };
    repository?: { name?: string; owner?: { login?: string } };
    sender?: { login?: string };
  } | null;
  // For issue_comment / issues.labeled, only treat the issue as a PR when
  // GitHub marks it one (the `pull_request` field is present).
  const prIssue = p?.issue?.pull_request != null ? p.issue : undefined;
  const prRef = p?.pull_request ?? p?.check_run?.pull_requests?.[0] ?? prIssue;
  const number = prRef?.number ?? p?.number;
  const owner = p?.repository?.owner?.login;
  const repo = p?.repository?.name;
  // Validate `number` is a real integer — it's interpolated into a shell command.
  if (typeof number !== 'number' || !Number.isInteger(number) || !owner || !repo) return undefined;
  const headSha = p?.pull_request?.head?.sha ?? p?.check_run?.pull_requests?.[0]?.head_sha;
  // On issue_comment, `issue.user.login` is the PR opener and `sender.login` is
  // the commenter — prefer the opener so the author allowlist gates on the right
  // person; fall back to sender only for PR-shaped payloads without an opener.
  const author =
    p?.pull_request?.user?.login ??
    prIssue?.user?.login ??
    ((p?.pull_request || prIssue) ? p?.sender?.login : undefined) ??
    'unknown';
  const state = p?.pull_request?.state ?? prIssue?.state;
  const draft = typeof p?.pull_request?.draft === 'boolean' ? p.pull_request.draft : prIssue?.draft;
  const labels = p?.pull_request?.labels ?? prIssue?.labels;
  return {
    owner,
    repo,
    number,
    url: prRef?.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`,
    author,
    ...(headSha ? { headSha } : {}),
    ...(state ? { state } : {}),
    ...(typeof p?.pull_request?.merged === 'boolean' ? { merged: p.pull_request.merged } : {}),
    ...(typeof draft === 'boolean' ? { draft } : {}),
    ...(labels !== undefined ? { labels } : {})
  };
}
/** The body of an issue_comment webhook, or '' when absent. */
export function commentBody(payload: unknown): string {
  const body = (payload as { comment?: { body?: unknown } } | null)?.comment?.body;
  return typeof body === 'string' ? body : '';
}
/** The login of whoever wrote the comment (NOT the PR author), lowercased. */
export function commenterLogin(payload: unknown): string {
  const login = (payload as { comment?: { user?: { login?: unknown } } } | null)?.comment?.user?.login;
  return typeof login === 'string' ? login.trim().toLowerCase() : '';
}
/** Whether a comment body carries the opt-in conflict-resolution directive. */
export function matchesConflictDirective(body: string): boolean {
  return CONFLICT_DIRECTIVE_PATTERN.test(body);
}

/**
 * Who may command a conflict resolution. Resolving conflicts force-updates the
 * PR branch, so don't take the order from just anyone: a bot never qualifies
 * (it's also how the loop is broken if a fix-bot echoes the phrase), and when
 * APPROVERS/REVIEW_AUTHORS are configured the commenter must be the PR's own
 * author or appear on one of those trust lists. With neither list set the
 * persona stays open (matching its other allowlists' "unset → everyone").
 */
export function isAuthorizedConflictCommander(ctx: WorkforceCtx, commander: string, pr: Pr): boolean {
  if (!commander || commander.endsWith('[bot]')) return false;
  const approvers = (input(ctx, 'APPROVERS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const reviewAuthors = reviewAuthorAllowlist(ctx);
  if (approvers.length === 0 && reviewAuthors.size === 0) return true;
  if (commander === (pr.author ?? '').trim().toLowerCase()) return true;
  return approvers.includes(commander) || reviewAuthors.has(commander);
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
