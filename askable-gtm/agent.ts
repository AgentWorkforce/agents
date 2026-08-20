import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx,
} from '@agentworkforce/runtime';
import { randomUUID } from 'node:crypto';
import {
  BLOCKED_CLOUD_INTEGRATION_ACTION_CLIENT_REASON,
  CloudIntegrationActionError,
  createCloudIntegrationActionClient,
} from '../shared/cloud-integration-actions.js';
import { ASKABLE_GTM_CAPABILITY } from './capabilities.js';

const MAX_SEEN_IDS = 500;
const MAX_WATCH_STATE_CAS_ATTEMPTS = 8;
const WATCH_CLAIM_LEASE_MS = 30 * 60 * 1000;

export const WATCH_STATE_PATH = '/revternal/_agents/askable-gtm/watch-state.json';

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
  runClaim?: {
    id: string;
    claimedAt: string;
  };
}

export interface WatchState {
  kind: 'askable-gtm watch state';
  version: 1;
  updatedAt: string;
  watches: WatchDefinition[];
}

export interface WatchStateSnapshot {
  state: WatchState;
  revision: string;
}

export interface WatchStateStore {
  read(): Promise<WatchStateSnapshot>;
  compareAndSet(expectedRevision: string, state: WatchState): Promise<boolean>;
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
    /** Normalized, allowlisted host for the documented provider endpoint or local fallback. */
    endpointHost: string;
  };
}

export interface ListenGateway {
  status: 'configured' | 'blocked';
  listen(request: ListenRequest): Promise<ListenGatewayResult>;
}

export type ListenGatewayErrorCode =
  | 'invalid-query'
  | 'connection-required'
  | 'managed-access-denied'
  | 'quota-exhausted'
  | 'provider-auth-failed'
  | 'provider-rate-limited'
  | 'provider-unavailable'
  | 'invalid-response'
  | 'request-failed';

export class ListenGatewayError extends Error {
  constructor(readonly code: ListenGatewayErrorCode, message: string = code) {
    super(message);
    this.name = 'ListenGatewayError';
  }
}

const REVTERNAL_ENDPOINT_HOST = 'api.revternal.com';

const BLOCKED_NANGO_GATEWAY: ListenGateway = {
  status: 'blocked',
  async listen() {
    throw new Error(BLOCKED_CLOUD_INTEGRATION_ACTION_CLIENT_REASON);
  },
};

export function createCloudApiListenGateway(
  ctx: WorkforceCtx,
  fetchImpl: typeof fetch = fetch,
): ListenGateway {
  const actionClient = createCloudIntegrationActionClient(ctx, fetchImpl);
  if (actionClient.status === 'blocked') {
    return BLOCKED_NANGO_GATEWAY;
  }

  return {
    status: 'configured',
    async listen(request) {
      try {
        const result = await actionClient.invoke({
          provider: 'revternal',
          action: 'social-listen',
          input: request,
        });
        return {
          data: normalizeListenResponse(result.result),
          access: {
            credentialSource: 'user',
            endpointHost: REVTERNAL_ENDPOINT_HOST,
          },
        };
      } catch (error) {
        if (error instanceof ListenGatewayError) {
          throw error;
        }
        throw mapCloudActionError(error);
      }
    },
  };
}

function mapCloudActionError(error: unknown): ListenGatewayError {
  if (!(error instanceof CloudIntegrationActionError)) {
    return new ListenGatewayError('request-failed');
  }

  if (error.code === 'integration_not_found') {
    return new ListenGatewayError(
      'connection-required',
      'Revternal is not connected for this workspace.',
    );
  }

  if (error.code === 'action_rate_limited' || isRateLimitedError(error)) {
    return new ListenGatewayError('provider-rate-limited', error.message);
  }

  if (isProviderAuthFailure(error)) {
    return new ListenGatewayError('provider-auth-failed', error.message);
  }

  if (error.code === 'invalid_response') {
    return new ListenGatewayError('invalid-response', error.message);
  }

  if ((error.details.upstream?.status ?? 0) >= 500) {
    return new ListenGatewayError('provider-unavailable', error.message);
  }

  return new ListenGatewayError('request-failed', error.message);
}

