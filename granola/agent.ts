/**
 * granola-prospect handler.
 *
 *   a new Granola note syncs in (storage `file.created` at /granola/notes/…)
 *     → read the note's transcript from the VFS
 *     → ask the model "is this a prospect call, and what did they ask for?"
 *     → if yes: file a Linear issue, then have the coding agent open a PR for it
 */
import { handler, type WorkforceCtx } from '@agentworkforce/runtime';

interface Ask {
  isProspect: boolean;
  title: string;
  summary: string;
}

export default handler(async (ctx, event) => {
  // Notes arrive via the Nango sync as storage events; the clock isn't one.
  if (event.source === 'cron') return;

  const notePath = readNotePath(event.payload);
  if (!notePath || !notePath.includes('/granola/notes/')) return; // ignore folders/other writes
  if (!ctx.linear) throw new Error('granola-prospect requires the linear integration');

  const transcript = await readNote(ctx, notePath);
  if (!transcript) return;

  const ask = await classify(ctx, transcript);
  if (!ask.isProspect) {
    ctx.log('info', 'granola-prospect.not-a-prospect', {});
    return;
  }

  const teamId = await resolveTeamId(ctx);
  const issue = await ctx.linear.createIssue({ teamId, title: ask.title, description: ask.summary });
  ctx.log('info', 'granola-prospect.issue-created', { url: issue.url });

  // The cloud materializes the github repo into the sandbox (ctx.sandbox.cwd)
  // via relayfile — no clone, no gh/git. The GitHub integration opens the PR.
  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd,
    prompt: `A prospect asked for the following. Comprehensively implement it (every change needed to fully address the ask), then open a GitHub pull request with your changes — the GitHub integration opens it, do not use git or the \`gh\` CLI. Put the PR URL on the last line.\n\nLinear issue: ${issue.url}\n\n${ask.summary}`
  });

  const prUrl = run.output.match(/https?:\/\/\S*\/pull\/\d+/g)?.pop();
  if (prUrl) await ctx.linear.comment(issue.id, `:rocket: Implementation PR: ${prUrl}`);
});

/** A storage `file.created` event carries the VFS path of the file that landed. */
function readNotePath(payload: unknown): string | undefined {
  const p = payload as { path?: string; relayfilePath?: string; data?: { path?: string } } | null;
  return p?.path ?? p?.relayfilePath ?? p?.data?.path;
}

/** Read the synced note JSON and pull out its transcript / content text. */
async function readNote(ctx: WorkforceCtx, path: string): Promise<string | undefined> {
  try {
    const note = JSON.parse(await ctx.files.read(path)) as {
      transcript?: string;
      content?: string;
      summary?: string;
    };
    return note.transcript ?? note.content ?? note.summary;
  } catch {
    return undefined;
  }
}

async function classify(ctx: WorkforceCtx, transcript: string): Promise<Ask> {
  const prompt = [
    'Read this meeting transcript. Decide if it is a sales/prospect call where the',
    'prospect asked for a feature or change. Reply with JSON only:',
    '{"isProspect": boolean, "title": "short issue title", "summary": "what they asked for"}',
    '',
    transcript.slice(0, 8000)
  ].join('\n');
  try {
    // Models often wrap JSON in ```json fences — strip them before parsing.
    const raw = (await ctx.llm.complete(prompt, { maxTokens: 400 })).replace(/```json\s*|```/g, '').trim();
    return JSON.parse(raw) as Ask;
  } catch {
    return { isProspect: false, title: '', summary: '' };
  }
}

/**
 * Which Linear team to file under. An explicit LINEAR_TEAM_ID wins; otherwise
 * we auto-pick when the `fetch-teams` sync shows exactly one team, and block
 * (with a helpful list) when it's ambiguous.
 */
async function resolveTeamId(ctx: WorkforceCtx): Promise<string> {
  const configured = input(ctx, 'LINEAR_TEAM_ID');
  if (configured) return configured;

  const teams = await listLinearTeams(ctx);
  if (teams.length === 1) return teams[0].id;

  const found = teams.length ? ` Teams: ${teams.map((t) => `${t.name} (${t.id})`).join(', ')}.` : '';
  throw new Error(
    `Can't pick a Linear team automatically — found ${teams.length}. Set LINEAR_TEAM_ID.${found}`
  );
}

/** Linear teams the `fetch-teams` sync materialized at /linear/teams/*.json. */
async function listLinearTeams(ctx: WorkforceCtx): Promise<Array<{ id: string; name: string }>> {
  const root = process.env.RELAYFILE_MOUNT_ROOT?.replace(/\/$/, '') ?? '';
  const { output } = await ctx.sandbox.exec(
    `find ${root}/linear/teams -maxdepth 1 -name '*.json' -not -name '_index.json' 2>/dev/null || true`
  );
  const teams: Array<{ id: string; name: string }> = [];
  for (const file of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const t = JSON.parse(await ctx.files.read(file)) as { id?: string; name?: string };
      if (t.id) teams.push({ id: t.id, name: t.name ?? t.id });
    } catch {
      /* skip unreadable entries */
    }
  }
  return teams;
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
