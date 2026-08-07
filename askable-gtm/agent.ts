import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx,
} from '@agentworkforce/runtime';
import { ASKABLE_GTM_CAPABILITY } from './capabilities.js';

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

export interface ListenRequest {
  query: string;
  sources: Array<{ platform: 'reddit'; subreddits: string[]; limit: number }>;
  filters: { timeline: 'week'; languages: string[]; exclude_nsfw: boolean };
  sort_by: 'relevance_score';
  page: number;
  per_page: number;
}

export type CredentialSource = 'user' | 'managed';

export interface ListenGatewayResult {
  data: ListenResponse;
  access: {
    credentialSource: CredentialSource;
    /** Normalized, allowlisted display host emitted by the server-side bridge. */
    endpointHost: string;
  };
}

export interface ListenGateway {
  status: 'configured' | 'blocked';
  listen(request: ListenRequest): Promise<ListenGatewayResult>;
}

export type ListenGatewayErrorCode =
  | 'connection-required'
  | 'managed-access-denied'
  | 'quota-exhausted'
  | 'provider-auth-failed'
  | 'provider-rate-limited'
  | 'provider-unavailable'
  | 'invalid-response'
  | 'request-failed';

export class ListenGatewayError extends Error {
  constructor(readonly code: ListenGatewayErrorCode) {
    super(code);
    this.name = 'ListenGatewayError';
  }
}

const BLOCKED_NANGO_GATEWAY: ListenGateway = {
  status: 'blocked',
  async listen() {
    throw new Error('Revternal Nango action bridge is not available');
  },
};

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

export async function handleRelayMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  gateway: ListenGateway = BLOCKED_NANGO_GATEWAY,
): Promise<void> {
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
      runtimeDataAccess: gateway.status === 'configured'
        ? 'nango-gateway-configured-authorization-checked-per-request'
        : 'blocked-no-nango-action-bridge',
    }));
    return;
  }
  if (command.kind === 'capabilities-human') {
    await reply(ctx, sender, renderCapabilities(gateway.status));
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
        + (gateway.status === 'configured'
          ? 'The Nango query gateway is configured; credential and entitlement are checked on each run.'
          : 'Live execution is blocked until Cloud supplies the Revternal Nango action bridge.'),
    );
    return;
  }

  await answerQuestion(ctx, sender, command.query, gateway);
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
  gateway: ListenGateway,
): Promise<ListenGatewayResult> {
  return gateway.listen({
    query,
    sources: [{ platform: 'reddit', subreddits: ['all'], limit: 20 }],
    filters: { timeline: 'week', languages: ['en'], exclude_nsfw: true },
    sort_by: 'relevance_score',
    page: 1,
    per_page: 20,
  });
}

export async function runWatchSweep(
  ctx: WorkforceCtx,
  now: Date,
  gateway: ListenGateway = BLOCKED_NANGO_GATEWAY,
): Promise<void> {
  if (gateway.status === 'blocked') {
    ctx.log('warn', 'askable-gtm.sweep-blocked', {
      reason: 'Revternal Nango action bridge is not available',
    });
    return;
  }

  const state = await loadWatchState(ctx);
  let changed = false;
  for (const watch of state.watches) {
    if (!watchIsDue(watch, now)) continue;
    try {
      const result = await queryListen(watch.query, gateway);
      const response = result.data;
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
        await reply(ctx, watch.owner, renderListenAnswer(watch.query, response, fresh, result.access));
      }
    } catch (error) {
      ctx.log('error', 'askable-gtm.watch-failed', {
        watchId: watch.id,
        errorCode: safeGatewayErrorCode(error),
      });
    }
  }
  if (changed) await saveWatchState(ctx, state.watches);
}

async function answerQuestion(
  ctx: WorkforceCtx,
  sender: string,
  query: string,
  gateway: ListenGateway,
): Promise<void> {
  if (gateway.status === 'blocked') {
    await reply(
      ctx,
      sender,
      'Live public-signal search is blocked: Cloud has not supplied the Revternal Nango '
        + 'action bridge. I can still describe my manifest and manage watch definitions. '
        + 'Send “capabilities --json” for the exact machine-readable status.',
    );
    return;
  }
  try {
    const result = await queryListen(query, gateway);
    await reply(
      ctx,
      sender,
      renderListenAnswer(query, result.data, result.data.results ?? [], result.access),
    );
  } catch (error) {
    const errorCode = safeGatewayErrorCode(error);
    ctx.log('error', 'askable-gtm.question-failed', { errorCode });
    await reply(ctx, sender, renderGatewayFailure(errorCode));
  }
}

export function renderListenAnswer(
  query: string,
  response: ListenResponse,
  results: ListenResult[],
  access?: ListenGatewayResult['access'],
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
    ...(access ? [renderAccessDisclosure(access)] : []),
    items.length ? items.join('\n') : 'No results were returned.',
    'Source facts are shown above; themes or intent require separate inference.',
  ].join('\n');
}

export function renderCapabilities(gatewayStatus: ListenGateway['status']): string {
  return [
    'I am GTM Signal Scout, an askable proactive-agent prototype.',
    'Verified here: machine-readable self-description and durable watch-definition management.',
    `Live Revternal search: ${gatewayStatus === 'configured' ? 'Nango gateway configured; credential and entitlement are checked per request, and result quality remains unverified' : 'blocked until Cloud supplies the Revternal Nango action bridge'}.`,
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

function renderAccessDisclosure(access: ListenGatewayResult['access']): string {
  const host = safeDisplayHost(access.endpointHost);
  return access.credentialSource === 'managed'
    ? `Access: Agent Workforce managed Revternal access; usage counts against your paid allowance. Host: ${host}.`
    : `Access: your Nango-connected Revternal credential. Host: ${host}.`;
}

function safeDisplayHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (host.length < 1 || host.length > 253) return 'not disclosed';
  if (!/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/u.test(host)) {
    return 'not disclosed';
  }
  return host;
}

function safeGatewayErrorCode(error: unknown): ListenGatewayErrorCode {
  return error instanceof ListenGatewayError ? error.code : 'request-failed';
}

function renderGatewayFailure(code: ListenGatewayErrorCode): string {
  if (code === 'connection-required') {
    return 'Revternal access is not connected. Add the credential and endpoint in Workspace Integrations.';
  }
  if (code === 'managed-access-denied') {
    return 'Managed Revternal access is not authorized for this workspace. Connect your own credential or upgrade.';
  }
  if (code === 'quota-exhausted') {
    return 'The Revternal allowance for this workspace is exhausted. No provider request was made.';
  }
  return `Revternal query failed safely (${code}). No provider response detail was logged.`;
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
