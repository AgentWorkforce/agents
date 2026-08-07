import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx,
} from '@agentworkforce/runtime';
import { ASKABLE_GTM_CAPABILITY } from './capabilities.js';

const LISTEN_URL = 'https://api.revternal.com/social/listen';
const WATCH_STATE_TAG = 'askable-gtm:watch-state';
const MAX_SEEN_IDS = 500;

export const WATCH_SWEEP_CRON = '*/15 * * * *';

export type WatchCadence = '15m' | '1h' | '6h' | '12h' | '24h' | '7d';

export interface WatchDefinition {
  id: string;
  query: string;
  cadence: WatchCadence;
  owner: string;
  createdAt: string;
  lastRunAt?: string;
  lastFetchedAt?: string;
  seenIds: string[];
}

interface WatchState {
  kind: 'askable-gtm watch state';
  version: 1;
  updatedAt: string;
  watches: WatchDefinition[];
}

export interface ListenResult {
  id?: string;
  source_id?: string;
  platform?: string;
  url?: string;
  permalink?: string;
  created_at?: string;
  title?: string;
  body_text?: string;
  score_count?: number;
  comment_count?: number;
  community?: { name?: string; url?: string };
  author?: { handle?: string; profile?: string };
}

export interface ListenResponse {
  meta?: {
    query?: string;
    total_results?: number;
    sources_queried?: string[];
    fetched_at?: string;
    page?: number;
    per_page?: number;
  };
  results?: ListenResult[];
  source_status?: Record<string, {
    status?: string;
    count?: number;
    latency?: number;
    error?: string | null;
  }>;
}

export type ParsedCommand =
  | { kind: 'capabilities-json' }
  | { kind: 'capabilities-human' }
  | { kind: 'list-watches' }
  | { kind: 'remove-watch'; id: string }
  | { kind: 'create-watch'; query: string; cadence: WatchCadence }
  | { kind: 'question'; query: string };

export default defineAgent({
  // User watch definitions live in workspace memory. This one deploy-time
  // Relaycron schedule evaluates which definitions are due every 15 minutes.
  schedules: [{ name: 'watch-sweep', cron: WATCH_SWEEP_CRON, tz: 'UTC' }],

  handler: async (ctx, event) => {
    if (isRelaycastMessageEvent(event)) {
      await handleRelayMessage(ctx, event);
      return;
    }
    if (isCronTickEvent(event)) {
      await runWatchSweep(ctx, new Date());
    }
  },
});

export function parseCommand(text: string): ParsedCommand {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  if (lower === 'capabilities --json') return { kind: 'capabilities-json' };
  if (/^(what can you (tell|show) me\??|help|capabilities)$/iu.test(normalized)) {
    return { kind: 'capabilities-human' };
  }
  if (/^(watches|list watches)$/iu.test(normalized)) return { kind: 'list-watches' };

  const remove = normalized.match(/^(?:unwatch|remove watch)\s+([a-z0-9-]+)$/iu);
  if (remove) return { kind: 'remove-watch', id: remove[1]!.toLowerCase() };

  const create = normalized.match(
    /^watch\s+(.+?)\s+every\s+(15m|1h|6h|12h|24h|7d)$/iu,
  );
  if (create) {
    return {
      kind: 'create-watch',
      query: create[1]!.trim(),
      cadence: create[2]!.toLowerCase() as WatchCadence,
    };
  }

  return { kind: 'question', query: normalized };
}

