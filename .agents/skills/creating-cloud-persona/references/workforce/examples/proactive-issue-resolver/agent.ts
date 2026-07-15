import { defineAgent } from '@agentworkforce/runtime';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import { createRickySdk } from '@agentworkforce/ricky';
import type {
  CloudGenerateRequest,
  CloudGenerateResponse,
  LocalResponse,
} from '@agentworkforce/ricky';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const CLAIM_LABEL = 'ricky-claimed';
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

type IssueTarget = { owner: string; repo: string; number: number };

interface GithubIssuePayload {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    labels?: Array<{ name?: string } | string>;
    user?: { login?: string };
  };
  repository?: {
    name?: string;
    full_name?: string;
    owner?: { login?: string } | string;
  };
}

function asPayload(payload: unknown): GithubIssuePayload {
  return typeof payload === 'object' && payload !== null
    ? (payload as GithubIssuePayload)
    : {};
}

function targetFromPayload(p: GithubIssuePayload): IssueTarget {
  const ownerLogin =
    typeof p.repository?.owner === 'string'
      ? p.repository.owner
      : p.repository?.owner?.login;
  const owner = normalizeGithubSegment(
    ownerLogin ?? p.repository?.full_name?.split('/')[0],
    OWNER_RE,
    'owner',
  );
  const repo = normalizeGithubSegment(
    p.repository?.name ?? p.repository?.full_name?.split('/')[1],
    REPO_RE,
    'repo',
  );
  const number = p.issue?.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error('issues.opened payload missing owner/repo/number');
  }
  return { owner, repo, number };
}

function normalizeGithubSegment(
  value: string | undefined,
  pattern: RegExp,
  label: string,
): string {
  const normalized = value?.trim();
  if (!normalized || !pattern.test(normalized)) {
    throw new Error(`issues.opened payload has invalid ${label}`);
  }
  return normalized;
}

