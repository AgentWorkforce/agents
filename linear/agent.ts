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
import { handler } from '@agentworkforce/runtime';

export default handler(async (ctx, event) => {
  if (event.source !== 'linear') return;
  if (!ctx.linear) throw new Error('linear-implementer requires the linear integration');

  const issueId = readIssueId(event.payload);
  if (!issueId) return;
  const issue = await ctx.linear.getIssue(issueId);

  // The issue may name its own target repo (a github URL or `owner/repo`); if
  // so, tell the agent to work there — otherwise it uses the materialized repo.
  const repo = parseRepo(issue);

  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd, // repo(s) materialized by the cloud via relayfile — no clone
    prompt: [
      'Implement this Linear issue, then open a GitHub pull request with `gh`.',
      repo ? `The target repository is \`${repo}\` — work in that checkout.` : '',
      'Keep the change small and reviewable. Put the PR URL on the last line.',
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
});

/** Linear webhooks carry the issue under `data.id`; some shapes use `issue.id`. */
function readIssueId(payload: unknown): string | undefined {
  const p = payload as { data?: { id?: string }; issue?: { id?: string } } | null;
  return p?.data?.id ?? p?.issue?.id;
}
function findPrUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S*github\.com\/\S+\/pull\/\d+/g)?.pop();
}
/** Pull an `owner/repo` out of the issue — a github URL or a bare slug. */
function parseRepo(issue: { title: string; description: string | null }): string | undefined {
  const text = `${issue.title}\n${issue.description ?? ''}`;
  const url = text.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git|[)\s/]|$)/i);
  if (url) return url[1];
  return text.match(/(?:^|\s)([\w.-]+\/[\w.-]+)(?:\s|$)/)?.[1];
}
