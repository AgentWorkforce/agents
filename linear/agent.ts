/**
 * linear-implementer handler.
 *
 *   a Linear issue.create / comment.create event fires
 *     → fetch the issue
 *     → hand it to the coding agent to implement + open a PR
 *     → comment the PR link back on the Linear issue
 *
 * The repo is already in the sandbox: the cloud materializes the github
 * integration's repo into ctx.sandbox.cwd via relayfile, so there's no clone.
 */
import { defineAgent, type WorkforceCtx } from '@agentworkforce/runtime';

export default defineAgent({
  // Two Linear triggers — `on` autocompletes Linear's catalog events.
  triggers: {
    linear: [
      { on: 'issue.create', match: 'agentrelay' }, // new issues labelled "agentrelay"
      { on: 'comment.create' } // …or a comment that @-mentions the agent (handler enforces MENTION + skips its own replies)
    ]
  },
  handler: async (ctx, event) => {
  if (event.source !== 'linear') return;
  if (!ctx.linear) throw new Error('linear-implementer requires the linear integration');

  // The comment path only fires when someone @-mentions the agent (configurable
  // via MENTION, e.g. "@agentrelay") — and never on the agent's own reply.
  if (event.type === 'comment.create') {
    if (isOwnComment(event.payload) || !commentMentionsAgent(ctx, event.payload)) return;
  }

  const issueId = readIssueId(event.payload);
  if (!issueId) return;
  const issue = await ctx.linear.getIssue(issueId);

  // The issue may name its own target repo (a github URL); if so, tell the agent
  // to work there — otherwise it uses the materialized repo.
  const repo = parseRepo(issue);

  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd, // repo materialized by the cloud via relayfile — no clone, no gh/git
    prompt: [
      'Comprehensively implement this Linear issue — make every change needed to fully resolve it, not a partial fix.',
      repo ? `The target repository is \`${repo}\`.` : '',
      'Then open a GitHub pull request with your changes (the GitHub integration opens it; do not use git or the `gh` CLI). Put the PR URL on the last line.',
      '',
      `# ${issue.title}`,
      issue.description ?? ''
    ].filter(Boolean).join('\n')
  });

  const prUrl = findPrUrl(run.output);
  await ctx.linear.comment(
    issueId,
    prUrl ? `:rocket: Opened a PR: ${prUrl}` : "I worked on this but couldn't open a PR — check the run logs."
  );
  }
});

/** The issue id for this event. For `comment.create`, `data.id` is the COMMENT
 *  id, so prefer issue-specific fields and only fall back to `data.id`
 *  (which is the issue id for `issue.create`). */
function readIssueId(payload: unknown): string | undefined {
  const p = payload as {
    data?: { id?: string; issueId?: string; issue?: { id?: string } };
    issue?: { id?: string };
  } | null;
  return p?.data?.issueId ?? p?.data?.issue?.id ?? p?.issue?.id ?? p?.data?.id;
}
function commentBody(payload: unknown): string {
  const p = payload as { data?: { body?: string }; comment?: { body?: string } } | null;
  return p?.data?.body ?? p?.comment?.body ?? '';
}
/** True if a comment event is the agent's own PR-link reply (loop guard). */
function isOwnComment(payload: unknown): boolean {
  const body = commentBody(payload);
  return body.includes('Opened a PR') || body.includes("couldn't open a PR");
}
/** Only act on a comment that @-mentions the agent (e.g. "@agentrelay"). */
function commentMentionsAgent(ctx: WorkforceCtx, payload: unknown): boolean {
  const mention = input(ctx, 'MENTION') ?? '@agentrelay';
  return commentBody(payload).toLowerCase().includes(mention.toLowerCase());
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
function findPrUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S*github\.com\/\S+\/pull\/\d+/g)?.pop();
}
/** A github repo named in the issue, e.g. `https://github.com/owner/repo`.
 *  Only matches explicit github URLs — a bare `owner/repo` is too ambiguous
 *  (it would catch phrases like "client/server"). */
function parseRepo(issue: { title: string; description: string | null }): string | undefined {
  const text = `${issue.title}\n${issue.description ?? ''}`;
  return text.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git|[)\s/]|$)/i)?.[1];
}
