/**
 * pr-reviewer handler — review, auto-fix, and shepherd a PR to the finish line.
 *
 *   an authorized approval (pull_request_review.submitted) → merge the PR.
 *   a check run that finished green (check_run.completed)   → nothing to do.
 *   anything else — opened, new commits (synchronize), a
 *   review comment, failed CI, changes requested            → (re)review and fix.
 *
 * The PR's repo is materialized into ctx.sandbox.cwd by the cloud via relayfile;
 * the agent fixes by editing files there (the integration pushes them to the
 * PR) — no clone, no git/gh.
 */
import { handler, type WorkforceCtx } from '@agentworkforce/runtime';

interface Pr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  author: string; // github login of whoever opened the PR
  headSha?: string;
}

type GithubMergeClient = NonNullable<WorkforceCtx['github']> & {
  mergePullRequest(args: {
    owner: string;
    repo: string;
    number: number;
    method?: 'merge' | 'squash' | 'rebase';
    sha?: string;
  }): Promise<{ merged: boolean; sha?: string }>;
};

export default handler(async (ctx, event) => {
  if (event.source !== 'github' || !ctx.github) return;

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
  if (pr) await reviewAndFix(ctx, pr);
});

async function reviewAndFix(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: [
      `Review pull request #${pr.number} (its code is checked out here) and post your review.`,
      `Then proactively FIX everything that needs changing — your own findings and any other bot reviews on the PR —`,
      `and resolve failing CI checks and merge conflicts by editing the code. Don't use git or the gh CLI; your edits`,
      `are pushed to the PR for you. When the PR is genuinely ready for a human, end your output with READY on its own last line.`
    ].join('\n')
  });

  const channel = input(ctx, 'SLACK_CHANNEL');
  if (channel && ctx.slack) {
    const ready = lastLine(run.output) === 'READY';
    const who = `<https://github.com/${pr.author}|@${pr.author}>`; // the PR opener
    await ctx.slack.post(
      channel,
      ready
        ? `:white_check_mark: ${who} — PR #${pr.number} in *${pr.owner}/${pr.repo}* is ready for your review: ${pr.url}`
        : `:eyes: ${who} — reviewing PR #${pr.number} in *${pr.owner}/${pr.repo}*, still working on it: ${pr.url}`
    );
  }
}

async function mergePr(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  if (!ctx.github) return;
  const github = ctx.github as GithubMergeClient;
  if (typeof github.mergePullRequest !== 'function') {
    throw new Error('ctx.github.mergePullRequest is required to merge approved pull requests.');
  }
  const result = await github.mergePullRequest({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    method: 'squash',
    ...(pr.headSha ? { sha: pr.headSha } : {})
  });
  if (!result.merged) {
    throw new Error(`GitHub did not confirm PR #${pr.number} in ${pr.owner}/${pr.repo} was merged.`);
  }
  const channel = input(ctx, 'SLACK_CHANNEL');
  if (channel && ctx.slack) await ctx.slack.post(channel, `:tada: Merged PR #${pr.number} in ${pr.owner}/${pr.repo}.`);
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
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
