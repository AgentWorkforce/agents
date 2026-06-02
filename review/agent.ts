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
    await reviewAndFix(ctx, pr);
  } else if (event.type === 'check_run.completed') {
    // GitHub sometimes emits check_run.completed with pull_requests: [] for
    // fork PRs and org-level checks; surface so a "silent no-op" isn't
    // mistaken for "PR review skipped on purpose".
    ctx.log?.('info', 'check_run.completed with no associated PR; skipping', { eventId: event.id });
  }
  }
});

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
function readPr(payload: unknown): Pr | undefined {
  const p = payload as {
    number?: number;
    pull_request?: { number?: number; html_url?: string; user?: { login?: string }; head?: { sha?: string } };
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
    author: p?.pull_request?.user?.login ?? p?.sender?.login ?? 'unknown',
    ...(headSha ? { headSha } : {})
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
