import {
  defineAgent,
  draftFile,
  encodeSegment,
  resolveMountRoot,
  writeJsonFile,
  type IntegrationClientOptions,
  type WorkforceCtx,
  type WorkforceEvent
} from '@agentworkforce/runtime';

interface NotionPageCreatedPayload {
  pageId?: string;
  page_id?: string;
  id?: string;
  title?: string;
  page?: {
    id?: string;
    title?: string;
  };
}

interface RepoTarget {
  owner: string;
  repo: string;
}

function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

export default defineAgent({
  triggers: { notion: [{ on: 'page.created' }] },
  handler: async (ctx, event) => {
  if (event.type !== 'notion.page.created') {
    ctx.log('debug', 'notion-essay-pr.ignored', {
      type: event.type
    });
    return;
  }
  await handleNotionPageCreated(ctx, event);
  }
});

async function handleNotionPageCreated(ctx: WorkforceCtx, event: WorkforceEvent): Promise<void> {
  const payload = readPayload((await event.expand('full')).data);
  const pageId = pageIdFrom(payload);
  const pageTitle = pageTitleFrom(payload, event.summary?.title);
  const pagePath = `/notion/pages/${encodeURIComponent(pageId)}.md`;
  const outputPath = `/workspace/output/${safeFileSegment(pageId)}.md`;
  const repoTarget = splitRepo(ctx.persona.inputs.GITHUB_TARGET_REPO);

  const pageContent = await ctx.files.read(pagePath);
  const memories = await ctx.memory.recall(pageTitle, { scope: 'workspace', limit: 5 });
  const essay = await draftEssay(ctx, {
    pageTitle,
    pageContent,
    memoryContext: memories.map((m) => m.content)
  });

  await ctx.files.write(outputPath, essay);
  const branch = `essay/${safeBranchSegment(pageId)}`;
  const pr = await writeJsonFile(
    vfsClient(),
    'github',
    'createPullRequest',
    `/github/repos/${encodeSegment(repoTarget.owner)}/${encodeSegment(repoTarget.repo)}/pulls/${draftFile('create pr')}`,
    {
      title: `Essay: ${pageTitle}`,
      body: `Drafted from Notion page ${pageId}.\n\nOutput: ${outputPath}`,
      head: branch,
      base: 'main',
      files: {
        [`output/${safeFileSegment(pageId)}.md`]: essay
      }
    }
  );

  // Only treat the PR as "opened" when the writeback worker returned a
  // receipt with a real GitHub URL — `pr.path` is the in-mount draft and
  // would mislead anyone who saw it in memory or logs.
  const prUrl = pr.receipt?.url;
  if (!prUrl) {
    ctx.log('warn', 'notion-essay-pr.pr-pending', {
      pageId,
      pageTitle,
      outputPath,
      draftPath: pr.path
    });
    return;
  }

  await ctx.memory.save(`Notion essay PR opened for ${pageTitle}: ${prUrl}`, {
    scope: 'workspace',
    tags: ['notion-essay-pr', `page:${pageId}`]
  });

  ctx.log('info', 'notion-essay-pr.pr-created', {
    pageId,
    pageTitle,
    outputPath,
    prUrl
  });
}

async function draftEssay(
  ctx: WorkforceCtx,
  args: { pageTitle: string; pageContent: string; memoryContext: string[] }
): Promise<string> {
  const result = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: [
      `Draft a polished markdown essay from this Notion page.`,
      `Title: ${args.pageTitle}`,
      '',
      'Relevant workspace memory:',
      args.memoryContext.length > 0 ? args.memoryContext.map((m) => `- ${m}`).join('\n') : '- none',
      '',
      'Page content:',
      args.pageContent,
      '',
      'Return only markdown for the essay.'
    ].join('\n')
  });
  const essay = result.output.trim();
  if (!essay) {
    throw new Error('notion-essay-pr: harness returned an empty essay');
  }
  return essay.endsWith('\n') ? essay : `${essay}\n`;
}

function readPayload(payload: unknown): NotionPageCreatedPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
  return payload as NotionPageCreatedPayload;
}

function pageIdFrom(payload: NotionPageCreatedPayload): string {
  const id = payload.pageId ?? payload.page_id ?? payload.page?.id ?? payload.id;
  if (!id?.trim()) throw new Error('notion-essay-pr: page.created payload is missing pageId');
  return id.trim();
}

function pageTitleFrom(payload: NotionPageCreatedPayload, summaryTitle: string | undefined): string {
  return (
    payload.title?.trim() ??
    payload.page?.title?.trim() ??
    summaryTitle?.trim() ??
    'Untitled Notion page'
  );
}

function splitRepo(value: string | undefined): RepoTarget {
  const parts = value?.split('/') ?? [];
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) {
    throw new Error('notion-essay-pr: GITHUB_TARGET_REPO must be owner/repo');
  }
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

function safeBranchSegment(value: string): string {
  return safeFileSegment(value).toLowerCase().slice(0, 80);
}
