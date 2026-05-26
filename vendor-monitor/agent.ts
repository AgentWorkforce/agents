/**
 * vendor-monitor handler.
 *
 *   for each watched npm package
 *     → read its latest published version
 *     → compare to the version we saw last time (durable memory)
 *     → post any bumps to the team Slack channel
 */
import { handler, type WorkforceCtx } from '@agentworkforce/runtime';

export default handler(async (ctx, event) => {
  if (event.source !== 'cron') return;
  if (!ctx.slack) throw new Error('vendor-monitor requires the slack integration');

  const channel = input(ctx, 'SLACK_CHANNEL');
  if (!channel) throw new Error('SLACK_CHANNEL is required');
  const vendors = list(input(ctx, 'VENDORS'));

  const lastSeen = await loadVersions(ctx);
  const current: Record<string, string> = {};
  const bumps: string[] = [];

  for (const pkg of vendors) {
    const version = await latestVersion(pkg);
    if (!version) continue;
    current[pkg] = version;
    if (lastSeen[pkg] && lastSeen[pkg] !== version) {
      bumps.push(`• *${pkg}* ${lastSeen[pkg]} → *${version}*  <https://www.npmjs.com/package/${pkg}|changelog>`);
    }
  }

  if (bumps.length > 0) {
    await ctx.slack.post(channel, `:package: *Vendor updates*\n${bumps.join('\n')}`);
  }
  await saveVersions(ctx, { ...lastSeen, ...current });
});

/** Latest published version from the npm registry. */
async function latestVersion(pkg: string): Promise<string | undefined> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
  if (!res.ok) return undefined;
  return ((await res.json()) as { version?: string }).version;
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
async function loadVersions(ctx: WorkforceCtx): Promise<Record<string, string>> {
  const [item] = await ctx.memory.recall('vendor versions', { tags: ['vendor-monitor:versions'], limit: 1 });
  try {
    return item ? (JSON.parse(item.content) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
async function saveVersions(ctx: WorkforceCtx, versions: Record<string, string>): Promise<void> {
  await ctx.memory.save(JSON.stringify(versions), { tags: ['vendor-monitor:versions'], scope: 'workspace' });
}