function labelNames(p: GithubIssuePayload): string[] {
  return (p.issue?.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function workflowNameFor(t: IssueTarget): string {
  return `resolve-issue-${t.repo}-${t.number}`;
}

async function notifySlack(
  ctx: WorkforceCtx,
  text: string,
): Promise<void> {
  if (!ctx.slack) throw new Error('slack integration required');
  const user = process.env.PROACTIVE_SLACK_USER?.trim();
  const channel = process.env.PROACTIVE_SLACK_CHANNEL?.trim();
  if (user) {
    await ctx.slack.dm(user, text);
    return;
  }
  if (channel) {
    await ctx.slack.post(channel, text);
    return;
  }
  throw new Error('Set PROACTIVE_SLACK_USER (DM) or PROACTIVE_SLACK_CHANNEL (post)');
}

async function claimViaLabel(
  ctx: WorkforceCtx,
  t: IssueTarget,
): Promise<'claimed' | 'already-claimed'> {
  const claimStartedAt = Date.now() - 1000;
  const repo = shellQuote(`${t.owner}/${t.repo}`);
  const add = await ctx.sandbox.exec(
    `gh issue edit ${t.number} --repo ${repo} --add-label ${shellQuote(CLAIM_LABEL)}`,
  );
  if (add.exitCode !== 0) {
    throw new Error(`gh issue edit failed: ${add.output}`);
  }

  await sleep(1500);

  const timelinePath = shellQuote(`repos/${t.owner}/${t.repo}/issues/${t.number}/timeline`);
  const timeline = await ctx.sandbox.exec(
    `gh api ${timelinePath} -H ${shellQuote('Accept: application/vnd.github+json')} --paginate`,
  );
  if (timeline.exitCode !== 0) {
    throw new Error(`gh issue timeline verification failed: ${timeline.output}`);
  }

  const labelEvents = parseTimeline(timeline.output)
    .filter((event) => event.event === 'labeled' && event.label?.name === CLAIM_LABEL)
    .sort((a, b) => Date.parse(a.created_at ?? '') - Date.parse(b.created_at ?? ''));
  const firstClaim = labelEvents[0];
  const firstClaimTime = Date.parse(firstClaim?.created_at ?? '');
  if (!firstClaim || !Number.isFinite(firstClaimTime) || firstClaimTime < claimStartedAt) {
    return 'already-claimed';
  }

  const lockAcquired = await createIssueLockRef(ctx, t);
  if (!lockAcquired) return 'already-claimed';

  return 'claimed';
}

async function createIssueLockRef(ctx: WorkforceCtx, t: IssueTarget): Promise<boolean> {
  const repoPath = shellQuote(`repos/${t.owner}/${t.repo}`);
  const defaultBranchResult = await ctx.sandbox.exec(
    `gh api ${repoPath} --jq ${shellQuote('.default_branch')}`,
  );
  if (defaultBranchResult.exitCode !== 0) {
    throw new Error(`gh repo lookup failed: ${defaultBranchResult.output}`);
  }
  const defaultBranch = defaultBranchResult.output.trim();
  if (!defaultBranch) {
    throw new Error('gh repo lookup did not return a default branch');
  }

  const defaultRefPath = shellQuote(
    `repos/${t.owner}/${t.repo}/git/ref/heads/${defaultBranch}`,
  );
  const baseShaResult = await ctx.sandbox.exec(
    `gh api ${defaultRefPath} --jq ${shellQuote('.object.sha')}`,
  );
  if (baseShaResult.exitCode !== 0) {
    throw new Error(`gh default branch lookup failed: ${baseShaResult.output}`);
  }
  const baseSha = baseShaResult.output.trim();
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) {
    throw new Error('gh default branch lookup did not return a commit sha');
  }

  const lockRef = `refs/heads/agentworkforce/locks/ricky-issue-${t.number}`;
  const create = await ctx.sandbox.exec(
    `gh api ${shellQuote(`repos/${t.owner}/${t.repo}/git/refs`)} -X POST -f ${shellQuote(`ref=${lockRef}`)} -f ${shellQuote(`sha=${baseSha}`)}`,
  );
  if (create.exitCode === 0) return true;
  if (/Reference already exists|already_exists/i.test(create.output)) return false;
  throw new Error(`gh lock ref create failed: ${create.output}`);
}

function parseTimeline(output: string): Array<{
  event?: string;
  created_at?: string;
  label?: { name?: string };
}> {
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpecOutput(output: string): string {
  let spec = output.replace(/^\uFEFF/, '').trimStart();
  const fenced = spec.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i);
  if (fenced) {
    spec = fenced[1].trimStart();
  }
  return spec.trim();
}

function buildInvestigatePrompt(t: IssueTarget, p: GithubIssuePayload, labels: string[]): string {
  const title = p.issue?.title ?? '(untitled)';
  const body = p.issue?.body ?? '';
  const reporter = p.issue?.user?.login ?? 'unknown';
  return [
    `You are producing an implementation spec for an automated workflow runner (Ricky).`,
    `Repo: ${t.owner}/${t.repo}`,
    `Issue #${t.number}: ${title}`,
    `Reporter: ${reporter}`,
    `Labels: ${labels.join(', ') || '(none)'}`,
    ``,
    `--- Issue body ---`,
    body || '(empty)',
    `--- End issue body ---`,
    ``,
    `Investigate the repository (read source, run greps, inspect tests) and write a spec.md with these sections, in order:`,
    ``,
    `# Spec: Resolve #${t.number} — ${title}`,
    ``,
    `## Problem`,
    `(2-4 sentences: what the issue is actually asking for, restated precisely.)`,
    ``,
    `## Proposed approach`,
    `(Concrete change. Name the files to edit and the shape of the diff. No prose hand-waving.)`,
    ``,
    `## Files to touch`,
    `(Bulleted list of paths with one-line reason each.)`,
    ``,
    `## Acceptance`,
    `(Bulleted, mechanical checks: what tests pass, what command outputs change, what the diff must include / must not include.)`,
    ``,
    `## Out of scope`,
    `(Bulleted: things tempting but deferred.)`,
    ``,
    `## PR shipping requirement`,
    `The generated workflow MUST open a pull request using @agent-relay/github-primitive (createGitHubStep with action createPR) against ${t.owner}/${t.repo}. Title the PR "Fix #${t.number}: ${title}" and include "Closes #${t.number}" in the body.`,
    ``,
    `Output ONLY the spec markdown. No preamble, no closing remarks.`,
  ].join('\n');
}

function extractPrUrl(result: unknown): string | null {
  // LocalResponse has no top-level prUrl; scan everything that could carry it.
  if (typeof result !== 'object' || result === null) return null;
  const r = result as {
    logs?: unknown;
    warnings?: unknown;
    nextActions?: unknown;
    execution?: unknown;
    artifacts?: unknown;
  };
  const candidates: string[] = [];
  const pushAll = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') candidates.push(item);
      }
    }
  };
  pushAll(r.logs);
  pushAll(r.warnings);
  pushAll(r.nextActions);
  // Serialize execution + artifacts to catch URLs in evidence / step output.
  try { candidates.push(JSON.stringify(r.execution ?? {})); } catch { /* ignore */ }
  try { candidates.push(JSON.stringify(r.artifacts ?? [])); } catch { /* ignore */ }
  for (const c of candidates) {
    const m = c.match(/https:\/\/github\.com\/[^\s"'`]+\/pull\/\d+/);
    if (m) return m[0];
  }
  return null;
}

function useCloud(): boolean {
  return process.env.PROACTIVE_USE_CLOUD?.trim().toLowerCase() === 'true';
}

interface DispatchOutcome {
  prUrl: string | null;
  failureDetail: string;
  raw: unknown;
}

async function dispatchToRicky(
  cwd: string,
  spec: string,
  target: IssueTarget,
): Promise<DispatchOutcome> {
  const ricky = createRickySdk({ cwd });
  const workflowName = workflowNameFor(target);

  if (useCloud()) {
    const token = process.env.AGENTWORKFORCE_TOKEN?.trim();
    const workspaceId = process.env.AGENTWORKFORCE_WORKSPACE_ID?.trim();
    if (!token || !workspaceId) {
      throw new Error(
        'cloud dispatch requires AGENTWORKFORCE_TOKEN and AGENTWORKFORCE_WORKSPACE_ID',
      );
    }
    const request: CloudGenerateRequest = {
      auth: { token, tokenType: 'bearer' },
      workspace: { workspaceId },
      body: {
        spec: { kind: 'natural-language', text: spec },
        mode: 'cloud',
        generationMode: 'generate-and-run',
        autoFix: { enabled: true, maxAttempts: 3 },
        metadata: { workflowName, target },
      },
    };
    const response: CloudGenerateResponse = await ricky.generateCloudWorkflow(request);
    return {
      prUrl: extractPrUrl(response),
      failureDetail: summarizeFailure(response),
      raw: response,
    };
  }

  const response: LocalResponse = await ricky.generateLocalWorkflow({
    spec,
    workflowName,
    run: true,
    autoFixAttempts: 3,
    bestJudgement: false,
  });
  return {
    prUrl: extractPrUrl(response),
    failureDetail: summarizeFailure(response),
    raw: response,
  };
}

function summarizeFailure(result: unknown): string {
  if (typeof result !== 'object' || result === null) return 'no result detail';
  const r = result as {
    ok?: boolean;
    exitCode?: number;
    warnings?: string[];
    execution?: { blocker?: { code?: string; message?: string }; status?: string };
    auto_fix?: { final_status?: string; max_attempts?: number; attempts?: unknown[] };
    artifacts?: Array<{ path?: string }>;
  };
  const parts: string[] = [];
  parts.push(`ok=${String(r.ok ?? false)} exitCode=${r.exitCode ?? '?'}`);
  if (r.execution?.status) parts.push(`execution.status=${r.execution.status}`);
  if (r.execution?.blocker) {
    parts.push(`blocker=${r.execution.blocker.code}: ${r.execution.blocker.message}`);
  }
  if (r.auto_fix?.final_status) {
    const tries = Array.isArray(r.auto_fix.attempts) ? r.auto_fix.attempts.length : '?';
    parts.push(`auto_fix=${r.auto_fix.final_status} (${tries} attempts)`);
  }
  if (r.warnings?.length) parts.push(`warnings: ${r.warnings.slice(0, 3).join(' | ')}`);
  const firstArtifact = r.artifacts?.[0]?.path;
  if (firstArtifact) parts.push(`artifact: ${firstArtifact}`);
  return parts.join('\n');
}

export default defineAgent({
  triggers: { github: [{ on: 'issues.opened' }] },
  handler: async (ctx, event) => {
  // Only react to newly opened GitHub issues.
  if (event.source !== 'github') return;
  if (event.type !== 'issues.opened') return;

  const p = asPayload(event.payload);
  if (p.action && p.action !== 'opened') return;

  if (!ctx.github) throw new Error('proactive-issue-resolver requires the github integration');
  if (!ctx.slack) throw new Error('proactive-issue-resolver requires the slack integration');

  const target = targetFromPayload(p);
  const labels = labelNames(p);
  if (labels.includes(CLAIM_LABEL)) return; // already in flight

  // 1. Claim via label, then acquire a deterministic Git ref lock so concurrent
  //    deliveries cannot both dispatch Ricky for the same issue.
  const claim = await claimViaLabel(ctx, target);
  if (claim === 'already-claimed') return;

  await ctx.github.comment(
    target,
    `:robot: Proactive agent picked up #${target.number}. Investigating and handing to Ricky.`,
  );

  // 2. Investigate — claude harness with the persona's systemPrompt.
  const investigation = await ctx.harness.run({
    prompt: buildInvestigatePrompt(target, p, labels),
    cwd: ctx.sandbox.cwd,
  });

  const spec = normalizeSpecOutput(investigation.output);
  const specHeader = spec.split(/\r?\n/).slice(0, 5).join('\n');
  if (investigation.exitCode !== 0 || !/^#\s+Spec:/m.test(specHeader)) {
    const msg = `:warning: Could not produce a valid spec for #${target.number} (harness exit ${investigation.exitCode}). Aborting.`;
    await ctx.github.comment(target, msg);
    await notifySlack(ctx, `${msg}\nIssue: ${p.issue?.html_url ?? ''}`);
    return;
  }

  // Persist a copy of the spec for debugging. Best-effort.
  const specPath = path.join(ctx.sandbox.cwd, '.proactive', `issue-${target.number}-spec.md`);
  try {
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, spec, 'utf8');
  } catch {
    // not fatal
  }

  // 3. Hand to Ricky. Local path runs `generateLocalWorkflow` with run: true
  //    so the generated workflow opens the PR via @agent-relay/github-primitive.
  //    Cloud path (PROACTIVE_USE_CLOUD=true) calls `generateCloudWorkflow`
  //    instead; today that returns the cloud executor's not-wired stub, which
  //    surfaces as a hard fail through the same Slack path.
  const outcome = await dispatchToRicky(ctx.sandbox.cwd, spec, target);

  // 4. Terminal notification.
  const issueUrl = p.issue?.html_url ?? '';
  if (outcome.prUrl) {
    const msg = `:white_check_mark: Issue #${target.number} (${target.owner}/${target.repo}): PR opened\n${outcome.prUrl}\nIssue: ${issueUrl}`;
    await ctx.github.comment(target, `:white_check_mark: PR opened by Ricky: ${outcome.prUrl}`);
    await notifySlack(ctx, msg);
  } else {
    const msg = `:x: Issue #${target.number} (${target.owner}/${target.repo}): Ricky run did not produce a PR.\n${outcome.failureDetail}\nIssue: ${issueUrl}`;
    await ctx.github.comment(target, `:x: Ricky did not produce a PR for #${target.number}.\n\n\`\`\`\n${outcome.failureDetail}\n\`\`\``);
    await notifySlack(ctx, msg);
  }
  }
});
