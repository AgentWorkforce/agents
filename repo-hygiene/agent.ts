/**
 * repo-hygiene handler.
 *
 *   GitHub PR opened/synchronized
 *     -> read PR metadata + diff through Relayfile-backed ctx.github
 *     -> run a read-only hygiene diagnosis in the materialized repo
 *     -> post a concise PR comment
 *     -> create a Notion journal page for the run
 *     -> optionally post a Slack summary
 */
import { defineAgent, type WorkforceCtx, type WorkforceProviderEvent } from '@agentworkforce/runtime';

interface PrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  author: string;
  headSha?: string;
  baseRef?: string;
  headRef?: string;
}

interface Finding {
  title: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string;
  recommendation: string;
}

interface HygieneReport {
  summary: string;
  findings: Finding[];
  followUps: string[];
  confidence: 'high' | 'medium' | 'low';
}

export default defineAgent({
  triggers: {
    github: [
      { on: 'pull_request.opened' },
      { on: 'pull_request.synchronize' }
    ]
  },
  handler: async (ctx, event) => {
  if (event.source !== 'github') return;
  if (event.type !== 'pull_request.opened' && event.type !== 'pull_request.synchronize') return;
  if (!ctx.github) throw new Error('repo-hygiene requires the github integration');
  if (!ctx.notion) throw new Error('repo-hygiene requires the notion integration');

  const pr = readPr(event);
  if (!pr) return;

  const details = await ctx.github.getPr(pr);
  const report = await diagnose(ctx, pr, details.diff);
  const body = renderPrComment(pr, report);

  await ctx.github.comment(pr, body);
  let notionUrl: string | undefined;
  try {
    const notionPage = await writeNotionJournal(ctx, pr, event, report, body);
    notionUrl = notionPage.url;
    await rememberRun(ctx, pr, event, report, notionUrl);
  } catch (error) {
    ctx.log('warn', 'repo-hygiene.journal-failed', { error: serializeError(error) });
  }

  const channel = input(ctx, 'SLACK_CHANNEL');
  if (channel && ctx.slack) {
    await ctx.slack.post(channel, renderSlackSummary(pr, report, notionUrl));
  }
  }
});

function readPr(event: WorkforceProviderEvent): PrRef | undefined {
  const p = event.payload as {
    number?: number;
    pull_request?: {
      number?: number;
      html_url?: string;
      title?: string;
      user?: { login?: string };
      head?: { sha?: string; ref?: string };
      base?: { ref?: string };
    };
    repository?: { name?: string; full_name?: string; owner?: { login?: string } };
    sender?: { login?: string };
  } | null;

  const number = p?.pull_request?.number ?? p?.number;
  const fullName = p?.repository?.full_name;
  const owner = p?.repository?.owner?.login ?? fullName?.split('/')[0];
  const repo = p?.repository?.name ?? fullName?.split('/')[1];

  if (typeof number !== 'number' || !Number.isInteger(number) || !owner || !repo) return undefined;

  return {
    owner,
    repo,
    number,
    url: p?.pull_request?.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`,
    title: p?.pull_request?.title ?? `PR #${number}`,
    author: p?.pull_request?.user?.login ?? p?.sender?.login ?? 'unknown',
    ...(p?.pull_request?.head?.sha ? { headSha: p.pull_request.head.sha } : {}),
    ...(p?.pull_request?.base?.ref ? { baseRef: p.pull_request.base.ref } : {}),
    ...(p?.pull_request?.head?.ref ? { headRef: p.pull_request.head.ref } : {})
  };
}

