import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx,
} from '@agentworkforce/runtime';
import { randomUUID } from 'node:crypto';
import { slackClient } from '@relayfile/relay-helpers';
import {
  BLOCKED_CLOUD_INTEGRATION_ACTION_CLIENT_REASON,
  CloudIntegrationActionError,
  createCloudIntegrationActionClient,
} from '../shared/cloud-integration-actions.js';
import {
  defaultSlack,
  postReply,
  readSlackMessage,
  skipReason as slackSkipReason,
  stripLeadingMention,
  type SlackPoster,
} from '../shared/slack.js';
import { ASKABLE_GTM_CAPABILITY } from './capabilities.js';

const MAX_SEEN_IDS = 500;
const MAX_WATCH_STATE_CAS_ATTEMPTS = 8;
const WATCH_CLAIM_LEASE_MS = 30 * 60 * 1000;
const SLACK_WRITEBACK_TIMEOUT_MS = 15_000;
const RELAY_OWNER_PREFIX = 'relay:';
const SLACK_OWNER_PREFIX = 'slack:';

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

interface InteractiveActor {
  ownerKey: string;
  reply(text: string): Promise<void>;
  owns(watchOwner: string): boolean;
  /**
   * Transport-specific presentation for a machine-readable payload. Relay is a
   * machine surface — `capabilities --json` is documented as a parseable
   * response and an agent or catalog calls `JSON.parse` on it — so relay leaves
   * it exactly as-is. Slack is a human surface, where an unfenced 4KB blob is
   * an unreadable wall, so Slack fences it. Default: unchanged.
   */
  presentJson?(json: string): string;
}