function isRateLimitedError(error: CloudIntegrationActionError): boolean {
  if (error.details.upstream?.status === 429) {
    return true;
  }

  const type = error.details.upstream?.type?.toLowerCase();
  const code = error.details.upstream?.code?.toLowerCase();
  const message = error.details.upstream?.message?.toLowerCase() ?? '';
  return type === 'rate_limited'
    || code === 'rate_limited'
    || message.includes('rate limit');
}

function isProviderAuthFailure(error: CloudIntegrationActionError): boolean {
  const status = error.details.upstream?.status;
  const type = error.details.upstream?.type?.toLowerCase() ?? '';
  const code = error.details.upstream?.code?.toLowerCase() ?? '';
  const message = error.details.upstream?.message?.toLowerCase() ?? '';
  return status === 401
    || status === 403
    || type.includes('auth')
    || code.includes('auth')
    || message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('authentication');
}

function readString(
  value: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function readInteger(
  value: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isInteger(candidate)
    ? candidate
    : undefined;
}

function readRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const candidate = value?.[key];
  return isRecord(candidate) ? candidate : null;
}

function normalizeListenResponse(value: unknown): ListenResponse {
  if (!isRecord(value)) {
    throw new ListenGatewayError('invalid-response');
  }

  const meta = readRecord(value, 'meta');
  if (!Array.isArray(value.results)) {
    throw new ListenGatewayError('invalid-response');
  }
  const rawResults = value.results;
  const rawSourceStatus = readRecord(value, 'source_status');

  return {
    ...(meta
      ? {
          meta: {
            ...(readString(meta, 'query') ? { query: readString(meta, 'query') } : {}),
            ...(readInteger(meta, 'total_results') !== undefined
              ? { total_results: readInteger(meta, 'total_results') }
              : {}),
            ...(Array.isArray(meta.sources_queried)
              ? {
                  sources_queried: meta.sources_queried.filter(
                    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
                  ),
                }
              : {}),
            ...(readString(meta, 'fetched_at') ? { fetched_at: readString(meta, 'fetched_at') } : {}),
            ...(readInteger(meta, 'page') !== undefined ? { page: readInteger(meta, 'page') } : {}),
            ...(readInteger(meta, 'per_page') !== undefined
              ? { per_page: readInteger(meta, 'per_page') }
              : {}),
          },
        }
      : {}),
    results: rawResults.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      const communityName = readString(entry, 'community_name');
      const communityUrl = readString(entry, 'community_url');
      const authorHandle = readString(entry, 'author_handle');
      const authorProfile = readString(entry, 'author_profile_url');

      return [{
        ...(readString(entry, 'source_id') ? { source_id: readString(entry, 'source_id') } : {}),
        ...(readString(entry, 'source_id') ? { id: readString(entry, 'source_id') } : {}),
        ...(readString(entry, 'source_platform') ? { platform: readString(entry, 'source_platform') } : {}),
        ...(readString(entry, 'source_url') ? { url: readString(entry, 'source_url') } : {}),
        ...(readString(entry, 'permalink') ? { permalink: readString(entry, 'permalink') } : {}),
        ...(readString(entry, 'created_at') ? { created_at: readString(entry, 'created_at') } : {}),
        ...(readString(entry, 'title') ? { title: readString(entry, 'title') } : {}),
        ...(readString(entry, 'body_text') ? { body_text: readString(entry, 'body_text') } : {}),
        ...(readInteger(entry, 'score_count') !== undefined
          ? { score_count: readInteger(entry, 'score_count') }
          : {}),
        ...(readInteger(entry, 'comment_count') !== undefined
          ? { comment_count: readInteger(entry, 'comment_count') }
          : {}),
        ...(communityName || communityUrl
          ? {
              community: {
                ...(communityName ? { name: communityName } : {}),
                ...(communityUrl ? { url: communityUrl } : {}),
              },
            }
          : {}),
        ...(authorHandle || authorProfile
          ? {
              author: {
                ...(authorHandle ? { handle: authorHandle } : {}),
                ...(authorProfile ? { profile: authorProfile } : {}),
              },
            }
          : {}),
      }];
    }),
    ...(rawSourceStatus
      ? {
          source_status: Object.fromEntries(
            Object.entries(rawSourceStatus)
              .filter(([, status]) => isRecord(status))
              .map(([source, status]) => [
                source,
                {
                  ...(readString(status, 'status') ? { status: readString(status, 'status') } : {}),
                  ...(readInteger(status, 'count') !== undefined
                    ? { count: readInteger(status, 'count') }
                    : {}),
                  ...(readInteger(status, 'latency_ms') !== undefined
                    ? { latency: readInteger(status, 'latency_ms') }
                    : {}),
                  ...(status.error === null || typeof status.error === 'string'
                    ? { error: status.error as string | null }
                    : {}),
                },
              ]),
          ),
        }
      : {}),
  };
}

