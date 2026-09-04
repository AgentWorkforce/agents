import {
  defineAgent,
  draftFile,
  encodeSegment,
  readJsonFile,
  resolveMountRoot,
  writeJsonFile,
  type IntegrationClientOptions,
  type WorkforceCtx
} from '@agentworkforce/runtime';

type GithubTarget = { owner: string; repo: string; number: number };

function vfsClient(): IntegrationClientOptions {
  // Resolve the Relayfile mount the cloud-managed runtime exposes through
  // env (RELAYFILE_MOUNT_ROOT / RELAYFILE_ROOT). Falls back to process.cwd()
  // for local smoke runs.
  return { relayfileMountRoot: resolveMountRoot({}) };
}

function payloadOf(eventPayload: unknown): Record<string, unknown> {
  return typeof eventPayload === 'object' && eventPayload !== null
    ? (eventPayload as Record<string, unknown>)
    : {};
}

function githubTarget(event: Record<string, unknown>): GithubTarget {
  const repository = event.repository as {
    owner?: string | { login?: string };
    name?: string;
    full_name?: string;
  } | undefined;
  const pullRequest = event.pull_request as { number?: number } | undefined;
  const issue = event.issue as { number?: number } | undefined;
  const checkRun = event.check_run as { pull_requests?: Array<{ number?: number }> } | undefined;
  const owner = typeof repository?.owner === 'string'
    ? repository.owner
    : repository?.owner?.login ?? repository?.full_name?.split('/')[0];
  const repo = repository?.name ?? repository?.full_name?.split('/')[1];
  const checkRunPullRequest = checkRun?.pull_requests?.find((pr) => typeof pr.number === 'number');
  const number = pullRequest?.number ?? issue?.number ?? checkRunPullRequest?.number ?? Number(event.number);
  if (!owner || !repo || !Number.isFinite(number)) {
    throw new Error('GitHub event is missing owner, repo, or number');
  }
  return { owner, repo, number };
}

function prMetaPath({ owner, repo, number }: GithubTarget): string {
  return `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls/${number}.json`;
}

function issueCommentDraftPath({ owner, repo, number }: GithubTarget): string {
  return `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${number}/comments/${draftFile('comment')}`;
}

function reviewDraftPath({ owner, repo, number }: GithubTarget): string {
  return `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls/${number}/reviews/${draftFile('review')}`;
}

function slackReplyDraftPath(channel: string, threadTs: string): string {
  return `/slack/channels/${encodeSegment(channel)}/messages/${encodeSegment(threadTs)}/reply/${draftFile('reply')}`;
}

interface GithubPrMeta {
  title?: string;
  body?: string;
  author?: string;
  base?: string;
  head?: string;
  diff?: string;
  [key: string]: unknown;
}

async function reviewPullRequest(ctx: WorkforceCtx, event: Record<string, unknown>) {
  const target = githubTarget(event);
  const client = vfsClient();
  const pr = await readJsonFile<GithubPrMeta>(client, 'github', 'getPr', prMetaPath(target));
  const result = await ctx.harness.run({
    prompt: `Review this PR for correctness, risk, and missing tests.\n\nTitle: ${pr.title ?? ''}\nAuthor: ${pr.author ?? ''}\nBase: ${pr.base ?? ''}\nHead: ${pr.head ?? ''}\n\n${pr.diff ?? ''}`,
    cwd: ctx.sandbox.cwd
  });
  await writeJsonFile(client, 'github', 'postReview', reviewDraftPath(target), {
    body: result.output,
    event: 'COMMENT'
  });
}

async function replyToGithubMention(ctx: WorkforceCtx, event: Record<string, unknown>) {
  const target = githubTarget(event);
  const comment = event.comment as { body?: string } | undefined;
  const result = await ctx.harness.run({
    prompt: `Reply to this GitHub discussion in context. Keep it specific and actionable.\n\n${comment?.body ?? ''}`,
    cwd: ctx.sandbox.cwd
  });
  await writeJsonFile(vfsClient(), 'github', 'comment', issueCommentDraftPath(target), {
    body: result.output
  });
}

async function handleFailedCheck(ctx: WorkforceCtx, event: Record<string, unknown>) {
  const checkRun = event.check_run as { conclusion?: string; output?: { title?: string; summary?: string } } | undefined;
  if (checkRun?.conclusion !== 'failure') return;
  const target = githubTarget(event);
  const result = await ctx.harness.run({
    prompt: `CI failed. Inspect the failure and propose the smallest safe fix.\n\n${checkRun.output?.title ?? ''}\n\n${checkRun.output?.summary ?? ''}`,
    cwd: ctx.sandbox.cwd
  });
  await writeJsonFile(vfsClient(), 'github', 'comment', issueCommentDraftPath(target), {
    body: result.output
  });
}

async function replyInSlack(ctx: WorkforceCtx, event: Record<string, unknown>) {
  const text = typeof event.text === 'string' ? event.text : '';
  const channel = typeof event.channel === 'string' ? event.channel : '';
  const ts = typeof event.threadTs === 'string'
    ? event.threadTs
    : typeof event.thread_ts === 'string'
      ? event.thread_ts
      : typeof event.ts === 'string'
        ? event.ts
        : '';
  if (!channel || !ts) throw new Error('Slack app_mention event is missing channel or thread timestamp');
  const memories = await ctx.memory.recall(text, { limit: 5 });
  const result = await ctx.harness.run({
    prompt: `Answer this Slack mention using the remembered context when useful.\n\nContext:\n${JSON.stringify(memories)}\n\nMessage:\n${text}`,
    cwd: ctx.sandbox.cwd
  });
  await writeJsonFile(vfsClient(), 'slack', 'reply', slackReplyDraftPath(channel, ts), {
    text: result.output
  });
  await ctx.memory.save(`Slack mention handled: ${text.slice(0, 180)}`, {
    tags: ['slack', 'review-agent'],
    scope: 'workspace'
  });
}

export default defineAgent({
  triggers: {
    github: [
      { on: 'pull_request.opened' },
      { on: 'issue_comment.created', match: '@mention' },
      { on: 'pull_request_review_comment.created', match: '@mention' },
      { on: 'check_run.completed', where: 'conclusion=failure' }
    ],
    slack: [{ on: 'app_mention' }]
  },
  handler: async (ctx, event) => {
    if (event.type.startsWith('github.')) {
      const payload = payloadOf((await event.expand('full')).data);
      if (event.type === 'github.pull_request.opened') {
        await reviewPullRequest(ctx, payload);
        return;
      }
      if (event.type === 'github.issue_comment.created' || event.type === 'github.pull_request_review_comment.created') {
        await replyToGithubMention(ctx, payload);
        return;
      }
      if (event.type === 'github.check_run.completed') {
        await handleFailedCheck(ctx, payload);
        return;
      }
    }

    if (event.type === 'slack.app_mention') {
      await replyInSlack(ctx, payloadOf((await event.expand('full')).data));
    }
  }
});