export async function handleRelayMessage(ctx: WorkforceCtx, event: AgentEvent): Promise<void> {
  const full = await event.expand('full').catch(() => undefined);
  const text = relayText(event, full);
  const sender = relaySender(event, full);
  if (!text || !sender) {
    ctx.log('warn', 'askable-gtm.unreplyable-message', {
      hasText: Boolean(text),
      hasSender: Boolean(sender),
    });
    return;
  }

  const command = parseCommand(text);
  if (command.kind === 'capabilities-json') {
    await reply(ctx, sender, JSON.stringify({
      type: 'askable.capabilities',
      capability: ASKABLE_GTM_CAPABILITY,
      runtimeDataAccess: revternalKey() ? 'available-unverified' : 'blocked-no-credential-bridge',
    }));
    return;
  }
  if (command.kind === 'capabilities-human') {
    await reply(ctx, sender, renderCapabilities(Boolean(revternalKey())));
    return;
  }
  if (command.kind === 'list-watches') {
    const state = await loadWatchState(ctx);
    await reply(ctx, sender, renderWatches(state.watches.filter((watch) => watch.owner === sender)));
    return;
  }
  if (command.kind === 'remove-watch') {
    const state = await loadWatchState(ctx);
    const remaining = state.watches.filter(
      (watch) => !(watch.id === command.id && watch.owner === sender),
    );
    if (remaining.length === state.watches.length) {
      await reply(ctx, sender, `I could not find watch ${command.id} owned by you.`);
      return;
    }
    await saveWatchState(ctx, remaining);
    await reply(ctx, sender, `Removed watch ${command.id}.`);
    return;
  }
  if (command.kind === 'create-watch') {
    const state = await loadWatchState(ctx);
    let watch: WatchDefinition;
    try {
      watch = createWatch(command.query, command.cadence, sender, new Date());
    } catch (error) {
      await reply(ctx, sender, error instanceof Error ? error.message : 'Invalid watch request.');
      return;
    }
    const withoutDuplicate = state.watches.filter(
      (candidate) => !(candidate.owner === sender && candidate.query === watch.query),
    );
    await saveWatchState(ctx, [...withoutDuplicate, watch]);
    await reply(
      ctx,
      sender,
      `Saved ${watch.id}: “${watch.query}” every ${watch.cadence}. `
        + 'It is evaluated by the agent’s shared 15-minute recurring sweep; '
        + 'this did not create a per-watch Relaycron schedule. '
        + (revternalKey()
          ? 'A credential is present, but live result quality remains unverified.'
          : 'Live execution is currently blocked until Cloud supplies a scoped Revternal credential bridge.'),
    );
    return;
  }

  await answerQuestion(ctx, sender, command.query);
}

export function createWatch(
  query: string,
  cadence: WatchCadence,
  owner: string,
  now: Date,
): WatchDefinition {
  const cleaned = query.replace(/\s+/gu, ' ').trim();
  if (cleaned.length < 2 || cleaned.length > 500) {
    throw new Error('Watch query must contain between 2 and 500 characters');
  }
  return {
    id: `watch-${shortHash(`${owner}\n${cleaned.toLowerCase()}`)}`,
    query: cleaned,
    cadence,
    owner,
    createdAt: now.toISOString(),
    seenIds: [],
  };
}

