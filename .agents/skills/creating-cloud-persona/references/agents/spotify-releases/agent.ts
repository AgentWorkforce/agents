/**
 * spotify-releases handler — dual-transport (Slack DM and/or Telegram).
 *
 *   list the artists you follow
 *     → get each one's latest releases
 *     → keep releases newer than the last check (durable memory)
 *     → deliver the list to each configured transport (Slack DM, Telegram, or both)
 *
 * Cron-only (no chat surface). Transport is configuration-driven (workforce#252):
 * the persona gates `slack` on SLACK_USER and `telegram` on TELEGRAM_CHAT, so the
 * unconfigured transport is pruned at deploy. The checkpoint (last-check date +
 * notified-release set) advances ONLY after every configured transport delivered
 * and no artist fetch failed — so a flaky send re-notifies next tick rather than
 * silently dropping releases.
 */
import { defineAgent, isCronTickEvent, type WorkforceCtx } from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';
import { defaultTelegram, bareChatId, type TelegramSender } from '../shared/telegram.js';

interface Release {
  name: string;
  artist: string;
  date: string;
  url: string;
}

/** The slice of slackClient() this agent uses (injectable for tests). */
export interface SlackDM {
  dm(userId: string, text: string): Promise<{ ok: boolean }>;
}

const SPOTIFY_TIMEOUT_MS = 15_000;
const TELEGRAM_MESSAGE_BUDGET = 3900;
const MAX_RENDERED_RELEASES = 30;

export default defineAgent({
  schedules: [{ name: 'check', cron: '0 10 * * *', tz: 'America/New_York' }],
  handler: async (ctx, event) => {
    if (!isCronTickEvent(event)) return;
    await checkReleases(ctx);
  }
});

export async function checkReleases(
  ctx: WorkforceCtx,
  deps: { slack?: SlackDM; telegram?: TelegramSender } = {}
): Promise<void> {
  const slackUser = input(ctx, 'SLACK_USER');
  const chat = input(ctx, 'TELEGRAM_CHAT');
  const token = input(ctx, 'SPOTIFY_TOKEN');
  if (!token) throw new Error('SPOTIFY_TOKEN is required');
  if (!slackUser && !chat) throw new Error('At least one of SLACK_USER or TELEGRAM_CHAT is required');

  const since = await loadLastCheck(ctx);
  const notified = new Set(await loadNotified(ctx));
  const artists = await followedArtists(token);

  // Fetch every artist's releases in parallel; one failing artist shouldn't
  // sink the whole check.
  const perArtist = await Promise.allSettled(artists.map((artist) => latestReleases(token, artist)));
  const failed = perArtist.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const releases = perArtist
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((rel) => rel.date >= since && !notified.has(releaseKey(rel)));

  if (failed.length > 0) {
    ctx.log?.('warn', 'spotify-releases.partial-fetch-failure', {
      failedArtists: failed.length,
      totalArtists: artists.length
    });
  }

  // Deliver to each configured transport. `delivered` is true only if EVERY
  // configured transport succeeded (or there was nothing to send).
  let delivered = releases.length === 0;
  if (releases.length > 0) {
    const oks: boolean[] = [];
    if (slackUser) {
      const slack = deps.slack ?? defaultSlackDM();
      const ok = await slack
        .dm(slackUser.split('__')[0], renderSlack(releases))
        .then((r) => r.ok)
        .catch((e) => {
          ctx.log?.('warn', 'spotify-releases.slack-send-failed', { error: String(e) });
          return false;
        });
      if (ok) ctx.log?.('info', 'spotify-releases.slack-sent', { releases: releases.length });
      else ctx.log?.('warn', 'spotify-releases.slack-no-receipt', { releases: releases.length });
      oks.push(ok);
    }
    if (chat) {
      const tg = deps.telegram ?? defaultTelegram();
      const res = await tg.send(bareChatId(chat), renderTelegram(releases));
      if (res.ok) ctx.log?.('info', 'spotify-releases.telegram-sent', { chat: bareChatId(chat), releases: releases.length });
      else ctx.log?.('warn', 'spotify-releases.telegram-no-receipt', { chat: bareChatId(chat), releases: releases.length });
      oks.push(res.ok);
    }
    delivered = oks.every(Boolean);
  } else {
    ctx.log?.('info', 'spotify-releases.nothing-new', { since });
  }

  if (delivered && failed.length === 0) {
    await saveLastCheck(ctx, today());
    if (releases.length > 0) {
      await saveNotified(ctx, [...notified, ...releases.map(releaseKey)].slice(-500));
    }
  } else {
    ctx.log?.('warn', 'spotify-releases.checkpoint-not-advanced', {
      since,
      failedArtists: failed.length,
      delivered
    });
  }
}

function defaultSlackDM(): SlackDM {
  const slack = slackClient({ writebackTimeoutMs: 15_000 });
  return {
    async dm(userId, text) {
      const res = (await slack.dm(userId, text)) as { ts?: string } | undefined;
      // A DM receipt carries a `ts`; cloud writeback can outrun the wait, so a
      // missing ts means "no receipt" → not delivered (re-notify next tick).
      return { ok: Boolean(res?.ts) };
    }
  };
}

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPOTIFY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`https://api.spotify.com/v1${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Spotify ${path} timed out after ${SPOTIFY_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Spotify ${path} → ${res.status}`);
  return res.json();
}

/** Slack render — markdown link syntax (`<url|name>`). */
function renderSlack(releases: Release[]): string {
  const lines = [...releases]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((r) => `• *${r.artist}* — <${r.url}|${r.name}> (${r.date})`);
  return `:notes: *New releases from artists you follow* (${releases.length})\n${lines.join('\n')}`;
}

/** Telegram render — plain text (auto-links bare URLs), budget-truncated. */
function renderTelegram(releases: Release[]): string {
  const sorted = [...releases].sort((a, b) => b.date.localeCompare(a.date));
  const lines: string[] = [];
  for (const rel of sorted.slice(0, MAX_RENDERED_RELEASES)) {
    const line = `• ${rel.artist} — ${rel.name} (${rel.date})\n${rel.url}`;
    const next = `🎵 New releases from artists you follow (${releases.length})\n${[...lines, line].join('\n')}`;
    if (next.length > TELEGRAM_MESSAGE_BUDGET) break;
    lines.push(line);
  }
  const omitted = releases.length - lines.length;
  const suffix = omitted > 0 ? `\n…and ${omitted} more release(s).` : '';
  return `🎵 New releases from artists you follow (${releases.length})\n${lines.join('\n')}${suffix}`;
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
  const [item] = await ctx.memory.recall('spotify last check', { tags: ['spotify-releases:last-check'], limit: 1 });
  return item?.content ?? '0000-00-00';
}
async function saveLastCheck(ctx: WorkforceCtx, date: string): Promise<void> {
  await ctx.memory.save(date, { tags: ['spotify-releases:last-check'], scope: 'workspace' });
}
async function loadNotified(ctx: WorkforceCtx): Promise<string[]> {
  const [item] = await ctx.memory.recall('spotify notified releases', {
    tags: ['spotify-releases:notified'],
    limit: 1
  });
  try {
    return item ? (JSON.parse(item.content) as string[]) : [];
  } catch {
    return [];
  }
}
async function saveNotified(ctx: WorkforceCtx, keys: string[]): Promise<void> {
  await ctx.memory.save(JSON.stringify(keys), { tags: ['spotify-releases:notified'], scope: 'workspace' });
}
function releaseKey(rel: Release): string {
  return rel.url || `${rel.artist}:${rel.name}:${rel.date}`;
}
