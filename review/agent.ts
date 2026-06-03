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

interface Pr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  author: string; // github login of whoever opened the PR
  headSha?: string;
  state?: string;
  merged?: boolean;
  labels?: unknown;
}

/** The materialized PR record at `…/pulls/{n}/meta.json`. Read for the
 *  authoritative author/labels/state — the webhook payload doesn't carry them
 *  on every trigger (check_run.completed has neither). Read defensively: the
 *  shape is the github adapter's projection and fields may be absent. */
interface PrMeta {
  state?: string; // 'open' | 'closed'
  merged?: boolean;
  // The materialized meta.json has carried `author` both as a bare login
  // string and as an object — accept either so the allowlist isn't silently
  // bypassed by a shape mismatch.
  author?: string | { login?: string };
  labels?: unknown; // validated as Array<{ name?: string }> at read time
  [key: string]: unknown;
}

const DEFAULT_SKIP_LABEL = 'no-agent-relay-review';

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
  if (event.source !== 'github') return;

  // An approval from an authorized reviewer ends the loop: merge and stop.
  if (event.type === 'pull_request_review.submitted' && isApproval(event.payload) && isAuthorizedApprover(ctx, event.payload)) {
    const pr = readPr(event.payload);
    if (pr) await mergePr(ctx, pr);
    return;
  }

  // A check run that finished without failing needs no action.
  if (event.type === 'check_run.completed' && !ciFailed(event.payload)) return;

  // Everything else is a reason to (re)review and push fixes.
  const pr = readPr(event.payload);
  if (pr) {
    const skip = await shouldSkipReview(ctx, pr);
    if (skip) {
      ctx.log?.('info', 'pr-reviewer skipped', { owner: pr.owner, repo: pr.repo, number: pr.number, reason: skip.reason });
      if (skip.notify) await notifySkip(ctx, pr, skip.reason);
      return;
    }
    await reviewAndFix(ctx, pr);
  } else if (event.type === 'check_run.completed') {
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
async function shouldSkipReview(ctx: WorkforceCtx, pr: Pr): Promise<{ reason: string; notify?: boolean } | null> {
  const meta = await loadPrMeta(pr);

  // Already merged/closed by the time we got here — don't post a stale review
  // on a finished PR. This is the cheap, agent-side half of the merge-race;
  // preserving the unpushed fixes via a recovery PR needs the cloud-side work
  // tracked in AgentWorkforce/cloud#1659 / #1660.
  const state = (meta?.state ?? pr.state ?? '').trim().toLowerCase();
  if (meta?.merged === true || pr.merged === true || state === 'closed') {
    return { reason: 'PR is already merged/closed', notify: true };
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
): { reason: string } | null {
  if (allow.size === 0) {
    return null;
  }
  if (!author || author === 'unknown') {
    return { reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved' };
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

async function notifySkip(ctx: WorkforceCtx, pr: Pr, reason: string): Promise<void> {
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) return;
  await slackClient().post(
    channel,
    `:information_source: pr-reviewer skipped PR #${pr.number} in *${pr.owner}/${pr.repo}* — ${reason}: ${pr.url}`
  );
}

async function reviewAndFix(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: [
      `Review pull request #${pr.number} in ${pr.owner}/${pr.repo}. The PR code is checked out in the current directory.`,
      `Focus on the actual PR changes: read .workforce/pr.diff first, then .workforce/changed-files.txt and .workforce/context.json.`,
      `Use the checked-out repo to trace the impact of this diff across callers, types, tests, config, and related files.`,
      `Flag and fix breakage even when the affected file is outside the changed-file set, but do not do an unrelated full-repo audit.`,
      `Then proactively FIX everything that needs changing — your own findings and any other bot reviews on the PR —`,
      `and resolve failing CI checks and merge conflicts by editing the code. Don't use git or the gh CLI; cloud commits`,
      `and pushes your file edits to the PR after this run. In your output, do not claim that fixes were pushed,`,
      `a GitHub review was submitted, or CI was verified; those are post-harness actions that cloud reports separately.`,
      `When the PR is genuinely ready for a human after your local review and edits, end your output with READY on its own last line.`
    ].join('\n')
  });

  const exitCode = (run as { exitCode?: unknown }).exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    await failReviewRun(ctx, pr, `The review harness exited with code ${exitCode}.`);
  }

  // The harness only writes a review when we explicitly post it. Strip the
  // READY sentinel (it's the slack/ready signal, not a review-body line) and
  // post whatever's left as a PR comment via the github VFS.
  const raw = (run.output ?? '').trimEnd();
  const ready = lastLine(raw) === 'READY';
  const body = ready ? stripLastLine(raw).trimEnd() : raw;
  if (!body) {
    await failReviewRun(ctx, pr, 'The review harness produced no review output.');
  }
  if (body) {
    await githubClient().comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, body);
  }

  const channel = input(ctx, 'SLACK_CHANNEL');
  if (channel) {
    const who = `<https://github.com/${pr.author}|@${pr.author}>`; // the PR opener
    await slackClient().post(
      channel,
      ready
        ? `:white_check_mark: ${who} — PR #${pr.number} in *${pr.owner}/${pr.repo}* is ready for your review: ${pr.url}`
        : `:eyes: ${who} — reviewing PR #${pr.number} in *${pr.owner}/${pr.repo}*, still working on it: ${pr.url}`
    );
  }
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
    await slackClient().post(
      channel,
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
    await slackClient().post(channel, `:tada: Merged PR #${pr.number} in ${pr.owner}/${pr.repo}.`);
  }
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
      labels?: unknown;
    };
    check_run?: { pull_requests?: Array<{ number?: number; html_url?: string; head_sha?: string }> };
    repository?: { name?: string; owner?: { login?: string } };
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
    author: p?.pull_request?.user?.login ?? 'unknown',
    ...(headSha ? { headSha } : {}),
    ...(p?.pull_request?.state ? { state: p.pull_request.state } : {}),
    ...(typeof p?.pull_request?.merged === 'boolean' ? { merged: p.pull_request.merged } : {}),
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