async function diagnose(ctx: WorkforceCtx, pr: PrRef, diff: string): Promise<HygieneReport> {
  const diffBudget = Number(input(ctx, 'MAX_DIFF_CHARS') ?? '40000');
  const maxDiffChars = Number.isFinite(diffBudget) ? Math.min(40000, Math.max(0, Math.floor(diffBudget))) : 40000;
  const boundedDiff = diff.slice(0, maxDiffChars);
  const repoHints = await collectRepoHints(ctx);
  const priorMemory = await recallPriorMemory(ctx, pr);

  const prompt = [
    'Run a read-only hygiene diagnosis for this pull request.',
    '',
    'Look specifically for:',
    '- duplicated or dead code',
    '- divergent paths that should be consolidated',
    '- stale skills, rules, AGENTS.md, SKILL.md, README, workflow docs, or persona guidance',
    '- code smells that increase maintenance load',
    '',
    'Return JSON only with this shape:',
    '{"summary":"...", "confidence":"high|medium|low", "findings":[{"title":"...", "severity":"high|medium|low", "evidence":"...", "recommendation":"..."}], "followUps":["..."]}',
    '',
    `Repository: ${pr.owner}/${pr.repo}`,
    `Pull request: #${pr.number} ${pr.title}`,
    `Author: ${pr.author}`,
    pr.baseRef ? `Base: ${pr.baseRef}` : '',
    pr.headRef ? `Head: ${pr.headRef}` : '',
    '',
    'Recent memory from earlier hygiene runs:',
    priorMemory || '(none)',
    '',
    'Repository hints from the sandbox:',
    repoHints || '(none)',
    '',
    'PR diff:',
    boundedDiff || '(diff unavailable)'
  ].filter(Boolean).join('\n');

  const result = await ctx.harness.run({ cwd: ctx.sandbox.cwd, prompt });
  return parseReport(result.output);
}

async function collectRepoHints(ctx: WorkforceCtx): Promise<string> {
  const commands = [
    'pwd',
    'find . -maxdepth 3 \\( -name AGENTS.md -o -name CLAUDE.md -o -name GEMINI.md -o -name SKILL.md -o -name README.md -o -name package.json -o -name Cargo.toml -o -name go.mod \\) 2>/dev/null | sort | sed -n "1,120p"',
    'find . -maxdepth 3 -type f \\( -path "*/workflows/*" -o -path "*/skills/*" -o -path "*/personas/*" -o -path "*/docs/*" \\) 2>/dev/null | sort | sed -n "1,160p"',
    'rg -n "TODO|FIXME|deprecated|duplicate|duplicated|dead code|remove this|follow-up|HACK" -S . -g "!node_modules" -g "!dist" -g "!target" -g "!package-lock.json" 2>/dev/null | sed -n "1,120p"'
  ];

  const sections: string[] = [];
  for (const command of commands) {
    const res = await ctx.sandbox.exec(command, { cwd: ctx.sandbox.cwd, timeoutMs: 20000 }).catch((err: unknown) => ({
      output: err instanceof Error ? err.message : String(err),
      exitCode: 1
    }));
    sections.push(`$ ${command}\n${res.output.trim() || `(exit ${res.exitCode}, no output)`}`);
  }
  return sections.join('\n\n').slice(0, 24000);
}

async function recallPriorMemory(ctx: WorkforceCtx, pr: PrRef): Promise<string> {
  const items = await ctx.memory.recall(`${pr.owner}/${pr.repo} hygiene divergence`, {
    tags: [`repo:${pr.owner}/${pr.repo}`, 'repo-hygiene'],
    limit: 3
  });
  return items.map((item) => item.content).join('\n\n').slice(0, 8000);
}

function parseReport(output: string): HygieneReport {
  const raw = output.replace(/```json\s*|```/g, '').trim();
  try {
    const parsed = JSON.parse(raw) as Partial<HygieneReport>;
    return {
      summary: cleanText(parsed.summary, 'No summary returned.'),
      confidence: normalizeConfidence(parsed.confidence),
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 6).map(normalizeFinding) : [],
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps.map((v) => cleanText(v, '')).filter(Boolean).slice(0, 6) : []
    };
  } catch {
    return {
      summary: output.trim().slice(0, 1200) || 'The hygiene diagnosis completed but did not return structured JSON.',
      confidence: 'low',
      findings: [],
      followUps: ['Tighten the repo-hygiene prompt or inspect the Relay transcript for the raw output.']
    };
  }
}

function normalizeFinding(value: Partial<Finding>): Finding {
  return {
    title: cleanText(value.title, 'Untitled finding'),
    severity: normalizeSeverity(value.severity),
    evidence: cleanText(value.evidence, 'No evidence provided.'),
    recommendation: cleanText(value.recommendation, 'No recommendation provided.')
  };
}

