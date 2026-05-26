/**
 * pr-reviewer handler — review, auto-fix, and shepherd a PR to the finish line.
 *
 *   you approve (pull_request_review.submitted)        → merge the PR.
 *   CI finishes green (check_run.completed)            → nothing to do.
 *   anything else — opened, new commits (synchronize),
 *   a review comment, failed CI, changes requested     → (re)review and fix.
 */
import { handler, type WorkforceCtx } from '@agentworkforce/runtime';

interface Pr {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export default handler(async (ctx, event) => {
  if (event.source !== 'github' || !ctx.github) return;

  // Your approval is the one signal that ends the loop: merge and stop.
  if (event.type === 'pull_request_review.submitted' && isApproval(event.payload)) {
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
  // The cloud materializes the PR's repo into the sandbox (ctx.sandbox.cwd) via
  // relayfile — no clone. The agent checks out the PR branch itself.
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: [
      `Check out pull request #${pr.number} (\`gh pr checkout ${pr.number}\`) in this repo.`,
      `Review it thoroughly and post your review with \`gh pr review\`.`,
      `Then proactively FIX what needs changing — your own findings and any other bot reviews on the PR.`,
      `Resolve failing CI checks and merge conflicts. Commit and push the fixes to the PR branch.`,
      `When the PR is genuinely ready for a human, finish with the single word: READY`
    ].join('\n')
  });

  const user = input(ctx, 'SLACK_USER');
  if (user && ctx.slack) {
    const ready = /\bREADY\b/.test(run.output);
    await ctx.slack.dm(
      user,
      ready
        ? `:white_check_mark: PR #${pr.number} in *${pr.owner}/${pr.repo}* is ready for your review: ${pr.url}`
        : `:eyes: Reviewed PR #${pr.number} in *${pr.owner}/${pr.repo}* — still working on it: ${pr.url}`
    );
  }
}

async function mergePr(ctx: WorkforceCtx, pr: Pr): Promise<void> {
  await ctx.sandbox.exec(`gh pr merge ${pr.number} --repo ${shellQuote(`${pr.owner}/${pr.repo}`)} --squash`);
  const user = input(ctx, 'SLACK_USER');
  if (user && ctx.slack) await ctx.slack.dm(user, `:tada: Merged PR #${pr.number} in ${pr.owner}/${pr.repo}.`);
}

// ── parsing the github webhook payload ──────────────────────────────────────
// The PR lives in different places per event: `pull_request` (opened /
// synchronize / review / review_comment), `check_run.pull_requests[0]`
// (check_run.completed), or the top-level `number`.
function readPr(payload: unknown): Pr | undefined {
  const p = payload as {
    number?: number;
    pull_request?: { number?: number; html_url?: string };
    check_run?: { pull_requests?: Array<{ number?: number; html_url?: string }> };
    repository?: { name?: string; owner?: { login?: string } };
  } | null;
  const pr = p?.pull_request ?? p?.check_run?.pull_requests?.[0];
  const number = pr?.number ?? p?.number;
  const owner = p?.repository?.owner?.login;
  const repo = p?.repository?.name;
  if (!number || !owner || !repo) return undefined;
  return { owner, repo, number, url: pr?.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}` };
}
function isApproval(payload: unknown): boolean {
  return (payload as { review?: { state?: string } } | null)?.review?.state?.toLowerCase() === 'approved';
}
/** A finished check run that didn't pass — failure, timed out, cancelled, etc. */
function ciFailed(payload: unknown): boolean {
  const conclusion = (payload as { check_run?: { conclusion?: string } } | null)?.check_run?.conclusion?.toLowerCase();
  return conclusion !== undefined && conclusion !== 'success' && conclusion !== 'neutral' && conclusion !== 'skipped';
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
