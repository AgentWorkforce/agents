import {
  defineAgent,
  draftFile,
  encodeSegment,
  resolveMountRoot,
  WorkforceIntegrationError,
  writeJsonFile,
  isCronTickEvent,
  type IntegrationClientOptions,
  type WorkforceCtx,
  type WorkforceEvent
} from '@agentworkforce/runtime';

interface DigestItem {
  title: string;
  url: string;
  description: string;
  host: string;
}

interface DigestCluster {
  host: string;
  items: DigestItem[];
}

export default defineAgent({
  schedules: [{ name: 'weekly', cron: '0 9 * * 6', tz: 'UTC' }],
  handler: async (ctx, event) => {
  if (!isCronTickEvent(event)) {
    ctx.log('warn', 'weekly-digest.ignored', { reason: 'non-cron event' });
    return;
  }

  const config = readConfig();
  const githubClient: IntegrationClientOptions = {
    relayfileMountRoot: resolveMountRoot({}),
    writebackTimeoutMs: 30_000
  };

  const topics = parseTopics(config.topics);
  const fetchedAt = new Date(event.occurredAt);
  const isoWeek = isoWeekString(fetchedAt);
  const title = `Weekly digest — ${isoWeek}`;

  ctx.log('info', 'weekly-digest.search.start', { topics, week: isoWeek });

  const items: DigestItem[] = [];
  for (const topic of topics) {
    try {
      const found = await searchBrave(topic, config.braveApiKey);
      items.push(...found);
    } catch (err) {
      ctx.log('error', 'weekly-digest.search.failed', {
        topic,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const deduped = dedupeByUrl(items);
  const clusters = clusterByHost(deduped);

  if (clusters.length === 0) {
    ctx.log('info', 'weekly-digest.no-results', { week: isoWeek });
    return;
  }

  const body = renderDigest({ week: isoWeek, fetchedAt, topics, clusters });
  const repoSegments = config.repo.split('/');
  if (repoSegments.length !== 2 || !repoSegments[0].trim() || !repoSegments[1].trim()) {
    throw new Error(
      `weekly-digest: WEEKLY_DIGEST_REPO must be exactly "owner/repo"; got "${config.repo}"`
    );
  }
  const [owner, repo] = repoSegments as [string, string];

  const result = await writeJsonFile(
    githubClient,
    'github',
    'upsertIssue',
    `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/issues/${draftFile('upsert issue')}`,
    {
      title,
      body,
      matchTitle: title,
      labels: ['weekly-digest']
    }
  );

  const issueUrl = result.receipt?.url ?? result.path;
  ctx.log('info', 'weekly-digest.issue.upserted', {
    week: isoWeek,
    url: issueUrl,
    receipt: result.receipt,
    clusterCount: clusters.length,
    itemCount: deduped.length
  });

  await ctx.memory.save(`Weekly digest ${isoWeek} published: ${issueUrl}`, {
    tags: ['weekly-digest', `week:${isoWeek}`],
    scope: 'workspace'
  });
  }
});

function readConfig(): { topics: string; repo: string; braveApiKey: string } {
  const topics = process.env.WEEKLY_DIGEST_TOPICS;
  const repo = process.env.WEEKLY_DIGEST_REPO;
  const braveApiKey = process.env.BRAVE_API_KEY;
  if (!topics || !topics.trim()) {
    throw new Error('WEEKLY_DIGEST_TOPICS is required (comma-separated list)');
  }
  if (!repo || !repo.trim()) {
    throw new Error('WEEKLY_DIGEST_REPO is required (format: "owner/repo")');
  }
  if (!braveApiKey) {
    throw new Error('BRAVE_API_KEY is required to query Brave Search');
  }
  return { topics, repo, braveApiKey };
}

function parseTopics(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

async function searchBrave(query: string, apiKey: string): Promise<DigestItem[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&freshness=pw`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'X-Subscription-Token': apiKey,
      'user-agent': 'workforce-weekly-digest'
    }
  });
  if (!response.ok) {
    throw new WorkforceIntegrationError({
      provider: 'brave',
      operation: 'search',
      cause: new Error(`${response.status} ${response.statusText}`),
      retryable: response.status >= 500 || response.status === 429
    });
  }
  const payload = (await response.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  const results = payload.web?.results ?? [];
  return results.map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    host: safeHost(r.url)
  }));
}

function dedupeByUrl(items: DigestItem[]): DigestItem[] {
  const seen = new Set<string>();
  const out: DigestItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function clusterByHost(items: DigestItem[]): DigestCluster[] {
  const buckets = new Map<string, DigestItem[]>();
  for (const item of items) {
    const existing = buckets.get(item.host);
    if (existing) existing.push(item);
    else buckets.set(item.host, [item]);
  }
  return Array.from(buckets.entries())
    .map(([host, bucketItems]) => ({ host, items: bucketItems }))
    .sort((a, b) => b.items.length - a.items.length);
}

function renderDigest(args: {
  week: string;
  fetchedAt: Date;
  topics: string[];
  clusters: DigestCluster[];
}): string {
  const lines: string[] = [];
  lines.push(`# Weekly digest — ${args.week}`);
  lines.push('');
  lines.push(`Fetched at ${args.fetchedAt.toISOString()}.`);
  lines.push(`Topics: ${args.topics.join(', ')}`);
  lines.push('');
  for (const cluster of args.clusters) {
    lines.push(`## ${cluster.host} (${cluster.items.length})`);
    for (const item of cluster.items) {
      lines.push(`- [${item.title}](${item.url}) — ${truncate(item.description, 200)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'unknown';
  }
}

function isoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Touch the imported types so build does not warn on type-only imports.
type _Touch = WorkforceEvent | WorkforceCtx;