export type ParsedCommand =
  | { kind: 'capabilities-json' }
  | { kind: 'capabilities-human' }
  | { kind: 'list-watches' }
  | { kind: 'remove-watch'; id: string }
  | { kind: 'create-watch'; query: string; cadence: WatchCadence }
  | { kind: 'question'; query: string };

export default defineAgent({
  // User watch definitions live in revisioned Relayfile state. This one
  // deploy-time Relaycron schedule evaluates which definitions are due every
  // 15 minutes.
  schedules: [{ name: 'watch-sweep', cron: WATCH_SWEEP_CRON, tz: 'UTC' }],

  handler: async (ctx, event) => {
    const gateway = createCloudApiListenGateway(ctx);
    if (isRelaycastMessageEvent(event)) {
      await handleRelayMessage(ctx, event, gateway);
      return;
    }
    if (isCronTickEvent(event)) {
      await runWatchSweep(ctx, new Date(), gateway);
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
  stateStore?: WatchStateStore,
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
        : 'blocked-missing-cloud-runtime-credentials',
    }));
    return;
  }
  if (command.kind === 'capabilities-human') {
    await reply(ctx, sender, renderCapabilities(gateway.status));
    return;
  }
  if (command.kind === 'list-watches') {
    const state = (await resolveWatchStateStore(ctx, stateStore).read()).state;
    await reply(ctx, sender, renderWatches(state.watches.filter((watch) => watch.owner === sender)));
    return;
  }
  if (command.kind === 'remove-watch') {
    const removed = await mutateWatchState(
      resolveWatchStateStore(ctx, stateStore),
      (state) => {
        const remaining = state.watches.filter(
          (watch) => !(watch.id === command.id && watch.owner === sender),
        );
        if (remaining.length === state.watches.length) {
          return { changed: false, value: false };
        }
        state.watches = remaining;
        return { changed: true, value: true };
      },
    );
    if (!removed) {
      await reply(ctx, sender, `I could not find watch ${command.id} owned by you.`);
      return;
    }
    await reply(ctx, sender, `Removed watch ${command.id}.`);
    return;
  }
  if (command.kind === 'create-watch') {
    let watch: WatchDefinition;
    try {
      watch = createWatch(command.query, command.cadence, sender, new Date());
    } catch (error) {
      await reply(ctx, sender, error instanceof Error ? error.message : 'Invalid watch request.');
      return;
    }
    await mutateWatchState(
      resolveWatchStateStore(ctx, stateStore),
      (state) => {
        const withoutDuplicate = state.watches.filter(
          (candidate) => !(candidate.owner === sender && candidate.query === watch.query),
        );
        state.watches = [...withoutDuplicate, watch];
        return { changed: true, value: undefined };
      },
    );
    await reply(
      ctx,
      sender,
        `Saved ${watch.id}: “${watch.query}” every ${watch.cadence}. `
        + 'It is evaluated by the agent’s shared 15-minute recurring sweep; '
        + 'this did not create a per-watch Relaycron schedule. '
        + (gateway.status === 'configured'
          ? 'The Nango query gateway is configured; credential and entitlement are checked on each run.'
          : 'Live execution is unavailable in this runtime until the persona is deployed in Cloud with a connected Revternal integration.'),
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
  const cleaned = normalizeListenQuery(query, 'Watch query');
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
  const normalizedQuery = normalizeListenQuery(query, 'Query');
  return gateway.listen({
    query: normalizedQuery,
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
  stateStore?: WatchStateStore,
  claimIdFactory: () => string = () => `claim-${randomUUID()}`,
): Promise<void> {
  if (gateway.status === 'blocked') {
    ctx.log('warn', 'askable-gtm.sweep-blocked', {
      reason: BLOCKED_CLOUD_INTEGRATION_ACTION_CLIENT_REASON,
    });
    return;
  }

  const store = resolveWatchStateStore(ctx, stateStore);
  const state = (await store.read()).state;
  for (const candidate of state.watches) {
    const watch = await claimDueWatch(store, candidate.id, now, claimIdFactory());
    if (!watch) continue;
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
      if (fresh.length > 0) {
        await reply(ctx, watch.owner, renderListenAnswer(watch.query, response, fresh, result.access));
      }
      await finalizeWatchRun(
        store,
        watch,
        results.map(resultId).filter((id): id is string => Boolean(id)),
        now,
        response.meta?.fetched_at,
      );
    } catch (error) {
      await releaseWatchClaim(store, watch.id, watch.runClaim?.id).catch(() => undefined);
      ctx.log('error', 'askable-gtm.watch-failed', {
        watchId: watch.id,
        errorCode: safeGatewayErrorCode(error),
      });
    }
  }
}

async function answerQuestion(
  ctx: WorkforceCtx,
  sender: string,
  query: string,
  gateway: ListenGateway,
): Promise<void> {
  let normalizedQuery: string;
  try {
    normalizedQuery = normalizeListenQuery(query, 'Query');
  } catch (error) {
    await reply(ctx, sender, error instanceof Error ? error.message : 'Invalid query.');
    return;
  }
  if (gateway.status === 'blocked') {
    await reply(
      ctx,
      sender,
      'Live public-signal search is unavailable in this runtime. Deploy the persona in Cloud '
        + 'and connect Revternal from Workspace Integrations. I can still describe my manifest '
        + 'and manage watch definitions. '
        + 'Send “capabilities --json” for the exact machine-readable status.',
    );
    return;
  }
  try {
    const result = await queryListen(normalizedQuery, gateway);
    await reply(
      ctx,
      sender,
      renderListenAnswer(normalizedQuery, result.data, result.data.results ?? [], result.access),
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
  const watchOperation = ASKABLE_GTM_CAPABILITY.operations.find(
    (operation) => operation.id === 'manage-watch-definitions',
  );
  const watchSyntax = watchOperation?.accepts.find((value) => value.startsWith('watch '))
    ?? 'not advertised';
  const designedQuestions = ASKABLE_GTM_CAPABILITY.questions
    .map((question) => question.example)
    .join(' ');
  return [
    'I am GTM Signal Scout, an askable proactive-agent prototype.',
    'Verified here: machine-readable self-description and durable watch-definition management.',
    `Live Revternal search: ${gatewayStatus === 'configured' ? 'a connected Revternal workspace integration is configured; credential and entitlement are checked per request, and result quality remains unverified' : 'available only in a cloud runtime with a connected Revternal workspace integration'}.`,
    `Designed questions: ${designedQuestions}`,
    `Watch syntax: ${watchSyntax}.`,
    `Scheduling: ${watchOperation?.recurrence.mechanism ?? 'not advertised'} at ${watchOperation?.recurrence.sweepCron ?? 'not advertised'}; per-watch Relaycron schedule: ${String(watchOperation?.recurrence.perWatchRelaycronSchedule ?? false)}.`,
    'Send “capabilities --json” for the complete machine-readable manifest.',
  ].join('\n');
}

function renderWatches(watches: WatchDefinition[]): string {
  if (watches.length === 0) return 'You have no saved GTM watches.';
  return watches
    .map((watch) => `${watch.id} · every ${watch.cadence} · ${watch.query}`)
    .join('\n');
}

export function createRelayfileWatchStateStore(
  ctx: WorkforceCtx,
  fetchImpl: typeof fetch = fetch,
): WatchStateStore {
  const credentials = ctx.credentials.tryRequire()?.relayfile;
  if (!credentials) {
    throw new Error('Durable watch state is unavailable: Relayfile credentials are required');
  }
  const fileUrl = new URL(
    `/v1/workspaces/${encodeURIComponent(credentials.workspaceId)}/fs/file`,
    `${credentials.url.replace(/\/+$/u, '')}/`,
  );
  fileUrl.searchParams.set('path', WATCH_STATE_PATH);

  return {
    async read() {
      const response = await fetchImpl(fileUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${credentials.token}` },
      });
      if (response.status === 404) {
        return { state: emptyWatchState(), revision: '0' };
      }
      if (!response.ok) {
        throw new Error(`Durable watch state read failed (${response.status})`);
      }
      const body = await response.json() as { content?: unknown; revision?: unknown };
      const value = typeof body.content === 'string'
        ? parseWatchState(body.content)
        : undefined;
      if (!value) throw new Error('Durable watch state is invalid');
      const revision = typeof body.revision === 'string'
        ? body.revision
        : response.headers.get('etag');
      if (!revision) throw new Error('Durable watch state read did not return a revision');
      return { state: value, revision };
    },
    async compareAndSet(expectedRevision, state) {
      const response = await fetchImpl(fileUrl, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${credentials.token}`,
          'content-type': 'application/json',
          'if-match': expectedRevision,
        },
        body: JSON.stringify(state),
      });
      if (response.status === 409 || response.status === 412) return false;
      if (!response.ok) {
        throw new Error(`Durable watch state write failed (${response.status})`);
      }
      return true;
    },
  };
}

function resolveWatchStateStore(
  ctx: WorkforceCtx,
  stateStore?: WatchStateStore,
): WatchStateStore {
  return stateStore ?? createRelayfileWatchStateStore(ctx);
}

type WatchStateMutation<T> =
  | { changed: false; value: T }
  | { changed: true; value: T };

async function mutateWatchState<T>(
  store: WatchStateStore,
  mutate: (state: WatchState) => WatchStateMutation<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_WATCH_STATE_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = await store.read();
    const state = cloneWatchState(snapshot.state);
    const result = mutate(state);
    if (!result.changed) return result.value;
    state.updatedAt = new Date().toISOString();
    if (await store.compareAndSet(snapshot.revision, state)) return result.value;
  }
  throw new Error('Durable watch state changed too many times; retry the request');
}

async function claimDueWatch(
  store: WatchStateStore,
  watchId: string,
  now: Date,
  claimId: string,
): Promise<WatchDefinition | undefined> {
  return mutateWatchState(store, (state) => {
    const watch = state.watches.find((candidate) => candidate.id === watchId);
    if (!watch || !watchIsDue(watch, now)) {
      return { changed: false, value: undefined };
    }
    if (watch.runClaim && !claimIsExpired(watch.runClaim, now)) {
      return { changed: false, value: undefined };
    }
    watch.runClaim = { id: claimId, claimedAt: now.toISOString() };
    return { changed: true, value: cloneWatch(watch) };
  });
}

async function finalizeWatchRun(
  store: WatchStateStore,
  claimedWatch: WatchDefinition,
  observedIds: string[],
  now: Date,
  fetchedAt?: string,
): Promise<void> {
  const claimId = claimedWatch.runClaim?.id;
  if (!claimId) throw new Error('Cannot finalize a watch run without a claim');
  const finalized = await mutateWatchState(store, (state) => {
    const watch = state.watches.find((candidate) => candidate.id === claimedWatch.id);
    if (!watch || watch.runClaim?.id !== claimId) {
      return { changed: false, value: false };
    }
    watch.seenIds = unique([...observedIds, ...watch.seenIds]).slice(0, MAX_SEEN_IDS);
    watch.lastRunAt = now.toISOString();
    watch.lastFetchedAt = fetchedAt;
    delete watch.runClaim;
    return { changed: true, value: true };
  });
  if (!finalized) {
    throw new Error('Watch delivery could not be committed because its claim changed');
  }
}

async function releaseWatchClaim(
  store: WatchStateStore,
  watchId: string,
  claimId?: string,
): Promise<void> {
  if (!claimId) return;
  await mutateWatchState(store, (state) => {
    const watch = state.watches.find((candidate) => candidate.id === watchId);
    if (!watch || watch.runClaim?.id !== claimId) {
      return { changed: false, value: undefined };
    }
    delete watch.runClaim;
    return { changed: true, value: undefined };
  });
}

function claimIsExpired(claim: NonNullable<WatchDefinition['runClaim']>, now: Date): boolean {
  const claimedAt = new Date(claim.claimedAt).getTime();
  return !Number.isFinite(claimedAt) || now.getTime() - claimedAt >= WATCH_CLAIM_LEASE_MS;
}

function parseWatchState(content: string): WatchState | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    return validWatchState(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function cloneWatchState(state: WatchState): WatchState {
  return {
    ...state,
    watches: state.watches.map(cloneWatch),
  };
}

function cloneWatch(watch: WatchDefinition): WatchDefinition {
  return {
    ...watch,
    seenIds: [...watch.seenIds],
    ...(watch.runClaim ? { runClaim: { ...watch.runClaim } } : {}),
  };
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
    && Array.isArray(value.watches)
    && value.watches.every(validWatchDefinition);
}

function validWatchDefinition(value: unknown): value is WatchDefinition {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string'
    || typeof value.query !== 'string'
    || typeof value.cadence !== 'string'
    || typeof value.owner !== 'string'
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.seenIds)
    || !value.seenIds.every((id) => typeof id === 'string')) {
    return false;
  }
  if (value.runClaim === undefined) return true;
  return isRecord(value.runClaim)
    && typeof value.runClaim.id === 'string'
    && typeof value.runClaim.claimedAt === 'string';
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
    ? `Access: Agent Workforce managed Revternal access; usage counts against your paid allowance. Documented endpoint: ${host}.`
    : `Access: your Nango-connected Revternal credential. Documented endpoint: ${host}.`;
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
  if (code === 'invalid-query') {
    return 'Query must contain between 2 and 500 characters.';
  }
  if (code === 'connection-required') {
    return 'Revternal access is not connected. Add the credential and endpoint in Workspace Integrations.';
  }
  if (code === 'managed-access-denied') {
    return 'Managed Revternal access is not authorized for this workspace. Connect your own credential or upgrade.';
  }
  if (code === 'quota-exhausted') {
    return 'The Revternal allowance for this workspace is exhausted. No provider request was made.';
  }
  if (code === 'provider-rate-limited') {
    return 'Revternal rate limit exceeded. Retry later.';
  }
  if (code === 'provider-auth-failed') {
    return 'Revternal authentication failed for the connected workspace integration.';
  }
  if (code === 'provider-unavailable') {
    return 'Revternal is temporarily unavailable. Retry later.';
  }
  if (code === 'invalid-response') {
    return 'Revternal returned an invalid response. No provider response detail was logged.';
  }
  return `Revternal query failed safely (${code}). No provider response detail was logged.`;
}

export function normalizeListenQuery(query: string, label = 'Query'): string {
  const cleaned = query.replace(/\s+/gu, ' ').trim();
  const characterCount = [...cleaned].length;
  if (characterCount < 2 || characterCount > 500) {
    throw new ListenGatewayError(
      'invalid-query',
      `${label} must contain between 2 and 500 characters`,
    );
  }
  return cleaned;
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