function normalizeSeverity(value: unknown): Finding['severity'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

function normalizeConfidence(value: unknown): HygieneReport['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function renderPrComment(pr: PrRef, report: HygieneReport): string {
  const findings = report.findings.length
    ? report.findings.map((f, i) => [
      `${i + 1}. **${label(f.severity)}: ${f.title}**`,
      `   - Evidence: ${f.evidence}`,
      `   - Recommendation: ${f.recommendation}`
    ].join('\n')).join('\n')
    : 'No high-signal hygiene findings in this pass.';

  const followUps = report.followUps.length
    ? report.followUps.map((item) => `- ${item}`).join('\n')
    : '- No follow-up proposed.';

  return [
    '## Repo hygiene review',
    '',
    report.summary,
    '',
    `Confidence: **${report.confidence}**`,
    '',
    '### Findings',
    findings,
    '',
    '### Follow-ups',
    followUps,
    '',
    '_Read-only dogfood pass: this agent did not modify files. Fix mode will be gated separately._',
    '',
    `Run scope: ${pr.owner}/${pr.repo}#${pr.number}`
  ].join('\n');
}

async function writeNotionJournal(
  ctx: WorkforceCtx,
  pr: PrRef,
  event: WorkforceProviderEvent,
  report: HygieneReport,
  prComment: string
): Promise<{ id: string; url?: string }> {
  const databaseId = input(ctx, 'NOTION_DATABASE_ID');
  if (!databaseId) throw new Error('NOTION_DATABASE_ID is required');

  const title = `${pr.owner}/${pr.repo}#${pr.number} hygiene - ${new Date(event.occurredAt).toISOString().slice(0, 10)}`;
  const page = await ctx.notion!.createPage(
    { database_id: databaseId },
    {
      Name: { title: [{ text: { content: title } }] },
      Repository: { rich_text: [{ text: { content: `${pr.owner}/${pr.repo}` } }] },
      PR: { number: pr.number },
      Confidence: { select: { name: report.confidence } },
      Findings: { number: report.findings.length },
      Trigger: { rich_text: [{ text: { content: event.type } }] }
    },
    notionBlocks([
      `PR: ${pr.url}`,
      `Commit: ${pr.headSha ?? 'unknown'}`,
      `Summary: ${report.summary}`,
      '',
      'Findings:',
      ...(report.findings.length ? report.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.recommendation}`) : ['- none']),
      '',
      'Follow-ups:',
      ...(report.followUps.length ? report.followUps.map((f) => `- ${f}`) : ['- none']),
      '',
      'PR comment:',
      prComment
    ].join('\n'))
  );
  return { id: page.id, url: page.url };
}

function notionBlocks(markdown: string): Array<Record<string, unknown>> {
  return chunk(markdown, 1800).map((content) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content } }] }
  }));
}

function chunk(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

async function rememberRun(
  ctx: WorkforceCtx,
  pr: PrRef,
  event: WorkforceProviderEvent,
  report: HygieneReport,
  notionUrl?: string
): Promise<void> {
  await ctx.memory.save(JSON.stringify({
    repo: `${pr.owner}/${pr.repo}`,
    pr: pr.number,
    event: event.type,
    occurredAt: event.occurredAt,
    summary: report.summary,
    findings: report.findings.map((f) => ({ title: f.title, severity: f.severity })),
    notionUrl
  }), {
    scope: 'workspace',
    tags: ['repo-hygiene', `repo:${pr.owner}/${pr.repo}`]
  });
}

function renderSlackSummary(pr: PrRef, report: HygieneReport, notionUrl?: string): string {
  const top = report.findings[0];
  const suffix = notionUrl ? `\nJournal: ${notionUrl}` : '';
  return [
    `Repo hygiene checked ${pr.owner}/${pr.repo}#${pr.number}: ${pr.url}`,
    `Findings: ${report.findings.length}; confidence: ${report.confidence}`,
    top ? `Top finding: [${top.severity}] ${top.title}` : 'Top finding: none',
    suffix
  ].filter(Boolean).join('\n');
}

function label(severity: Finding['severity']): string {
  return severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