export function watchIsDue(watch: WatchDefinition, now: Date): boolean {
  if (!watch.lastRunAt) return true;
  const last = new Date(watch.lastRunAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= cadenceMs(watch.cadence);
}

export async function queryListen(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ListenResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(LISTEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        query,
        sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
        filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
        sort_by: 'relevance_score',
        page: 1,
        per_page: 20,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Revternal Listen returned HTTP ${response.status}`);
    }
    const body = await response.json() as unknown;
    if (!isRecord(body)) throw new Error('Revternal Listen returned a non-object response');
    return body as ListenResponse;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Revternal Listen timed out after 20000ms');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWatchSweep(ctx: WorkforceCtx, now: Date): Promise<void> {
  const key = revternalKey();
  if (!key) {
    ctx.log('warn', 'askable-gtm.sweep-blocked', {
      reason: 'scoped Revternal credential bridge is not available',
    });
    return;
  }

  const state = await loadWatchState(ctx);
  let changed = false;
  for (const watch of state.watches) {
    if (!watchIsDue(watch, now)) continue;
    try {
      const response = await queryListen(watch.query, key);
      const results = response.results ?? [];
      const previous = new Set(watch.seenIds);
      const fresh = results.filter((result) => {
        const id = resultId(result);
        return Boolean(id && !previous.has(id));
      });
      watch.seenIds = unique([
        ...results.map(resultId).filter((id): id is string => Boolean(id)),
        ...watch.seenIds,
      ]).slice(0, MAX_SEEN_IDS);
      watch.lastRunAt = now.toISOString();
      watch.lastFetchedAt = response.meta?.fetched_at;
      changed = true;
      if (fresh.length > 0) {
        await reply(ctx, watch.owner, renderListenAnswer(watch.query, response, fresh));
      }
    } catch (error) {
      ctx.log('error', 'askable-gtm.watch-failed', {
        watchId: watch.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (changed) await saveWatchState(ctx, state.watches);
}

async function answerQuestion(ctx: WorkforceCtx, sender: string, query: string): Promise<void> {
  const key = revternalKey();
  if (!key) {
    await reply(
      ctx,
      sender,
      'Live public-signal search is blocked: Cloud has not supplied a scoped Revternal '
        + 'credential bridge. I can still describe my manifest and manage watch definitions. '
        + 'Send “capabilities --json” for the exact machine-readable status.',
    );
    return;
  }
  const response = await queryListen(query, key);
  await reply(ctx, sender, renderListenAnswer(query, response, response.results ?? []));
}

export function renderListenAnswer(
  query: string,
  response: ListenResponse,
  results: ListenResult[],
): string {
  const fetchedAt = response.meta?.fetched_at ?? 'not supplied';
  const coverage = Object.entries(response.source_status ?? {})
    .map(([source, status]) => `${source}:${status.status ?? 'unknown'} (${status.count ?? 0})`)
    .join(', ') || 'not supplied';
  const items = results.slice(0, 5).map((result, index) => {
    const title = oneLine(result.title ?? result.body_text ?? 'Untitled public post');
    const community = result.community?.name ? ` · ${result.community.name}` : '';
    const engagement = ` · score ${result.score_count ?? 0} · comments ${result.comment_count ?? 0}`;
    const url = result.url ?? result.permalink ?? '';
    return `${index + 1}. ${title}${community}${engagement}${url ? `\n${url}` : ''}`;
  });
  return [
    `Public-signal evidence for “${oneLine(query)}”`,
    `Fetched: ${fetchedAt} · coverage: ${coverage}`,
    items.length ? items.join('\n') : 'No results were returned.',
    'Source facts are shown above; themes or intent require separate inference.',
  ].join('\n');
}

export function renderCapabilities(hasCredential: boolean): string {
  return [
    'I am GTM Signal Scout, an askable proactive-agent prototype.',
    'Verified here: machine-readable self-description and durable watch-definition management.',
    `Live Revternal search: ${hasCredential ? 'credential present, but result quality remains unverified' : 'blocked until Cloud supplies a scoped credential bridge'}.`,
    'Designed questions: competitor mentions, category objections/migration pain, launch reaction, and public community/author activity.',
    'Watch syntax: watch <query> every <15m|1h|6h|12h|24h|7d>.',
    'All watches share one deploy-time 15-minute sweep; an utterance does not create its own Relaycron recurrence.',
    'Send “capabilities --json” for the complete machine-readable manifest.',
  ].join('\n');
}

function renderWatches(watches: WatchDefinition[]): string {
  if (watches.length === 0) return 'You have no saved GTM watches.';
  return watches
    .map((watch) => `${watch.id} · every ${watch.cadence} · ${watch.query}`)
    .join('\n');
}

async function loadWatchState(ctx: WorkforceCtx): Promise<WatchState> {
  const items = await ctx.memory.recall('askable GTM watch state', {
    tags: [WATCH_STATE_TAG],
    limit: 20,
  });
  const states = items.flatMap((item) => {
    try {
      const value = JSON.parse(item.content) as unknown;
      return validWatchState(value) ? [value] : [];
    } catch {
      return [];
    }
  });
  states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return states[0] ?? emptyWatchState();
}

async function saveWatchState(ctx: WorkforceCtx, watches: WatchDefinition[]): Promise<void> {
  const state: WatchState = {
    kind: 'askable-gtm watch state',
    version: 1,
    updatedAt: new Date().toISOString(),
    watches,
  };
  await ctx.memory.save(JSON.stringify(state), {
    tags: [WATCH_STATE_TAG],
    scope: 'workspace',
  });
}

function emptyWatchState(): WatchState {
  return {
    kind: 'askable-gtm watch state',
    version: 1,
    updatedAt: new Date(0).toISOString(),
    watches: [],
  };
}

function validWatchState(value: unknown): value is WatchState {
  if (!isRecord(value)) return false;
  return value.kind === 'askable-gtm watch state'
    && value.version === 1
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.watches);
}

function relayText(event: AgentEvent, expanded: unknown): string | undefined {
  const candidates = [
    asString((event as unknown as Record<string, unknown>).text),
    deepString(expanded, ['data', 'text']),
    deepString(expanded, ['data', 'message', 'text']),
    deepString(expanded, ['text']),
    deepString(expanded, ['message', 'text']),
  ];
  return candidates.find((value) => Boolean(value?.trim()))?.trim();
}

function relaySender(event: AgentEvent, expanded: unknown): string | undefined {
  const candidates = [
    deepString(event, ['summary', 'actor', 'id']),
    deepString(event, ['summary', 'actor', 'name']),
    deepString(expanded, ['data', 'from', 'id']),
    deepString(expanded, ['data', 'from', 'name']),
    deepString(expanded, ['from', 'id']),
    deepString(expanded, ['from', 'name']),
  ];
  return candidates.find((value) => Boolean(value?.trim()))?.trim();
}

async function reply(ctx: WorkforceCtx, to: string, text: string): Promise<void> {
  const result = await ctx.relay.dm(to, text);
  if (!result.ok) throw new Error(`Relay DM delivery failed for ${to}`);
}

function revternalKey(): string | undefined {
  const key = process.env.REVTERNAL_API_KEY?.trim();
  return key || undefined;
}

function cadenceMs(cadence: WatchCadence): number {
  return {
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  }[cadence];
}

function resultId(result: ListenResult): string | undefined {
  const sourceId = result.source_id ?? result.id;
  return sourceId ? `${result.platform ?? 'unknown'}:${sourceId}` : undefined;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function deepString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return asString(current);
}
