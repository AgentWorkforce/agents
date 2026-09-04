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

type LinearIssueEvent = {
  issue?: { id?: string; identifier?: string; title?: string; url?: string };
};

interface LinearIssueFile {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  [key: string]: unknown;
}

function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

function inputDefault(ctx: WorkforceCtx, name: string): string {
  // Mirror `resolvePersonaInputs` precedence (packages/persona-kit/src/inputs.ts):
  // explicit env var (spec.env ?? input name) wins over the runtime-resolved
  // value, which in turn wins over the static spec default.
  const spec = ctx.persona.inputSpecs?.[name];
  const envName = spec?.env ?? name;
  const fromEnv = process.env[envName];
  const value =
    (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ??
    ctx.persona.inputs?.[name] ??
    spec?.default;
  if (!value) throw new Error(`${name} input is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeRepoDirName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('GITHUB_REPO must be a repository name, not a path or shell fragment');
  }
  return value;
}

export default defineAgent({
  triggers: { linear: [{ on: 'issue.created' }] },
  handler: async (ctx, event) => {
  if (event.type !== 'linear.issue.created') return;

  const data = (await event.expand('full')).data;
  const payload =
    typeof data === 'object' && data !== null
      ? (data as LinearIssueEvent)
      : {};
  const issueRef = payload.issue;
  const issueId = issueRef?.id ?? issueRef?.identifier;
  if (!issueId) throw new Error('Linear event is missing an issue id');

  const client = vfsClient();
  const issue = await readJsonFile<LinearIssueFile>(
    client,
    'linear',
    'getIssue',
    `/linear/issues/${encodeSegment(issueId)}.json`
  );

  const repoUrl = inputDefault(ctx, 'REPO_URL');
  const owner = inputDefault(ctx, 'GITHUB_OWNER');
  const repo = safeRepoDirName(inputDefault(ctx, 'GITHUB_REPO'));
  const repoDir = `${ctx.sandbox.cwd}/${repo}`;

  await ctx.sandbox.exec(`git clone ${shellQuote(repoUrl)} ${shellQuote(repoDir)}`);
  const result = await ctx.harness.run({
    prompt: `Implement this Linear issue. Create the smallest reviewable change and include verification notes.\n\nTitle: ${issue.title ?? ''}\n\n${issue.description ?? ''}`,
    cwd: repoDir
  });

  // No createPullRequest writeback path yet — fall back to a placeholder issue
  // so the workflow stays observable end-to-end.
  const created = await writeJsonFile(
    client,
    'github',
    'createIssue',
    `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${draftFile('create issue')}`,
    {
      title: `Draft PR needed: ${issue.title ?? issueId}`,
      body: [
        `Linear issue: ${issue.url ?? issueId}`,
        '',
        'Implementation attempt captured below; the github createPullRequest writeback is not exposed yet.',
        '',
        result.output
      ].join('\n')
    }
  );

  // Only post a back-link comment when writeback returned a real receipt —
  // surfacing the in-mount draft path as if it were a clickable issue URL
  // would be misleading.
  const issueUrl = created.receipt?.url;
  if (!issueUrl) {
    ctx.log('warn', 'linear-shipper.github-issue.no-receipt', { draftPath: created.path });
    return;
  }
  await writeJsonFile(
    client,
    'linear',
    'comment',
    `/linear/issues/${encodeSegment(issueId)}/comments/${draftFile('comment')}`,
    {
      body: `Implementation attempt captured in GitHub issue: ${issueUrl}`
    }
  );
  }
});