interface SlackDirectMessenger {
  dm(user: string, text: string): Promise<{ ts?: string } | undefined>;
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

export type CredentialSource = 'user' | 'managed' | 'unknown';

export interface ListenGatewayResult {
  data: ListenResponse;
  access: {
    credentialSource: CredentialSource;
    /** Normalized, allowlisted host for the documented provider endpoint. */
    endpointHost: string;
  };
}

export interface LinkedInSearchRequest {
  keywords: string;
  recency: 'Day' | 'Week' | 'Month' | 'Quarter' | 'HalfYear' | 'Year';
}

export interface ListenGateway {
  status: 'configured' | 'blocked';
  listen(request: ListenRequest): Promise<ListenGatewayResult>;
  /**
   * Revternal's LinkedIn listener. Optional so a gateway double that only
   * models `social-listen` stays valid: a gateway without it simply reports no
   * LinkedIn coverage rather than failing the whole query.
   */
  searchLinkedIn?(request: LinkedInSearchRequest): Promise<ListenGatewayResult>;
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

const DOCUMENTED_REVTERNAL_ENDPOINT_HOST = 'api.revternal.com';

const BLOCKED_CLOUD_GATEWAY: ListenGateway = {
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
    return BLOCKED_CLOUD_GATEWAY;
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
          access: normalizeGatewayAccess(result.access),
        };
      } catch (error) {
        if (error instanceof ListenGatewayError) {
          throw error;
        }
        throw mapCloudActionError(error);
      }
    },
    async searchLinkedIn(request) {
      try {
        const result = await actionClient.invoke({
          provider: 'revternal',
          action: 'linkedin-post-search',
          input: request,
        });
        return {
          data: normalizeLinkedInResponse(result.result),
          access: normalizeGatewayAccess(result.access),
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

/**
 * Fold a LinkedIn post-search response into the same `ListenResponse` shape the
 * Reddit path produces, so evidence rendering, coverage classification, watch
 * diffing and the sweep all stay source-agnostic.
 */
export function normalizeLinkedInResponse(value: unknown): ListenResponse {
  if (!isRecord(value)) {
    throw new ListenGatewayError('invalid-response');
  }
  const rawPosts = value.posts;
  if (!Array.isArray(rawPosts)) {
    throw new ListenGatewayError('invalid-response');
  }

  const results = rawPosts.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const postId = readString(entry, 'post_id');
    if (!postId) return [];

    const author = readRecord(entry, 'author');
    const authorName = author ? readString(author, 'name') : undefined;
    const authorUrl = author ? readString(author, 'linkedin_url') : undefined;
    const engagement = readRecord(entry, 'engagement');
    const likes = engagement ? readInteger(engagement, 'likes') : undefined;
    const comments = engagement ? readInteger(engagement, 'comments') : undefined;
    const content = readString(entry, 'content');

    return [{
      source_id: postId,
      id: postId,
      platform: 'linkedin',
      ...(readString(entry, 'post_url') ? { url: readString(entry, 'post_url') } : {}),
      ...(readString(entry, 'published_at')
        ? { created_at: readString(entry, 'published_at') }
        : {}),
      // LinkedIn posts have no title; the body doubles as the headline and the
      // renderer already falls back to `body_text`.
      ...(content ? { body_text: content } : {}),
      // `likes` is the closest analogue to a score, so engagement stays
      // comparable across sources in one answer.
      ...(likes !== undefined ? { score_count: likes } : {}),
      ...(comments !== undefined ? { comment_count: comments } : {}),
      ...(authorName || authorUrl
        ? {
            author: {
              ...(authorName ? { handle: authorName } : {}),
              ...(authorUrl ? { profile: authorUrl } : {}),
            },
          }
        : {}),
    }];
  });

  return {
    meta: {
      ...(readString(value, 'keywords') ? { query: readString(value, 'keywords') } : {}),
      total_results: results.length,
      sources_queried: ['linkedin'],
    },
    results,
    source_status: { linkedin: { status: 'ok', count: results.length } },
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

  if (error.details.upstream && (error.code === 'action_rate_limited' || isRateLimitedError(error))) {
    return new ListenGatewayError('provider-rate-limited', error.message);
  }

  if (error.details.upstream && isProviderAuthFailure(error)) {
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

function normalizeGatewayAccess(
  access: { credentialSource?: string; endpointHost?: string } | undefined,
): ListenGatewayResult['access'] {
  return {
    credentialSource:
      access?.credentialSource === 'managed'
        ? 'managed'
        : (access?.credentialSource === 'user' || access?.credentialSource === 'workspace')
          ? 'user'
          : 'unknown',
    endpointHost: typeof access?.endpointHost === 'string' && access.endpointHost.trim().length > 0
      ? access.endpointHost.trim()
      : DOCUMENTED_REVTERNAL_ENDPOINT_HOST,
  };
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
            Object.entries(rawSourceStatus).flatMap(([source, status]) => {
              if (!isRecord(status)) {
                return [];
              }

              return [[
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
              ] as const];
            }),
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
  triggers: {
    // Human chat runs through Slack, not the relay inbox. Match the configured
    // channel and require an @mention so the agent does not wake on every
    // ordinary message in the channel.
    slack: [{ on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'], match: '@mention' }],
  },

  handler: async (ctx, event) => {
    const gateway = createCloudApiListenGateway(ctx);
    if (event.type.startsWith('slack.')) {
      await handleSlackMessage(ctx, event, gateway);
      return;
    }
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
  gateway: ListenGateway = BLOCKED_CLOUD_GATEWAY,
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

  await handleInteractiveCommand(
    ctx,
    {
      ownerKey: relayOwnerKey(sender),
      owns: (owner) => owner === sender || owner === relayOwnerKey(sender),
      reply: (message) => replyRelay(ctx, sender, message),
    },
    text,
    gateway,
    stateStore,
  );
}

export async function handleSlackMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  gateway: ListenGateway = BLOCKED_CLOUD_GATEWAY,
  stateStore?: WatchStateStore,
  deps: { slack?: SlackPoster } = {},
): Promise<void> {
  const full = await event.expand('full').catch(() => undefined);
  const payload = isRecord(full) ? (full.data ?? full) : full;
  const message = readSlackMessage(payload);
  if (!message) {
    ctx.log('warn', 'askable-gtm.unreplyable-slack-message', { reason: 'unparseable-payload' });
    return;
  }
  const configuredChannel = input(ctx, 'SLACK_CHANNEL');
  const skip = slackSkipReason(message, configuredChannel);
  if (skip) {
    ctx.log('info', 'askable-gtm.slack-skipped', {
      reason: skip,
      channel: message.channel,
      configuredChannel: configuredChannel ?? null,
    });
    return;
  }
  if (!message.user) {
    ctx.log('warn', 'askable-gtm.unreplyable-slack-message', { reason: 'missing-user-id' });
    return;
  }

  await handleInteractiveCommand(
    ctx,
    {
      ownerKey: slackOwnerKey(message.user),
      owns: (owner) => owner === slackOwnerKey(message.user!),
      // Answer a top-level mention in a thread beneath it. Several agents share
      // one Slack identity, so a single `@Agent Relay` mention can draw a reply
      // from each of them; threading keeps the channel readable and each answer
      // attached to its question. This persona keeps no cross-turn Slack
      // context, so moving the conversation unit to the thread costs nothing.
      reply: (text) => postReply(ctx, deps.slack ?? defaultSlack(), message, text, {
        startThread: true,
      }),
      presentJson: presentJsonForSlack,
    },
    stripLeadingMention(message.text).trim(),
    gateway,
    stateStore,
  );
}

async function handleInteractiveCommand(
  ctx: WorkforceCtx,
  actor: InteractiveActor,
  text: string,
  gateway: ListenGateway,
  stateStore?: WatchStateStore,
): Promise<void> {
  const command = parseCommand(text);
  if (command.kind === 'capabilities-json') {
    const json = renderCapabilitiesJson(gateway.status);
    await actor.reply(actor.presentJson ? actor.presentJson(json) : json);
    return;
  }
  if (command.kind === 'capabilities-human') {
    await actor.reply(renderCapabilities(gateway.status));
    return;
  }
  if (command.kind === 'list-watches') {
    const state = (await resolveWatchStateStore(ctx, stateStore).read()).state;
    await actor.reply(renderWatches(state.watches.filter((watch) => actor.owns(watch.owner))));
    return;
  }
  if (command.kind === 'remove-watch') {
    const removed = await mutateWatchState(
      resolveWatchStateStore(ctx, stateStore),
      (state) => {
        const remaining = state.watches.filter(
          (watch) => !(watch.id === command.id && actor.owns(watch.owner)),
        );
        if (remaining.length === state.watches.length) {
          return { changed: false, value: false };
        }
        state.watches = remaining;
        return { changed: true, value: true };
      },
    );
    if (!removed) {
      await actor.reply(`I could not find watch ${command.id} owned by you.`);
      return;
    }
    await actor.reply(`Removed watch ${command.id}.`);
    return;
  }
  if (command.kind === 'create-watch') {
    let watch: WatchDefinition;
    try {
      watch = createWatch(command.query, command.cadence, actor.ownerKey, new Date());
    } catch (error) {
      await actor.reply(error instanceof Error ? error.message : 'Invalid watch request.');
      return;
    }
    await mutateWatchState(
      resolveWatchStateStore(ctx, stateStore),
      (state) => {
        const withoutDuplicate = state.watches.filter(
          (candidate) => !(candidate.owner === watch.owner && candidate.query === watch.query),
        );
        state.watches = [...withoutDuplicate, watch];
        return { changed: true, value: undefined };
      },
    );
    await actor.reply(
        `Saved ${watch.id}: “${watch.query}” every ${watch.cadence}. `
        + 'It is evaluated by the agent’s shared 15-minute recurring sweep; '
        + 'this did not create a per-watch Relaycron schedule. '
        + (gateway.status === 'configured'
          ? 'The Cloud integration action gateway is configured; Revternal connection, credential, and entitlement are checked on each run.'
          : 'Live execution is unavailable in this runtime until the persona is deployed in Cloud with a connected Revternal integration.'),
    );
    return;
  }

  await answerQuestion(ctx, actor.reply.bind(actor), command.query, gateway);
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

/**
 * Query every Revternal source this persona is entitled to and fold the answers
 * into one response. A source that throws is recorded as a failed source rather
 * than failing the whole query, so one provider outage degrades the answer
 * instead of erasing it — `classifyListenCoverage` then reports which sources
 * are missing. Only a total failure surfaces as an error.
 */
export async function queryListen(
  query: string,
  gateway: ListenGateway,
): Promise<ListenGatewayResult> {
  const normalizedQuery = normalizeListenQuery(query, 'Query');

  // LinkedIn is the source. Revternal also registers Reddit, but it scrapes
  // Reddit's unauthenticated endpoint and is blocked upstream, so querying it
  // bought a doomed call and a "reddit unavailable" line on every answer that
  // told the reader nothing they could act on. `ListenGateway.listen` stays on
  // the interface: restoring the leg is adding it back to `attempted`.
  const linkedin = gateway.searchLinkedIn?.({
    keywords: normalizedQuery,
    recency: 'Week',
  });

  // Only legs actually attempted are settled and judged, and a lone leg's
  // failure must propagate: an auth failure or exhausted quota is actionable
  // and must never be flattened into "the source is having an outage".
  const attempted: Array<{ source: string; promise: Promise<ListenGatewayResult> }> = [
    ...(linkedin ? [{ source: 'linkedin', promise: linkedin }] : []),
  ];
  if (attempted.length === 0) {
    throw new ListenGatewayError(
      'provider-unavailable',
      'No public-signal source is configured for this runtime.',
    );
  }
  const settled = await Promise.allSettled(attempted.map((leg) => leg.promise));
  const legs = attempted.map((leg, index) => ({ source: leg.source, outcome: settled[index]! }));

  if (legs.every((leg) => leg.outcome.status === 'rejected')) {
    throw (legs[0]!.outcome as PromiseRejectedResult).reason;
  }

  const firstFulfilled = legs.find((leg) => leg.outcome.status === 'fulfilled');
  const access = firstFulfilled
    ? (firstFulfilled.outcome as PromiseFulfilledResult<ListenGatewayResult>).value.access
    : { credentialSource: 'unknown' as CredentialSource, endpointHost: '' };

  const merged: ListenResponse = { results: [], source_status: {} };
  const sourcesQueried: string[] = [];
  let fetchedAt: string | undefined;

  for (const { source, outcome } of legs) {
    if (outcome.status === 'rejected') {
      merged.source_status![source] = {
        status: 'error',
        count: 0,
        error: safeGatewayErrorCode(outcome.reason),
      };
      sourcesQueried.push(source);
      continue;
    }

    const data = outcome.value.data;
    merged.results!.push(...(data.results ?? []));
    fetchedAt ??= data.meta?.fetched_at;
    for (const [name, status] of Object.entries(data.source_status ?? {})) {
      merged.source_status![name] = status;
    }
    // A leg that reported no per-source status still counts as queried.
    if (!data.source_status || Object.keys(data.source_status).length === 0) {
      merged.source_status![source] = { status: 'ok', count: data.results?.length ?? 0 };
    }
    sourcesQueried.push(...(data.meta?.sources_queried ?? [source]));
  }

  merged.meta = {
    query: normalizedQuery,
    total_results: merged.results!.length,
    sources_queried: [...new Set(sourcesQueried)],
    ...(fetchedAt ? { fetched_at: fetchedAt } : {}),
  };

  return { data: merged, access };
}

export async function runWatchSweep(
  ctx: WorkforceCtx,
  now: Date,
  gateway: ListenGateway = BLOCKED_CLOUD_GATEWAY,
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
      // Every source failed: the empty result set describes the provider, not
      // the window. Committing it would advance `lastRunAt` past a window whose
      // posts were never actually seen, so release the claim and retry instead.
      const sweepCoverage = classifyListenCoverage(response);
      if (sweepCoverage.coverage === 'failed') {
        await releaseWatchClaim(store, watch.id, watch.runClaim?.id).catch(() => undefined);
        ctx.log('warn', 'askable-gtm.watch-source-outage', {
          watchId: watch.id,
          failedSources: sweepCoverage.failedSources,
        });
        continue;
      }
      const results = response.results ?? [];
      const previous = new Set(watch.seenIds);
      const fresh = results.filter((result) => {
        const id = resultId(result);
        return Boolean(id && !previous.has(id));
      });
      if (fresh.length > 0) {
        // An interactive answer needs no header — the reader just typed the
        // question. A watch delivery is unsolicited and may arrive hours later
        // alongside other watches, so it must say which one fired.
        await deliverToOwner(
          ctx,
          watch.owner,
          `${renderWatchHeader(watch)}\n${renderListenAnswer(watch.query, response, fresh, result.access)}`,
        );
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
  reply: (text: string) => Promise<void>,
  query: string,
  gateway: ListenGateway,
): Promise<void> {
  let normalizedQuery: string;
  try {
    normalizedQuery = normalizeListenQuery(query, 'Query');
  } catch (error) {
    await reply(error instanceof Error ? error.message : 'Invalid query.');
    return;
  }
  if (gateway.status === 'blocked') {
    await reply(
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
      renderListenAnswer(normalizedQuery, result.data, result.data.results ?? [], result.access),
    );
  } catch (error) {
    const errorCode = safeGatewayErrorCode(error);
    ctx.log('error', 'askable-gtm.question-failed', { errorCode });
    await reply(renderGatewayFailure(errorCode));
  }
}

/**
 * Revternal reports per-source outcomes in `source_status`. A source that
 * failed returns zero rows, so a response where every queried source errored is
 * indistinguishable from "nothing was posted" if you only read `results`.
 * Reporting that as an empty result set would present a provider outage as a
 * finding about the market, which is exactly the gap this persona must never
 * fill. Classify the run instead, and let callers fail closed.
 */
export type ListenCoverage = 'ok' | 'degraded' | 'failed';

export interface ListenCoverageReport {
  coverage: ListenCoverage;
  okSources: string[];
  failedSources: string[];
}

function sourceStatusFailed(status: { status?: string; error?: string | null }): boolean {
  const label = status.status?.trim().toLowerCase();
  if (label === 'error' || label === 'failed' || label === 'failure') return true;
  return typeof status.error === 'string' && status.error.trim().length > 0;
}

export function classifyListenCoverage(response: ListenResponse): ListenCoverageReport {
  const entries = Object.entries(response.source_status ?? {});
  const okSources: string[] = [];
  const failedSources: string[] = [];
  for (const [source, status] of entries) {
    if (sourceStatusFailed(status)) failedSources.push(source);
    else okSources.push(source);
  }

  // No `source_status` at all is not evidence of failure — the documented
  // response makes the group optional — so treat it as reported-ok coverage.
  if (failedSources.length === 0) {
    return { coverage: 'ok', okSources, failedSources };
  }
  return {
    coverage: okSources.length === 0 ? 'failed' : 'degraded',
    okSources,
    failedSources,
  };
}

/**
 * Identify an unsolicited watch delivery. Compact on purpose: enough to tell
 * which saved query fired and to `unwatch` it, without reintroducing the
 * preamble that buries interactive answers.
 */
export function renderWatchHeader(watch: Pick<WatchDefinition, 'id' | 'query' | 'cadence'>): string {
  return `New for \u201c${truncateEvidence(watch.query, 80)}\u201d · every ${watch.cadence} · ${watch.id}`;
}

export function renderListenAnswer(
  /** Retained for the signature; the answer no longer restates the question. */
  _query: string,
  response: ListenResponse,
  results: ListenResult[],
  access?: ListenGatewayResult['access'],
): string {
  const items = results.slice(0, 5).map((result, index) => {
    // Reddit rows carry a title; LinkedIn rows do not, so this falls back to
    // the post body — which is a whole post. Cite an EXCERPT: the answer is a
    // scannable index into the sources, and the link is right there for anyone
    // who wants the rest.
    const excerpt = truncateEvidence(
      result.title ?? result.body_text ?? 'Untitled public post',
    );
    // Attribution: Reddit supplies a community, LinkedIn a public author.
    const attribution = result.community?.name
      ? ` · ${result.community.name}`
      : result.author?.handle
        ? ` · ${result.author.handle}`
        : '';
    const engagement = ` · score ${result.score_count ?? 0} · comments ${result.comment_count ?? 0}`;
    const url = result.url ?? result.permalink ?? '';
    return `${index + 1}. ${excerpt}${attribution}${engagement}${url ? `\n${url}` : ''}`;
  });
  const report = classifyListenCoverage(response);
  const failed = formatSourceList(report.failedSources);
  // Lead with the answer. The question, the fetch timestamp, the endpoint and a
  // standing caveat are all things the reader already knows or can see, and
  // putting four lines of preamble above the results buries them.
  //
  // Two things survive the trim, because dropping them would make the answer
  // dishonest rather than merely terse:
  //   - a missing source, stated compactly. Silently returning LinkedIn-only
  //     results while Reddit is down presents a partial view as a complete one.
  //   - the managed-access disclosure, which the capability manifest marks
  //     `disclosureRequired` because that path is metered and billable. A
  //     user's own connected credential needs no such notice.
  return [
    items.length
      ? items.join('\n')
      : report.coverage === 'failed'
        ? `No evidence could be gathered: every queried source failed (${failed}). `
          + 'This is a source outage, not a finding that nothing was posted. Retry later.'
        : 'No results were returned.',
    ...(report.coverage === 'degraded' ? [`(${failed} unavailable this request)`] : []),
    // `unknown` discloses too: the gateway did not say whether this was the
    // user's credential or the metered managed one, and staying quiet about a
    // charge that might be billable is the wrong way to be wrong.
    ...(access && access.credentialSource !== 'user' ? [renderAccessDisclosure(access)] : []),
  ].join('\n');
}

function formatSourceList(sources: readonly string[]): string {
  if (sources.length === 0) return 'no sources';
  if (sources.length === 1) return sources[0]!;
  return `${sources.slice(0, -1).join(', ')} and ${sources[sources.length - 1]}`;
}

/**
 * The machine-readable manifest, as standalone parseable JSON. Presentation is
 * the transport's business: the capability manifest advertises this command
 * as machine-readable (`discovery.machine`), so wrapping it here would break
 * `JSON.parse` for every agent and catalog that calls it.
 */
export function renderCapabilitiesJson(gatewayStatus: ListenGateway['status']): string {
  return JSON.stringify({
    type: 'askable.capabilities',
    capability: ASKABLE_GTM_CAPABILITY,
    runtimeDataAccess: gatewayStatus === 'configured'
      ? 'cloud-integration-action-gateway-configured-authorization-checked-per-request'
      : 'blocked-missing-cloud-runtime-credentials',
  }, null, 2);
}

/** Slack presentation: fence the payload so Slack renders it as code. */
export function presentJsonForSlack(json: string): string {
  return [
    'GTM Signal Scout — machine-readable capability manifest.',
    'You can also just ask a GTM question in plain language, or send'
      + ' \u201cwhat can you tell me?\u201d for the short version.',
    '```json',
    json,
    '```',
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
    `Live Revternal search: ${gatewayStatus === 'configured' ? 'the Cloud integration action gateway is configured; Revternal connection, credential, and entitlement are checked per request, and result quality remains unverified' : 'available only in a cloud runtime with a connected Revternal workspace integration'}.`,
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
        headers: {
          authorization: `Bearer ${credentials.token}`,
          'x-correlation-id': createWatchStateCorrelationId('read'),
        },
      });
      if (response.status === 404) {
        return { state: emptyWatchState(), revision: '0' };
      }
      if (!response.ok) {
        // A failed read aborts the whole sweep, so say why. Without this the
        // only signal is a bare status code in the run's error field.
        const responseBodyExcerpt = sanitizeWatchStateReadFailureBody(await response.text());
        ctx.log('error', 'askable-gtm.watch-state-read-diag', {
          status: response.status,
          workspaceId: credentials.workspaceId,
          relayfileUrl: credentials.url,
          requestUrl: fileUrl.toString(),
          path: WATCH_STATE_PATH,
          tokenKind: classifyRelayfileToken(credentials.token),
          responseBodyExcerpt,
        });
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
          'x-correlation-id': createWatchStateCorrelationId('write'),
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

function relayOwnerKey(sender: string): string {
  return `${RELAY_OWNER_PREFIX}${sender}`;
}

function slackOwnerKey(user: string): string {
  return `${SLACK_OWNER_PREFIX}${user}`;
}

function decodeOwner(owner: string): { transport: 'relay' | 'slack'; id: string } {
  if (owner.startsWith(SLACK_OWNER_PREFIX)) {
    return { transport: 'slack', id: owner.slice(SLACK_OWNER_PREFIX.length) };
  }
  if (owner.startsWith(RELAY_OWNER_PREFIX)) {
    return { transport: 'relay', id: owner.slice(RELAY_OWNER_PREFIX.length) };
  }
  return { transport: 'relay', id: owner };
}

function input(ctx: WorkforceCtx, key: string): string | undefined {
  const value = (ctx as { persona?: { inputs?: Record<string, unknown> } }).persona?.inputs?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function defaultSlackDirectMessenger(): SlackDirectMessenger {
  return slackClient({ writebackTimeoutMs: SLACK_WRITEBACK_TIMEOUT_MS }) as SlackDirectMessenger;
}

async function replyRelay(ctx: WorkforceCtx, to: string, text: string): Promise<void> {
  const result = await ctx.relay.dm(to, text);
  if (!result.ok) throw new Error(`Relay DM delivery failed for ${to}`);
}

export async function deliverToOwner(
  ctx: WorkforceCtx,
  owner: string,
  text: string,
  deps: { slack?: SlackDirectMessenger } = {},
): Promise<void> {
  const target = decodeOwner(owner);
  if (target.transport === 'slack') {
    const result = await (deps.slack ?? defaultSlackDirectMessenger()).dm(target.id, text);
    // A missing `ts` means Slack never acknowledged the write. Treat it the
    // same way `replyRelay` treats `ok: false`: throw, so the sweep releases
    // the claim and retries. Logging and returning would let
    // `finalizeWatchRun` commit `seenIds` for evidence the user never saw.
    if (!result?.ts) {
      ctx.log('warn', 'askable-gtm.slack-watch-delivery-no-receipt', { user: target.id });
      throw new Error(`Slack DM delivery failed for ${target.id}`);
    }
    return;
  }
  await replyRelay(ctx, target.id, text);
}

function renderAccessDisclosure(access: ListenGatewayResult['access']): string {
  const host = safeDisplayHost(access.endpointHost);
  return access.credentialSource === 'managed'
    ? `Access: Agent Workforce managed Revternal access; usage counts against your paid allowance. Documented endpoint: ${host}.`
    : access.credentialSource === 'user'
      ? `Access: your workspace-connected Revternal credential. Documented endpoint: ${host}.`
      : `Access: the Cloud integration action gateway did not disclose whether this used a workspace-connected or managed Revternal credential. Documented endpoint: ${host}.`;
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

function classifyRelayfileToken(token: string): string {
  if (token.startsWith('relay_pa_')) return 'relay_pa';
  if (token.startsWith('relay_ws_')) return 'relay_ws';
  if (token.trim().length === 0) return 'missing';
  return 'other';
}

/**
 * Relayfile rejects an `/fs/file` request that carries no correlation id with
 * HTTP 400. Dropping this header silently broke every sweep in production —
 * the run failed before it could read a single watch — so it is required, not
 * decorative.
 */
function createWatchStateCorrelationId(action: 'read' | 'write'): string {
  return `askable-gtm-watch-state-${action}-${randomUUID()}`;
}

/** Failure bodies can echo a token; never let one reach a log. */
function sanitizeWatchStateReadFailureBody(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed
    .replace(/\brelay_(?:pa|ws)_[A-Za-z0-9_-]+\b/gu, '[redacted-relay-token]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, '[redacted-long-token]')
    .slice(0, 400);
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

/** Longest cited excerpt. Enough to judge relevance, short enough to scan. */
export const EVIDENCE_EXCERPT_MAX = 180;

/**
 * One-line excerpt of a post, cut on a word boundary. A citation is a pointer
 * to a source, not a copy of it: pasting five full LinkedIn posts into a Slack
 * thread buries the very signal the answer exists to surface.
 */
export function truncateEvidence(value: string, max = EVIDENCE_EXCERPT_MAX): string {
  const single = oneLine(value);
  if (single.length <= max) return single;
  const clipped = single.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  // Only honour the word boundary if it does not gut the excerpt.
  const body = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.replace(/[\s.,;:!?—-]+$/u, '')}…`;
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
