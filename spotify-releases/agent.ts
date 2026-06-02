/**
 * spotify-releases handler.
 *
 *   list the artists you follow
 *     → get each one's latest releases
 *     → keep releases newer than the last check (durable memory)
 *     → DM the list on Slack
 */
import {
  defineAgent,
  draftFile,
  encodeSegment,
  resolveMountRoot,
  writeJsonFile,
  type IntegrationClientOptions,
  type WorkforceCtx
} from '@agentworkforce/runtime';

function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

interface Release {
  name: string;
  artist: string;
  date: string;
  url: string;
}

export default defineAgent({
  schedules: [{ name: 'check', cron: '0 10 * * *', tz: 'America/New_York' }],
  handler: async (ctx, event) => {
  if (event.source !== 'cron') return;

  const user = input(ctx, 'SLACK_USER');
  const token = input(ctx, 'SPOTIFY_TOKEN');
  if (!user) throw new Error('SLACK_USER is required');
  if (!token) throw new Error('SPOTIFY_TOKEN is required');

  const since = await loadLastCheck(ctx);
  const artists = await followedArtists(token);

  // Fetch every artist's releases in parallel; one failing artist shouldn't
  // sink the whole check.
  const perArtist = await Promise.allSettled(
    artists.map((artist) => latestReleases(token, artist))
  );
  const releases = perArtist.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).filter((rel) => rel.date > since);

  if (releases.length > 0) {
    await writeJsonFile(
      vfsClient(),
      'slack',
      'dm',
      `/slack/users/${encodeSegment(user)}/messages/${draftFile('dm')}`,
      { text: render(releases) }
    );
  }
  await saveLastCheck(ctx, today());
  }
});

async function followedArtists(token: string): Promise<Array<{ id: string; name: string }>> {
  const data = (await spotify(token, '/me/following?type=artist&limit=50')) as {
    artists?: { items?: Array<{ id: string; name: string }> };
  };
  return data.artists?.items ?? [];
}

async function latestReleases(token: string, artist: { id: string; name: string }): Promise<Release[]> {
  const data = (await spotify(token, `/artists/${artist.id}/albums?include_groups=album,single&limit=5`)) as {
    items?: Array<{ name: string; release_date: string; external_urls: { spotify: string } }>;
  };
  return (data.items ?? []).map((a) => ({
    name: a.name,
    artist: artist.name,
    date: a.release_date,
    url: a.external_urls.spotify
  }));
}

async function spotify(token: string, path: string): Promise<unknown> {
  const res = await fetch(`https://api.spotify.com/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Spotify ${path} → ${res.status}`);
  return res.json();
}

function render(releases: Release[]): string {
  const lines = releases
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => `• *${r.artist}* — <${r.url}|${r.name}> (${r.date})`);
  return `:notes: *New releases from artists you follow* (${releases.length})\n${lines.join('\n')}`;
}

// ── tiny helpers ────────────────────────────────────────────────────────────
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
async function loadLastCheck(ctx: WorkforceCtx): Promise<string> {
  const [item] = await ctx.memory.recall('spotify last check', { tags: ['spotify:last-check'], limit: 1 });
  return item?.content ?? '0000-00-00';
}
async function saveLastCheck(ctx: WorkforceCtx, date: string): Promise<void> {
  await ctx.memory.save(date, { tags: ['spotify:last-check'], scope: 'workspace' });
}
