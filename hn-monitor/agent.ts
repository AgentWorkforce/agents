/**
 * hn-monitor handler.
 *
 *   cron tick
 *     → fetch Front Page, Show HN, and the last 24h of New HN
 *     → score stories against an agent-infrastructure interest profile
 *     → drop ones already posted (durable memory)
 *     → curate concise "why it matters" notes in a durable Relayflow v1 run
 *     → post digest to Slack, Telegram, or both
 *
 *   Slack mention / Telegram message / relay inbox DM
 *     → answer questions about recent findings, hydrating the matching HN
 *       story and top comments when the user asks for more detail
 *
 * Transport is configuration-driven. Set SLACK_CHANNEL, TELEGRAM_CHAT, or
 * both — the handler delivers to whichever targets are configured.
 */
import { createHash } from 'node:crypto';
import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import {
  createDelivery,
  input,
  list,
  withTimeout,
  fetchWithTimeout,
  type DeliveryClient,
  type DeliveryOptions,
  type MessageRef
} from '@agentworkforce/delivery';
import { slackClient } from '@relayfile/relay-helpers';
import {
  readTelegramMessage,
  skipReason as telegramSkipReason
} from '../shared/telegram.js';
import {
  materializeScheduledDigestWorkflow,
  SCHEDULED_DIGEST_WORKFLOW_NAME
} from './workflows/materialize.js';
import {
  createDigestDelivery,
  type DigestDeliveryClient,
  type DigestProvider
} from './digest-delivery.js';

export type HnFeed = 'front_page' | 'show_hn' | 'new';

export interface Story {
  id: number;
  title: string;
  url: string;
  points: number;
  comments?: number;
  author?: string;
  createdAt?: string;
  domain?: string;
  feeds?: HnFeed[];
  hnUrl?: string;
  category?: string;
  signals?: string[];
  relevanceScore?: number;
}

export interface PostedStory extends Story {
  rank: number;
  why: string;
}

export interface PostRecord {
  kind?: 'hn-monitor posted digest';
  postedAt: string;
  digest: string;
  stories: PostedStory[];
  threadRefs?: Array<{
    provider: 'slack' | 'telegram';
    draftRef: string;
    channel?: string;
    chatId?: string;
    threadTs?: string;
  }>;
}

type SavedHeaderRef = NonNullable<PostRecord['threadRefs']>[number];

interface RecentDigestState {
  kind: 'hn-monitor exact recent digests';
  version: 1;
  updatedAt: string;
  posts: PostRecord[];
}

interface ExactPostSaveResult {
  applicable: boolean;
  saved: boolean;
  threadShardSaved: boolean;
  indexSaved: boolean;
}

class ExactPostPersistenceError extends Error {
  constructor() {
    super('Slack digest posted, but deterministic HN grounding state could not be persisted');
    this.name = 'ExactPostPersistenceError';
  }
}

type QaGroundingSource = 'exact_state' | 'memory' | 'thread_context' | 'algolia' | 'none';

type DigestOutboxPhase = 'claim' | 'headers' | 'bodies' | 'state';
type DigestEffectStatus = 'pending' | 'delivered' | 'omitted';

interface DigestOutboxEffect {
  status: DigestEffectStatus;
  operationKey: string;
  ref?: SavedHeaderRef;
}

interface DigestOutboxProvider {
  header: DigestOutboxEffect;
  body: DigestOutboxEffect;
}

interface DigestOutbox {
  kind: 'hn-monitor digest outbox';
  version: 1;
  cleared?: boolean;
  batchKey: string;
  phase: DigestOutboxPhase;
  createdAt: string;
  updatedAt: string;
  header: string;
  body: string;
  stories: PostedStory[];
  seenBefore: number[];
  seenClaim: number[];
  providers: Partial<Record<DigestProvider, DigestOutboxProvider>>;
  /** Upgrade bridge for the pre-outbox pending-body/pending-state records. */
  legacyRecovery?: true;
}

interface LegacyPendingThreadBody {
  cleared?: boolean;
  targets: string;
  header: string;
  body: string;
  createdAt: string;
  stories: PostedStory[];
  headerRefs: SavedHeaderRef[];
}

interface LegacyPendingPostState {
  cleared?: boolean;
  record: PostRecord;
}

const SCHEDULED_DIGEST_VERSION = 'v1' as const;
export const SCHEDULED_DIGEST_COMPLETION_TIMEOUT_MS = 510_000;
const scheduledScanLocks = new Map<string, Promise<void>>();

interface ScheduledScanDependencies {
  delivery?: DigestDeliveryClient | DeliveryClient;
  fetchStories?: (lookbackHours: number) => Promise<Story[]>;
}

// ── message parsing ──────────────────────────────────────────────────────

interface ParsedMessage {
  text: string;
  provider: 'relay';
}

interface SlackMessage {
  text: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
  isBot: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function parseRelayMessage(event: { data?: unknown }): ParsedMessage | null {
  const data = asRecord(event.data);
  if (!data) return null;
  const nested = (data.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const text = str(data.text) ?? str(nested.text) ?? '';
  if (!text.trim()) return null;
  return { text: text.trim(), provider: 'relay' };
}

function parseSlackMessage(expanded: unknown): SlackMessage {
  const root = asRecord(expanded);
  const data = asRecord(root?.data) ?? root ?? {};
  const nested = asRecord(data.message) ?? asRecord(data.event) ?? data;
  return {
    text: (str(nested.text) ?? str(data.text) ?? '').replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/giu, ' ').replace(/\s+/gu, ' ').trim(),
    channel: str(nested.channel) ?? str(nested.channel_id) ?? str(data.channel),
    ts: str(nested.ts) ?? str(nested.event_ts) ?? str(data.ts),
    threadTs: str(nested.thread_ts) ?? str(data.thread_ts),
    isBot: Boolean(nested.bot_id) || nested.subtype === 'bot_message'
  };
}

/**
 * Best-effort: resolve the agent that sent an inbound relay DM, so we can reply
 * to them over the relay. The sender rides on the event's summary `actor` (cloud
 * envelope-builder normalizes relaycast `from` → `summary.actor`); we also probe
 * the full payload's `from`/`actor` as a fallback. Returns the agent ref (name
 * or id) or undefined when it can't be determined (caller then falls back to
 * Slack/Telegram). The exact field path is verified against the live relay.
 */
async function resolveRelaySender(event: AgentEvent, expandedFull: unknown): Promise<string | undefined> {
  // The cloud envelope-builder normalizes the relaycast `from` to the event's
  // summary `actor` (`{ summary: { actor: { id, displayName } } }`), present
  // directly on the event and via `expand('summary')`. Probe those first; fall
  // back to the ALREADY-resolved full payload's `from`/`actor` (passed in to
  // avoid a redundant expand round-trip).
  const actorFrom = (obj: unknown): Record<string, unknown> | undefined => {
    const r = asRecord(obj);
    if (!r) return undefined;
    return (
      asRecord(r.actor) ??
      asRecord(asRecord(r.summary)?.actor) ??
      asRecord(asRecord(r.data)?.actor) ??
      asRecord(asRecord(r.data)?.from) ??
      asRecord(r.from) ??
      undefined
    );
  };
  const actor =
    actorFrom((event as { summary?: unknown }).summary) ??
    actorFrom(await event.expand('summary').catch(() => undefined)) ??
    actorFrom(expandedFull);
  return str(actor?.id) ?? str(actor?.name) ?? str(actor?.displayName);
}

// ── agent definition ─────────────────────────────────────────────────────

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 9,17 * * *', tz: 'America/New_York' }],
  triggers: {
    // `on: 'app_mention'` never actually routes: the cloud's integration-watch
    // matcher hard-excludes app_mention from generic resource matching
    // (relayfileTriggerMatchesEvent short-circuits false for it), and Slack
    // mentions inside an existing thread arrive to the webhook as a plain
    // `message.created` event, not a literal `app_mention` eventType. Match on
    // the Relayfile trigger + `@mention` text gate instead (same fix joke-bot
    // already applies). `${SLACK_CHANNEL}` below is NOT JS interpolation (this
    // is a plain single-quoted string) — it's the persona-kit input-reference
    // syntax, substituted with the deploy-resolved channel id by the deploy
    // CLI before the trigger ever reaches cloud.
    slack: [{ on: 'message.created', paths: ['/slack/channels/${SLACK_CHANNEL}/**'], match: '@mention' }],
    telegram: [{ on: 'message' }]
  },
  handler: async (ctx, event) => {
    // Q&A path: relay inbox DM
    if (isRelaycastMessageEvent(event as unknown as AgentEvent)) {
      await handleQaMessage(ctx, event as unknown as AgentEvent, 'relay');
      return;
    }
    // Q&A path: telegram message
    if (typeof event.type === 'string' && event.type.startsWith('telegram.')) {
      await handleQaMessage(ctx, event as unknown as AgentEvent, 'telegram');
      return;
    }
    // Q&A path: a Slack @mention, usually in a digest thread.
    if (typeof event.type === 'string' && event.type.startsWith('slack.')) {
      await handleQaMessage(ctx, event as unknown as AgentEvent, 'slack');
      return;
    }
    // Cron path
    if (!isCronTickEvent(event as unknown as AgentEvent)) return;

    await runScheduledScan(ctx);
  }
});

/**
 * Product schedule boundary. The deployed defineAgent handler delegates every
 * cron tick here; dependencies are injectable only so the exact product path
 * can be exercised without live HN reads or provider writes.
 */
export async function runScheduledScan(
  ctx: WorkforceCtx,
  deps: ScheduledScanDependencies = {}
): Promise<void> {
  const delivery = deps.delivery ?? createDigestDelivery(ctx);

  // One deployed worker can receive overlapping at-least-once cron
  // deliveries. Serialize the whole read/claim/effect path per workspace and
  // agent so the second invocation re-reads the first invocation's durable
  // claim instead of racing from the same stale snapshot.
  await withScheduledScanLock(scheduledScanLockKey(ctx), async () => {
    // A durable outbox recovery owns this tick. Stable provider operation keys
    // make every replay safe across delivery ids and worker termination.
    if (await retryPendingThreadBody(ctx, delivery)) return;

    // Recovery runs even after every provider is removed so an old partial
    // digest cannot remain publishable if that provider is enabled again.
    if (delivery.targets.length === 0) {
      ctx.log('warn', 'hn-monitor.no-targets', { reason: 'neither SLACK_CHANNEL nor TELEGRAM_CHAT configured' });
      return;
    }

    const topics = list(input(ctx, 'TOPICS'));
    const lookbackHours = boundedPositiveInt(input(ctx, 'LOOKBACK_HOURS') ?? '24', 'LOOKBACK_HOURS', 72);
    const maxStories = boundedPositiveInt(input(ctx, 'MAX_STORIES') ?? '8', 'MAX_STORIES', 20);

    const stories = await (deps.fetchStories ?? fetchHackerNewsFeeds)(lookbackHours);
    const feedCounts = countFeeds(stories);
    ctx.log(
      'info',
      `hn-monitor.feed-scan front_page=${feedCounts.front_page} show_hn=${feedCounts.show_hn} new=${feedCounts.new}`,
      { stories: stories.length, lookbackHours }
    );
    const matches = selectRelevantStories(stories, topics, maxStories);
    ctx.log('info', `hn-monitor.matched-agentic matched=${matches.length}`, { matched: matches.length, candidates: stories.length });

    const seen = await loadSeen(ctx);
    const fresh = matches.filter((story) => !seen.includes(story.id));
    ctx.log('info', `hn-monitor.fresh fresh=${fresh.length}`, { fresh: fresh.length });
    if (fresh.length === 0) {
      ctx.log('info', 'hn-monitor.nothing-new', { matched: matches.length });
      return;
    }

    await postFreshStories(ctx, delivery, seen, fresh);
  });
}

function scheduledScanLockKey(ctx: WorkforceCtx): string {
  return `${ctx.workspaceId ?? 'workspace'}:${ctx.agentName ?? 'hn-monitor'}`;
}

async function withScheduledScanLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const predecessor = scheduledScanLocks.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  scheduledScanLocks.set(key, current);
  await predecessor.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (scheduledScanLocks.get(key) === current) scheduledScanLocks.delete(key);
  }
}

// ── Q&A handler ──────────────────────────────────────────────────────────

export async function handleQaMessage(
  ctx: WorkforceCtx,
  event: AgentEvent,
  provider: 'slack' | 'telegram' | 'relay',
  deps: {
    complete?: (prompt: string) => Promise<string>;
    fetchDetails?: (storyId: number) => Promise<HnStoryDetails | null>;
    searchByTitle?: (question: string) => Promise<PostedStory | null>;
    loadExactPosts?: (threadTs?: string) => Promise<PostRecord[]>;
    loadThreadContext?: (expanded: unknown) => Promise<string>;
    slackReply?: (channel: string, threadTs: string, text: string) => Promise<unknown>;
    /** Inject a delivery client for testing (avoids real writeback). */
    delivery?: DeliveryClient;
  } = {}
): Promise<void> {
  const expanded = await event.expand('full').catch(() => undefined);
  if (!expanded) return;

  let question: string | null = null;
  let slackMessage: SlackMessage | null = null;

  if (provider === 'slack') {
    slackMessage = parseSlackMessage(expanded);
    if (slackMessage.isBot || !slackMessage.text || !slackMessage.channel || !(slackMessage.threadTs || slackMessage.ts)) {
      ctx.log('info', 'hn-monitor.qa.skip', { reason: 'unusable Slack mention' });
      return;
    }
    question = slackMessage.text;
  } else if (provider === 'telegram') {
    const payload = expanded as { data?: unknown };
    if (!payload.data) return;
    const msg = readTelegramMessage(payload.data);
    if (!msg) return;
    // Gate: skip bot echoes, wrong chat, empty text
    const reason = telegramSkipReason(msg, input(ctx, 'TELEGRAM_CHAT'));
    if (reason) {
      ctx.log('info', `hn-monitor.qa.skip reason=${reason.replace(/\s+/g, '-')}`);
      return;
    }
    question = msg.text.trim();
  } else {
    // relay inbox DM
    const parsed = parseRelayMessage(expanded as { data?: unknown });
    if (!parsed) {
      ctx.log('info', 'hn-monitor.qa.skip', { reason: 'unparseable relay message' });
      return;
    }
    question = parsed.text;
  }

  if (!question) return;

  const [exactPosts, memoryPosts, threadContext] = await Promise.all([
    (deps.loadExactPosts ?? ((threadTs?: string) => loadExactPosts(ctx, threadTs)))(
      provider === 'slack' ? slackMessage?.threadTs ?? slackMessage?.ts : undefined
    ).catch(() => []),
    loadPosts(ctx).catch(() => []),
    (deps.loadThreadContext ?? ((value: unknown) => loadSlackThreadContext(ctx, value)))(expanded).catch(() => '')
  ]);
  const posts = mergePosts(exactPosts, memoryPosts);
  ctx.log('info', 'hn-monitor.qa.recalled', {
    posts: posts.length,
    exactPosts: exactPosts.length,
    memoryPosts: memoryPosts.length,
    threadContext: Boolean(threadContext)
  });

  let source: QaGroundingSource = 'none';
  const ordinal = ordinalFromQuestion(question);
  const threadPost = findThreadPost(posts, expanded, threadContext);
  let selectedStories: PostedStory[] = [];
  if (ordinal !== undefined) {
    const safeOrdinalPost = threadPost ?? (posts.length === 1 ? posts[0] : undefined);
    if (safeOrdinalPost) {
      selectedStories = selectQuestionStories(question, [safeOrdinalPost]).slice(0, 2);
      if (selectedStories.length > 0) {
        source = postGroupContains(exactPosts, safeOrdinalPost) ? 'exact_state' : 'memory';
      }
    }
  } else {
    if (threadPost) {
      selectedStories = selectQuestionStories(`${question}\n${threadContext}`, [threadPost]).slice(0, 2);
      if (selectedStories.length > 0) {
        source = 'thread_context';
      }
    }
    if (selectedStories.length === 0) selectedStories = selectQuestionStories(question, exactPosts).slice(0, 2);
    if (selectedStories.length > 0) {
      if (source === 'none') source = 'exact_state';
    } else if (exactPosts.length === 0) {
      selectedStories = selectQuestionStories(question, memoryPosts).slice(0, 2);
      if (selectedStories.length > 0) source = 'memory';
    }
  }
  if (selectedStories.length === 0 && threadContext && ordinal === undefined) {
    selectedStories = selectQuestionStories(`${question}\n${threadContext}`, posts).slice(0, 2);
    if (selectedStories.length > 0) source = 'thread_context';
  }
  if (selectedStories.length === 0) {
    const lookup = await (deps.searchByTitle ?? findStoryByExactTitle)(question).catch(() => null);
    if (lookup) {
      selectedStories = [lookup];
      source = 'algolia';
    }
  }
  ctx.log('info', 'hn-monitor.qa.selected', {
    source,
    selected: selectedStories.map((story) => ({ id: story.id, title: story.title }))
  });

  const detailsLoader = deps.fetchDetails ?? fetchStoryDetails;
  const details = (
    await Promise.all(selectedStories.map((story) => detailsLoader(story.id).catch(() => null)))
  ).filter((item): item is HnStoryDetails => item !== null);
  ctx.log('info', 'hn-monitor.qa.hydrated', {
    source,
    selected: selectedStories.map((story) => story.id),
    hydrated: details.length
  });

  const lookupPost: PostRecord[] = source === 'algolia' && selectedStories[0]
    ? [{
        postedAt: new Date().toISOString(),
        digest: `Live exact-title HN lookup: ${selectedStories[0].title}\nArticle: ${selectedStories[0].url}\nHN discussion: ${selectedStories[0].hnUrl}`,
        stories: selectedStories
      }]
    : [];
  const groundingPosts = mergePosts(lookupPost, posts);
  const context = groundingPosts.length
    ? groundingPosts.slice(0, 12).map((p) => `### Posted ${p.postedAt ?? 'Unknown'}\n${p.digest ?? ''}`).join('\n\n')
    : 'No Hacker News digests have been posted yet.';

  const liveContext = details.length
    ? details.map(renderStoryDetailsForPrompt).join('\n\n')
    : 'No matching story needed live hydration, or the HN detail endpoint had no additional data.';

  const prompt = [
    "You are the conversational Hacker News radar for an engineering team building agent infrastructure.",
    'Answer using ONLY the recently posted digests and live HN details below.',
    `The selected story grounding source is ${source}.`,
    source === 'algolia'
      ? 'Say briefly that you matched the supplied title with a live HN title lookup; do not imply it came from recalled digest memory.'
      : '',
    'When live comments are provided, describe them as HN community reactions, not as verified facts.',
    'If the evidence does not cover the question or the referenced story is ambiguous, say so and ask for the story number/title.',
    'Be concise, specific, and include the article and HN discussion links when they help.',
    provider === 'slack' ? 'Use concise Slack mrkdwn; no markdown headings.' : 'Use concise chat-friendly formatting.',
    '',
    '## Recently posted digests (most recent ~30 days)',
    context,
    '',
    '## Live HN story details and top comments',
    liveContext,
    '',
    '## Slack thread parent context (may be empty)',
    threadContext || '(No thread parent text was available.)',
    '',
    '## User question',
    question
  ].join('\n');

  const complete = deps.complete ?? ((p: string) => ctx.llm.complete(p, { maxTokens: 1024 }));
  let answer: string;
  try {
    answer = await withTimeout(complete(prompt), 45_000, 'ctx.llm.complete');
  } catch (error) {
    ctx.log('warn', 'hn-monitor.qa.llm-fallback', { error: String(error) });
    const titles = dedupePostedStories(selectedStories)
      .slice(0, 15)
      .map((story) => [
        `- ${story.title ?? 'Untitled'}`,
        `  Article: ${story.url ?? story.hnUrl ?? ''}`,
        `  HN discussion: ${story.hnUrl ?? `https://news.ycombinator.com/item?id=${story.id}`}`
      ].join('\n'))
      .join('\n');
    answer = titles
      ? `I found the grounded HN story, but couldn't generate the full answer right now:\n${titles}`
      : "I couldn't generate an answer right now, and I couldn't resolve a single grounded HN story from that question. Please specify the story number or exact title.";
  }

  const reply = answer.trim() || 'No answer available.';

  if (provider === 'slack' && slackMessage?.channel) {
    const threadTs = slackMessage.threadTs ?? slackMessage.ts;
    if (!threadTs) return;
    const replyFn = deps.slackReply ?? ((channel: string, ts: string, text: string) =>
      slackClient({ writebackTimeoutMs: 0 }).reply(channel, ts, text));
    await replyFn(slackMessage.channel, threadTs, reply);
    ctx.log('info', 'hn-monitor.qa.slack-replied', { channel: slackMessage.channel, threadTs });
    return;
  }

  // Relay DMs: reply over the relay to whoever DM'd us (agent-to-agent
  // round-trip) when we can resolve the sender. Falls back to Slack/Telegram
  // delivery below when the sender can't be determined, so there's no regression.
  if (provider === 'relay' && ctx.relay) {
    const sender = await resolveRelaySender(event, expanded);
    if (sender) {
      try {
        const res = await ctx.relay.dm(sender, reply);
        if (res.ok) {
          ctx.log('info', 'hn-monitor.qa.relay-replied', { to: sender });
          return;
        }
        ctx.log('warn', 'hn-monitor.qa.relay-reply-no-receipt', { to: sender });
      } catch (error) {
        ctx.log('warn', 'hn-monitor.qa.relay-reply-failed', { to: sender, error: String(error) });
      }
      // fall through to transport delivery on failure
    }
  }

  // Reply only to the origin transport so questions don't mirror everywhere.
  const delivery = deps.delivery ?? createDelivery(ctx);
  if (delivery.targets.length > 0) {
    if (provider === 'relay') {
      // Fallback: relay sender unresolved — reply to Slack if configured (legacy
      // behavior), else Telegram.
      const nonRelayTargets = delivery.targets.filter((t): t is 'slack' | 'telegram' => t === 'slack' || t === 'telegram');
      const targets: Array<'slack' | 'telegram'> = nonRelayTargets.includes('slack') ? ['slack'] : nonRelayTargets;
      // When using injected mock, just publish directly (target filtering is
      // the test's responsibility). When using real client, scope to targets.
      const scoped = deps.delivery
        ? delivery
        : createDelivery(ctx, undefined, targets);
      await scoped.publish(reply);
    } else if (provider === 'telegram') {
      // Telegram Q&A: reply ONLY to Telegram.
      const scoped = deps.delivery
        ? delivery
        : createDelivery(ctx, undefined, [provider]);
      await scoped.publish(answer.trim() || 'No answer available.');
    }
  }
}

// ── posting ──────────────────────────────────────────────────────────────

export async function postFreshStories(
  ctx: WorkforceCtx,
  delivery: DigestDeliveryClient | DeliveryClient,
  seen: number[],
  fresh: Story[]
): Promise<void> {
  ctx.log('info', 'hn-monitor.summarizing', { fresh: fresh.length });
  const { header, body, stories } = await summarize(ctx, fresh);
  const batchKey = scheduledDigestBatchKey(fresh);
  const outbox = newDigestOutbox(batchKey, header, body, stories, seen, delivery.targets);

  // The outbox is durable before the seen claim or any provider effect. If the
  // claim write fails, a later tick resumes this same record instead of losing
  // the batch. Every provider operation has a stable cross-tick idempotency key.
  await saveDigestOutbox(ctx, outbox);
  await resumeDigestOutbox(ctx, delivery, outbox);
}

// ── durable digest outbox recovery ───────────────────────────────────────

export async function retryPendingThreadBody(
  ctx: WorkforceCtx,
  delivery: DigestDeliveryClient | DeliveryClient
): Promise<boolean> {
  const outbox = await loadDigestOutbox(ctx) ?? await migrateLegacyDigestOutbox(ctx, delivery.targets);
  if (!outbox) return false;
  await resumeDigestOutbox(ctx, delivery, outbox);
  return true;
}

function newDigestOutbox(
  batchKey: string,
  header: string,
  body: string,
  stories: PostedStory[],
  seenBefore: number[],
  targets: ReadonlyArray<string>
): DigestOutbox {
  const createdAt = new Date().toISOString();
  const providers: DigestOutbox['providers'] = {};
  for (const provider of targets) {
    if (provider !== 'slack' && provider !== 'telegram') continue;
    providers[provider] = {
      header: { status: 'pending', operationKey: digestOperationKey(batchKey, provider, 'header') },
      body: { status: 'pending', operationKey: digestOperationKey(batchKey, provider, 'body') }
    };
  }
  if (Object.keys(providers).length === 0) throw new Error('HN digest outbox requires Slack or Telegram');
  return {
    kind: 'hn-monitor digest outbox',
    version: 1,
    batchKey,
    phase: 'claim',
    createdAt,
    updatedAt: createdAt,
    header,
    body,
    stories,
    seenBefore,
    seenClaim: [...seenBefore, ...stories.map((story) => story.id)].slice(-200),
    providers
  };
}

async function resumeDigestOutbox(
  ctx: WorkforceCtx,
  delivery: DigestDeliveryClient | DeliveryClient,
  outbox: DigestOutbox
): Promise<void> {
  let changedForConfig = false;
  for (const [provider, state] of digestProviderEntries(outbox)) {
    if (delivery.targets.includes(provider)) continue;
    if (state.header.status === 'pending') state.header.status = 'omitted';
    if (state.body.status === 'pending') state.body.status = 'omitted';
    changedForConfig = true;
  }
  if (changedForConfig) await saveDigestOutbox(ctx, outbox);

  if (outbox.phase === 'claim') {
    await saveSeen(ctx, outbox.seenClaim);
    outbox.phase = 'headers';
    await saveDigestOutbox(ctx, outbox);
  }

  if (outbox.phase === 'headers') {
    for (const [provider, state] of digestProviderEntries(outbox)) {
      if (state.header.status !== 'pending') continue;
      const ref = await sendDigestOperation(delivery, provider, outbox.header, {
        idempotencyKey: state.header.operationKey
      });
      state.header.ref = saveMessageRef(ref);
      state.header.status = 'delivered';
      await saveDigestOutbox(ctx, outbox);
    }
    outbox.phase = 'bodies';
    await saveDigestOutbox(ctx, outbox);
  }

  if (outbox.phase === 'bodies') {
    for (const [provider, state] of digestProviderEntries(outbox)) {
      if (state.body.status !== 'pending') continue;
      if (state.header.status !== 'delivered' || !state.header.ref) {
        state.body.status = 'omitted';
        await saveDigestOutbox(ctx, outbox);
        continue;
      }
      await sendDigestOperation(delivery, provider, outbox.body, {
        idempotencyKey: state.body.operationKey,
        nonBlocking: true,
        replyTo: rebuildMessageRef(state.header.ref)
      });
      state.body.status = 'delivered';
      await saveDigestOutbox(ctx, outbox);
    }
    outbox.phase = 'state';
    await saveDigestOutbox(ctx, outbox);
  }

  const postRecord: PostRecord = {
    postedAt: outbox.createdAt,
    digest: `${outbox.header}\n${outbox.body}`,
    stories: outbox.stories,
    threadRefs: digestProviderEntries(outbox)
      .map(([, state]) => state.header.ref)
      .filter((ref): ref is SavedHeaderRef => Boolean(ref))
  };
  const exactStateSaved = await savePost(ctx, postRecord);
  if (!exactStateSaved) {
    ctx.log('error', 'hn-monitor.post-grounding-persistence-failed', { recovery: true, phase: outbox.phase });
    throw new ExactPostPersistenceError();
  }
  if (outbox.legacyRecovery) await clearLegacyRecoveryMarkers(ctx);
  await clearDigestOutbox(ctx, outbox.batchKey);
  ctx.log('info', 'hn-monitor.posted', {
    targets: digestProviderEntries(outbox).map(([provider]) => provider).join(',')
  });
  ctx.log('info', 'hn-monitor.outbox-completed', {
    batchKey: outbox.batchKey,
    providers: digestProviderEntries(outbox).map(([provider]) => provider)
  });
}

async function sendDigestOperation(
  delivery: DigestDeliveryClient | DeliveryClient,
  provider: DigestProvider,
  text: string,
  options: { idempotencyKey: string; nonBlocking?: boolean; replyTo?: MessageRef }
): Promise<MessageRef> {
  if ('sendOperation' in delivery) {
    return delivery.sendOperation(provider, text, options);
  }
  if (delivery.targets.length !== 1 || delivery.targets[0] !== provider) {
    throw new Error('multi-target HN digest tests must provide sendOperation for per-provider recovery');
  }
  const legacyOptions: DeliveryOptions = {
    ...(options.nonBlocking ? { nonBlocking: true } : {}),
    ...(options.replyTo ? { replyTo: { ok: true, refs: [options.replyTo] } } : {})
  };
  const result = await delivery.send(text, legacyOptions);
  const ref = result.refs.find((candidate) => candidate.provider === provider);
  if (!result.ok || !ref) throw new Error(`HN digest ${provider} operation failed`);
  return ref;
}

function digestProviderEntries(outbox: DigestOutbox): Array<[DigestProvider, DigestOutboxProvider]> {
  return (['slack', 'telegram'] as const)
    .flatMap((provider) => outbox.providers[provider] ? [[provider, outbox.providers[provider] as DigestOutboxProvider]] : []);
}

function digestOperationKey(batchKey: string, provider: DigestProvider, phase: 'header' | 'body'): string {
  const batchHash = createHash('sha256').update(batchKey).digest('hex').slice(0, 32);
  return `hn-monitor:${batchHash}:${provider}:${phase}`;
}

function saveMessageRef(ref: MessageRef): SavedHeaderRef {
  if (ref.provider === 'telegram') {
    return { provider: 'telegram', chatId: ref.chatId, draftRef: ref.messageId };
  }
  if (ref.provider !== 'slack') throw new Error(`unsupported HN digest provider ${ref.provider}`);
  return { provider: 'slack', channel: ref.channel, threadTs: ref.ts, draftRef: ref.draftRef };
}

function rebuildMessageRef(ref: SavedHeaderRef): MessageRef {
  return ref.provider === 'telegram'
    ? { provider: 'telegram', chatId: ref.chatId ?? '', messageId: ref.draftRef }
    : { provider: 'slack', channel: ref.channel ?? '', ts: ref.threadTs ?? '', draftRef: ref.draftRef };
}

// ── HN fetching ──────────────────────────────────────────────────────────

interface HnHit {
  objectID?: string;
  title?: string | null;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  author?: string | null;
  created_at?: string | null;
}

interface SignalGroup {
  category: string;
  patterns: RegExp[];
}

const SIGNAL_GROUPS: SignalGroup[] = [
  {
    category: 'Agent coordination',
    patterns: [
      /\bmulti[- ]agent\b/iu,
      /\bagent(?:ic)? (?:orchestrat(?:ion|or)|coordination|communication|messaging|handoff|delegation|team|swarm)\b/iu,
      /\b(?:agents? (?:talking|collaborating)|agent[- ]to[- ]agent|\bA2A\b|shared context)\b/iu
    ]
  },
  {
    category: 'Coding agents',
    patterns: [
      /\b(?:AI |autonomous )?coding agents?\b/iu,
      /\b(?:Claude Code|OpenAI Codex|Codex CLI|Cursor|Devin|OpenHands|SWE[- ]agent|SWE[- ]bench)\b/iu,
      /\b(?:software|code) factor(?:y|ies)\b/iu,
      /\bagent(?:ic)? (?:code review|software development|coding workflow)\b/iu
    ]
  },
  {
    category: 'Agent infrastructure',
    patterns: [
      /\bagent(?:ic)? (?:runtime|infrastructure|platform|framework|protocol|sandbox|memory|context|harness|tooling|observability)\b/iu,
      /\b(?:Model Context Protocol|MCP server|MCP client|MCP tools?)\b/iu,
      /\b(?:tool calling|computer use|browser use)\b.*\b(?:agent|LLM|model)\b/iu,
      /\b(?:agent|LLM|model)\b.*\b(?:tool calling|computer use|browser use)\b/iu
    ]
  },
  {
    category: 'Agent workflows',
    patterns: [
      /\bagent(?:ic)? (?:workflow|loop|pipeline|automation)\b/iu,
      /\b(?:background|long[- ]running|headless|autonomous|proactive) agents?\b/iu,
      /\b(?:ReAct|agent loop|agent factory|AI factory)\b/iu
    ]
  },
  {
    category: 'Agent Relay ecosystem',
    patterns: [
      /\b(?:Agent Relay|AgentWorkforce|Relayfile|Relaycast|Relayauth|Relaycron)\b/iu,
      /\bheadless Slack for agents\b/iu
    ]
  }
];

const GENERIC_AGENT_RE = /\b(?:AI agents?|LLM agents?|agentic|agents?)\b/iu;
const TECH_CONTEXT_RE = /\b(?:AI|LLM|model|code|coding|developer|software|workflow|runtime|tool|memory|context|browser|terminal|computer|autonomous|inference|open source|API|protocol)\b/iu;
const FALSE_POSITIVE_RE = /\b(?:travel|insurance|real estate|estate|sports|talent|literary|booking|border patrol) agents?\b/iu;
const WEAK_CUSTOM_TOPICS = new Set(['ai', 'agent', 'agents', 'agentic', 'typescript', 'developer tools', 'devtools', 'software']);

export async function fetchHackerNewsFeeds(lookbackHours = 24): Promise<Story[]> {
  const cutoff = Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);
  const urls: Array<{ feed: HnFeed; url: string }> = [
    {
      feed: 'front_page',
      url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=100'
    },
    {
      feed: 'show_hn',
      url: `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=250&numericFilters=created_at_i%3E${cutoff}`
    },
    {
      feed: 'new',
      url: `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=1000&numericFilters=created_at_i%3E${cutoff}`
    }
  ];

  const batches = await Promise.all(urls.map(({ feed, url }) => fetchFeed(url, feed)));
  const merged = new Map<number, Story>();
  for (const story of batches.flat()) {
    const prior = merged.get(story.id);
    if (!prior) {
      merged.set(story.id, story);
      continue;
    }
    merged.set(story.id, {
      ...prior,
      ...story,
      points: Math.max(prior.points, story.points),
      comments: Math.max(prior.comments ?? 0, story.comments ?? 0),
      feeds: [...new Set([...(prior.feeds ?? []), ...(story.feeds ?? [])])]
    });
  }
  return [...merged.values()];
}

async function fetchFeed(url: string, feed: HnFeed): Promise<Story[]> {
  const res = await fetchWithTimeout(url, {}, 8_000);
  if (!res?.ok) return [];
  try {
    const payload = (await res.json()) as { hits?: HnHit[] };
    return (payload.hits ?? []).map((hit) => storyFromHit(hit, feed)).filter((story): story is Story => story !== null);
  } catch {
    return [];
  }
}

function storyFromHit(hit: HnHit, feed: HnFeed): Story | null {
  const id = Number(hit.objectID);
  const title = hit.title?.trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !title) return null;
  const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
  const url = hit.url?.trim() || hnUrl;
  return {
    id,
    title,
    url,
    hnUrl,
    points: nonNegativeInt(hit.points),
    comments: nonNegativeInt(hit.num_comments),
    author: hit.author?.trim() || undefined,
    createdAt: hit.created_at?.trim() || undefined,
    domain: safeDomain(url),
    feeds: [feed]
  };
}

export function selectRelevantStories(stories: Story[], topics: string[], maxStories = 8): Story[] {
  const customTopics = topics.map((topic) => topic.trim().toLowerCase()).filter(Boolean);
  return stories
    .map((story) => scoreStory(story, customTopics))
    .filter((story) => (story.relevanceScore ?? 0) >= 4)
    .sort((a, b) => rankScore(b) - rankScore(a) || b.id - a.id)
    .slice(0, maxStories);
}

function scoreStory(story: Story, customTopics: string[]): Story {
  const title = story.title;
  const signals: string[] = [];
  let relevanceScore = 0;
  let category = '';

  for (const group of SIGNAL_GROUPS) {
    const matched = group.patterns.some((pattern) => pattern.test(title));
    if (!matched) continue;
    signals.push(group.category);
    if (!category) {
      category = group.category;
      relevanceScore += group.category === 'Agent Relay ecosystem' ? 8 : 5;
    } else {
      relevanceScore += 2;
    }
  }

  if (GENERIC_AGENT_RE.test(title) && TECH_CONTEXT_RE.test(title)) {
    relevanceScore += 4;
    if (!category) category = 'Agent ecosystem';
    signals.push('agent + technical context');
  }

  const lower = title.toLowerCase();
  for (const topic of customTopics) {
    if (!lower.includes(topic)) continue;
    if (!WEAK_CUSTOM_TOPICS.has(topic)) {
      relevanceScore += GENERIC_AGENT_RE.test(title) || /\b(?:mcp|codex|claude code|cursor|devin|openhands)\b/iu.test(topic) ? 3 : 1;
      signals.push(`topic:${topic}`);
    } else if (GENERIC_AGENT_RE.test(title)) {
      relevanceScore += 1;
    }
  }

  if (FALSE_POSITIVE_RE.test(title) && !TECH_CONTEXT_RE.test(title)) relevanceScore = 0;
  return {
    ...story,
    category: category || 'Agent ecosystem',
    signals: [...new Set(signals)],
    relevanceScore
  };
}

function rankScore(story: Story): number {
  const engagement = Math.log2(2 + story.points + (story.comments ?? 0) * 2) * 8;
  const sourceBoost = (story.feeds?.includes('front_page') ? 18 : 0) + (story.feeds?.includes('show_hn') ? 8 : 0);
  const createdAtMs = story.createdAt ? Date.parse(story.createdAt) : Number.NaN;
  const ageHours = Number.isFinite(createdAtMs) ? Math.max(0, (Date.now() - createdAtMs) / 3_600_000) : 24;
  const recency = Math.max(0, 24 - ageHours) / 3;
  return (story.relevanceScore ?? 0) * 100 + engagement + sourceBoost + recency;
}

function countFeeds(stories: Story[]): Record<HnFeed, number> {
  return {
    front_page: stories.filter((story) => story.feeds?.includes('front_page')).length,
    show_hn: stories.filter((story) => story.feeds?.includes('show_hn')).length,
    new: stories.filter((story) => story.feeds?.includes('new')).length
  };
}

// ── summarization ────────────────────────────────────────────────────────

interface DigestNotes {
  theme: string;
  whyById: Map<number, string>;
}

async function summarize(ctx: WorkforceCtx, stories: Story[]): Promise<{ header: string; body: string; stories: PostedStory[] }> {
  const storyData = stories.map((story) => ({
    id: story.id,
    title: story.title,
    category: story.category,
    points: story.points,
    comments: story.comments ?? 0,
    feeds: story.feeds ?? [],
    url: story.url,
    hnUrl: story.hnUrl
  }));
  let notes: DigestNotes = { theme: fallbackTheme(stories), whyById: new Map() };
  const batchKey = scheduledDigestBatchKey(stories);
  try {
    await materializeScheduledDigestWorkflow(ctx);
    const run = await withTimeout(
      ctx.workflow.run(SCHEDULED_DIGEST_WORKFLOW_NAME, {
        relayflowVersion: SCHEDULED_DIGEST_VERSION,
        batchKey,
        stories: storyData
      }),
      30_000,
      `ctx.workflow.run(${SCHEDULED_DIGEST_WORKFLOW_NAME})`
    );
    ctx.log('info', 'hn-monitor.relayflow-started', { batchKey, runId: run.runId, version: SCHEDULED_DIGEST_VERSION });
    const completion = await withTimeout(
      run.completion(),
      SCHEDULED_DIGEST_COMPLETION_TIMEOUT_MS,
      `ctx.workflow.completion(${run.runId})`
    );
    if (completion.status !== 'success') {
      throw new Error(`Relayflow ${run.runId} completed with status ${completion.status}`);
    }
    if (completion.output !== null && completion.output !== undefined) {
      notes = parseDigestNotes(workflowOutputText(completion.output), stories);
    }
    ctx.log('info', 'hn-monitor.relayflow-completed', {
      batchKey,
      runId: run.runId,
      usedFallback: completion.output === null || completion.output === undefined
    });
  } catch (error) {
    // Keep the existing delivery semantics: orchestration/model unavailability
    // degrades to a deterministic digest rather than suppressing fresh stories.
    ctx.log('warn', 'hn-monitor.relayflow-fallback', { batchKey, error: String(error) });
  }
  return renderDigest(stories, notes);
}

export function scheduledDigestBatchKey(stories: Story[]): string {
  const ids = [...new Set(stories.map((story) => story.id))].sort((a, b) => a - b);
  return `hn-monitor:${SCHEDULED_DIGEST_VERSION}:${ids.join(',')}`;
}

function workflowOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function parseDigestNotes(output: string, stories: Story[]): DigestNotes {
  const marked = output.match(/HN_DIGEST_NOTES_JSON:\s*(\{[^\n\r]*\})/gu)?.at(-1);
  const json = marked?.slice(marked.indexOf('{')) ?? output.match(/\{[\s\S]*\}/u)?.[0] ?? output;
  try {
    const parsed = JSON.parse(json) as { theme?: unknown; stories?: Array<{ id?: unknown; why?: unknown }> };
    const whyById = new Map<number, string>();
    for (const item of parsed.stories ?? []) {
      const id = Number(item.id);
      if (!stories.some((story) => story.id === id) || typeof item.why !== 'string' || !item.why.trim()) continue;
      whyById.set(id, truncate(oneLine(item.why), 180));
    }
    return {
      theme: typeof parsed.theme === 'string' && parsed.theme.trim()
        ? truncate(oneLine(parsed.theme), 220)
        : fallbackTheme(stories),
      whyById
    };
  } catch {
    return { theme: fallbackTheme(stories), whyById: new Map() };
  }
}

export function renderDigest(
  stories: Story[],
  notes: { theme: string; whyById: Map<number, string> }
): { header: string; body: string; stories: PostedStory[] } {
  const feeds = countFeeds(stories);
  const feedSummary = [
    feeds.front_page ? `${feeds.front_page} Front Page` : '',
    feeds.show_hn ? `${feeds.show_hn} Show HN` : '',
    feeds.new ? `${feeds.new} New` : ''
  ].filter(Boolean).join(' · ');
  const noun = stories.length === 1 ? 'signal' : 'signals';
  const header = [
    `:satellite_antenna: *HN agentic radar — ${stories.length} fresh ${noun}*`,
    `_${feedSummary || 'Agent infrastructure and developer tooling'} · Details in thread._`
  ].join('\n');

  const postedStories: PostedStory[] = stories.map((story, index) => ({
    ...story,
    rank: index + 1,
    why: notes.whyById.get(story.id) ?? fallbackWhy(story)
  }));
  const lines = [`*:mag: What stands out*`, `_${escapeSlack(notes.theme)}_`];
  for (const story of postedStories) {
    const category = (story.category ?? 'Agent ecosystem').toUpperCase();
    const metrics = [
      `▲ ${story.points} points`,
      `${story.comments ?? 0} comments`,
      feedLabels(story.feeds)
    ].filter(Boolean).join('  ·  ');
    const article = slackLink(story.url, story.title);
    const hnUrl = story.hnUrl ?? `https://news.ycombinator.com/item?id=${story.id}`;
    lines.push(
      '',
      `*${story.rank} · ${article}*`,
      `\`${escapeSlack(category)}\`  ${metrics}`,
      escapeSlack(story.why),
      `${slackLink(hnUrl, 'HN discussion')}${story.domain ? `  ·  ${escapeSlack(story.domain)}` : ''}`
    );
  }
  lines.push('', '_Want the deeper read? Reply in this thread and @mention me with a story number or title for live details and top HN comments._');
  return { header, body: lines.join('\n'), stories: postedStories };
}

function fallbackTheme(stories: Story[]): string {
  const categories = [...new Set(stories.map((story) => story.category).filter(Boolean))];
  return categories.length > 0
    ? `Fresh signals across ${categories.slice(0, 3).join(', ').toLowerCase()}.`
    : 'Fresh signals for teams building agentic software and developer infrastructure.';
}

function fallbackWhy(story: Story): string {
  const category = (story.category ?? 'agent ecosystem').toLowerCase();
  return `Worth tracking for ${category}; open the article and HN thread for the implementation details and community reaction.`;
}

function feedLabels(feeds: HnFeed[] | undefined): string {
  return (feeds ?? []).map((feed) => ({ front_page: 'Front Page', show_hn: 'Show HN', new: 'New' })[feed]).join(' + ');
}

// ── conversational detail hydration ─────────────────────────────────────

export interface HnStoryDetails {
  id: number;
  title: string;
  url: string;
  hnUrl: string;
  points: number;
  commentsCount: number;
  author?: string;
  text?: string;
  topComments: Array<{ author?: string; text: string; points?: number }>;
}

interface HnItemPayload {
  id?: number;
  title?: string;
  url?: string;
  points?: number;
  author?: string;
  text?: string;
  children?: HnItemPayload[];
}

export async function fetchStoryDetails(storyId: number): Promise<HnStoryDetails | null> {
  const res = await fetchWithTimeout(`https://hn.algolia.com/api/v1/items/${storyId}`, {}, 8_000);
  if (!res?.ok) return null;
  try {
    const item = (await res.json()) as HnItemPayload;
    const id = Number(item.id ?? storyId);
    if (!Number.isSafeInteger(id) || id <= 0 || !item.title?.trim()) return null;
    const hnUrl = `https://news.ycombinator.com/item?id=${id}`;
    const comments = flattenComments(item.children ?? []).slice(0, 8);
    return {
      id,
      title: item.title.trim(),
      url: item.url?.trim() || hnUrl,
      hnUrl,
      points: nonNegativeInt(item.points),
      commentsCount: countComments(item.children ?? []),
      author: item.author?.trim() || undefined,
      text: item.text ? htmlToText(item.text) : undefined,
      topComments: comments
    };
  } catch {
    return null;
  }
}

/**
 * Strict live fallback for questions that contain a complete (or nearly
 * complete) HN story title. This is deliberately conservative: a loose
 * keyword hit is not enough to ground an answer.
 */
export async function findStoryByExactTitle(question: string): Promise<PostedStory | null> {
  const searchTitle = titleCandidateFromQuestion(question);
  const normalizedCandidate = normalizeTitle(searchTitle);
  if (normalizedCandidate.length < 16 || meaningfulTokens(searchTitle).size < 3) return null;

  const url = new URL('https://hn.algolia.com/api/v1/search');
  url.searchParams.set('query', searchTitle);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('hitsPerPage', '20');
  url.searchParams.set('restrictSearchableAttributes', 'title');
  const res = await fetchWithTimeout(url.toString(), {}, 8_000);
  if (!res?.ok) return null;

  let hits: HnHit[];
  try {
    const body = (await res.json()) as { hits?: unknown };
    hits = Array.isArray(body.hits) ? body.hits as HnHit[] : [];
  } catch {
    return null;
  }

  const ranked = hits.flatMap((hit) => {
    const id = Number(hit.objectID);
    const title = hit.title?.trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !title) return [];
    const score = exactTitleMatchScore(normalizedCandidate, normalizeTitle(title));
    return score > 0 ? [{ hit, id, title, score }] : [];
  }).sort((a, b) => b.score - a.score || (b.hit.points ?? 0) - (a.hit.points ?? 0));

  const best = ranked[0];
  if (!best || best.score < 0.9) return null;
  const runnerUp = ranked[1];
  if (runnerUp && (
    (best.score === 1 && runnerUp.score === 1) ||
    (best.score < 1 && best.score - runnerUp.score < 0.08)
  )) return null;

  const hnUrl = `https://news.ycombinator.com/item?id=${best.id}`;
  const articleUrl = best.hit.url?.trim() || hnUrl;
  return {
    id: best.id,
    rank: 1,
    title: best.title,
    url: articleUrl,
    hnUrl,
    points: nonNegativeInt(best.hit.points),
    comments: nonNegativeInt(best.hit.num_comments),
    author: best.hit.author?.trim() || undefined,
    createdAt: best.hit.created_at?.trim() || undefined,
    domain: safeDomain(articleUrl),
    category: 'Live HN title lookup',
    why: 'Matched conservatively from the complete story title supplied in the question.'
  };
}

function titleCandidateFromQuestion(question: string): string {
  const withoutMentions = question.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/giu, ' ');
  const segments = withoutMentions
    .split(/\s*(?:->|→|\n)\s*/gu)
    .map((part) => oneLine(part).replace(/^["'“”]+|["'“”]+$/gu, '').trim())
    .filter(Boolean);
  const nonRequest = segments.filter((part) => !/^(?:give|tell|show|explain|summari[sz]e|what|why|how|can|could|please)\b/iu.test(part));
  return (nonRequest.sort((a, b) => b.length - a.length)[0] ?? segments[0] ?? oneLine(withoutMentions)).slice(0, 300);
}

function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\b(?:show|ask|tell|launch)\s+hn\s*:\s*/gu, '')
    .replace(/[^a-z0-9+]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function exactTitleMatchScore(candidate: string, title: string): number {
  if (!candidate || !title) return 0;
  if (candidate === title) return 1;
  if (
    candidate.startsWith(`${title} `) ||
    candidate.endsWith(` ${title}`) ||
    candidate.includes(` ${title} `)
  ) {
    const containmentRatio = title.length / candidate.length;
    if (containmentRatio >= 0.9) return 0.95 + containmentRatio * 0.04;
  }
  const candidateTokens = new Set(candidate.split(' ').filter(Boolean));
  const titleTokens = title.split(' ').filter(Boolean);
  if (titleTokens.length < 3) return 0;
  const overlap = titleTokens.filter((token) => candidateTokens.has(token)).length;
  const coverage = overlap / titleTokens.length;
  const lengthRatio = Math.min(candidate.length, title.length) / Math.max(candidate.length, title.length);
  return coverage >= 0.9 && lengthRatio >= 0.72 ? coverage * 0.8 + lengthRatio * 0.2 : 0;
}

export function selectQuestionStories(question: string, posts: PostRecord[]): PostedStory[] {
  const recent = dedupePostedStories(posts.flatMap((post) => post.stories ?? [])).slice(0, 60);
  if (recent.length === 0) return [];
  const directId = question.match(/(?:item\?id=|\bpost\s*#?)\s*(\d{3,})/iu)?.[1];
  if (directId) {
    const direct = recent.find((story) => story.id === Number(directId));
    if (direct) return [direct];
  }

  const latest = posts[0]?.stories ?? [];
  const ordinal = ordinalFromQuestion(question);
  if (ordinal !== undefined && latest[ordinal - 1]) return [latest[ordinal - 1]];

  const normalizedQuestion = normalizeTitle(question);
  const embedded = recent.filter((story) => normalizedQuestion.includes(normalizeTitle(story.title)));
  if (embedded.length === 1) return embedded;

  const queryTokens = meaningfulTokens(question);
  const scored = recent
    .map((story) => {
      const shared = [...meaningfulTokens(story.title)].filter((token) => queryTokens.has(token));
      return { story, score: shared.length, distinctive: shared.some((token) => token.length >= 5) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.story.rank - b.story.rank);
  if (scored.length > 0) {
    const top = scored[0]!;
    const tied = scored.filter((item) => item.score === top.score);
    if (tied.length > 1) return [];
    if (top.score >= 2 || top.distinctive) return [top.story];
  }

  if (/\b(?:first|top|#1)\b/iu.test(question) && latest[0]) return [latest[0]];
  if (/\b(?:more|detail|comments?|discussion|reaction)\b/iu.test(question) && recent.length === 1) return [recent[0]];
  return [];
}

function dedupePostedStories(stories: PostedStory[]): PostedStory[] {
  const seen = new Set<number>();
  return stories.filter((story) => {
    if (!Number.isSafeInteger(story.id) || seen.has(story.id)) return false;
    seen.add(story.id);
    return true;
  });
}

function ordinalFromQuestion(question: string): number | undefined {
  const numbered = question.match(/(?:story|post|item|#)\s*#?\s*([1-9]|1\d|20)\b/iu)?.[1];
  if (numbered) return Number(numbered);
  const words: Array<[RegExp, number]> = [
    [/\bfirst\b/iu, 1], [/\bsecond\b/iu, 2], [/\bthird\b/iu, 3], [/\bfourth\b/iu, 4], [/\bfifth\b/iu, 5]
  ];
  return words.find(([pattern]) => pattern.test(question))?.[1];
}

function meaningfulTokens(value: string): Set<string> {
  const stop = new Set(['about', 'article', 'could', 'details', 'found', 'from', 'have', 'more', 'post', 'show', 'story', 'tell', 'that', 'the', 'this', 'what', 'with', 'would', 'your']);
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/gu)?.filter((token) => !stop.has(token)) ?? []);
}

function flattenComments(children: HnItemPayload[]): Array<{ author?: string; text: string; points?: number }> {
  const comments: Array<{ author?: string; text: string; points?: number }> = [];
  const visit = (items: HnItemPayload[]): void => {
    for (const item of items) {
      const text = item.text ? htmlToText(item.text) : '';
      if (text) comments.push({ author: item.author?.trim() || undefined, text: truncate(text, 700), points: item.points });
      if (item.children?.length) visit(item.children);
    }
  };
  visit(children);
  return comments
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    .slice(0, 20);
}

function countComments(children: HnItemPayload[]): number {
  return children.reduce((count, child) => count + 1 + countComments(child.children ?? []), 0);
}

function renderStoryDetailsForPrompt(details: HnStoryDetails): string {
  const comments = details.topComments.length
    ? details.topComments.map((comment, index) => `${index + 1}. ${comment.author ? `${comment.author}: ` : ''}${comment.text}`).join('\n')
    : '(No readable comments returned.)';
  return [
    `### ${details.title} [id=${details.id}]`,
    `Article: ${details.url}`,
    `HN discussion: ${details.hnUrl}`,
    `Points: ${details.points}; comments: ${details.commentsCount}; author: ${details.author ?? 'unknown'}`,
    details.text ? `Story text: ${details.text}` : '',
    `Top HN comments:\n${comments}`
  ].filter(Boolean).join('\n');
}

function htmlToText(html: string): string {
  return html
    .replace(/<p>/giu, '\n\n')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/giu, '$2 ($1)')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function safeDomain(rawUrl: string): string | undefined {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./u, '');
    return host === 'news.ycombinator.com' ? undefined : host;
  } catch {
    return undefined;
  }
}

function nonNegativeInt(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function boundedPositiveInt(raw: string, name: string, max: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeSlack(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function slackLink(url: string, label: string): string {
  const safeUrl = url.replace(/\|/gu, '%7C').replace(/</gu, '%3C').replace(/>/gu, '%3E');
  return `<${safeUrl}|${escapeSlack(label)}>`;
}

// ── memory helpers ───────────────────────────────────────────────────────

function exactDigestStatePath(ctx: WorkforceCtx): string | null {
  const channel = input(ctx, 'SLACK_CHANNEL')?.trim();
  if (!channel) return null;
  return `/slack/channels/${encodeURIComponent(channel)}/hn-monitor/recent-digests.json`;
}

function exactDigestThreadPath(ctx: WorkforceCtx, threadTs: string): string | null {
  const channel = input(ctx, 'SLACK_CHANNEL')?.trim();
  if (!channel || !threadTs.trim()) return null;
  return `/slack/channels/${encodeURIComponent(channel)}/hn-monitor/digests/by-thread/${encodeURIComponent(threadTs)}.json`;
}

async function readExactPost(ctx: WorkforceCtx, path: string): Promise<PostRecord | null> {
  try {
    const parsed = JSON.parse(await ctx.files.read(path)) as unknown;
    return isPostRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadExactPosts(ctx: WorkforceCtx, threadTs?: string): Promise<PostRecord[]> {
  const path = exactDigestStatePath(ctx);
  if (!path) return [];
  const files = ctx.files;
  if (!files) return [];
  const threadPath = threadTs ? exactDigestThreadPath(ctx, threadTs) : null;
  const threadPost = threadPath ? await readExactPost(ctx, threadPath) : null;
  try {
    const state = JSON.parse(await files.read(path)) as Partial<RecentDigestState>;
    const indexed = state.kind === 'hn-monitor exact recent digests' && state.version === 1 && Array.isArray(state.posts)
      ? state.posts.filter(isPostRecord)
      : [];
    return mergePosts(threadPost ? [threadPost] : [], indexed).slice(0, 12);
  } catch {
    return threadPost ? [threadPost] : [];
  }
}

async function saveExactPost(ctx: WorkforceCtx, record: PostRecord): Promise<ExactPostSaveResult> {
  const path = exactDigestStatePath(ctx);
  if (!path) return { applicable: false, saved: true, threadShardSaved: false, indexSaved: false };
  if (!ctx.files) return { applicable: true, saved: false, threadShardSaved: false, indexSaved: false };

  // The per-thread shard is authoritative for Slack follow-ups. Concurrent
  // digests have distinct delivered thread timestamps, so they write distinct
  // paths and cannot erase one another. The rolling file below is only a
  // convenience index for generic/non-thread questions.
  const slackThreadRefs = (record.threadRefs ?? []).filter((ref) =>
    ref.provider === 'slack' && Boolean(ref.threadTs) && (!ref.channel || ref.channel === input(ctx, 'SLACK_CHANNEL')?.trim())
  );
  let threadShardSaved = slackThreadRefs.length === 0;
  for (const ref of slackThreadRefs) {
    const threadPath = exactDigestThreadPath(ctx, ref.threadTs ?? '');
    if (!threadPath) continue;
    try {
      await ctx.files.write(threadPath, `${JSON.stringify(record, null, 2)}\n`);
      threadShardSaved = true;
    } catch (error) {
      ctx.log('warn', 'hn-monitor.post-state-shard-unavailable', { error: String(error) });
    }
  }

  let indexSaved = false;
  try {
    const posts = mergePosts([record], await loadExactPosts(ctx)).slice(0, 12);
    const state: RecentDigestState = {
      kind: 'hn-monitor exact recent digests',
      version: 1,
      updatedAt: new Date().toISOString(),
      posts
    };
    await ctx.files.write(path, `${JSON.stringify(state, null, 2)}\n`);
    indexSaved = true;
  } catch (error) {
    ctx.log('warn', 'hn-monitor.post-state-index-unavailable', { error: String(error) });
  }

  return {
    applicable: true,
    saved: slackThreadRefs.length > 0 ? threadShardSaved : indexSaved,
    threadShardSaved,
    indexSaved
  };
}

function isPostRecord(value: unknown): value is PostRecord {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.postedAt === 'string' &&
    typeof record.digest === 'string' &&
    Array.isArray(record.stories)
  );
}

function mergePosts(...groups: PostRecord[][]): PostRecord[] {
  const seen = new Set<string>();
  return groups
    .flat()
    .filter(isPostRecord)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .filter((post) => {
      const key = postKey(post);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function postKey(post: PostRecord): string {
  return `${post.postedAt}|${post.stories.map((story) => story.id).join(',')}`;
}

function postGroupContains(posts: PostRecord[], candidate: PostRecord): boolean {
  const key = postKey(candidate);
  return posts.some((post) => postKey(post) === key);
}

function findThreadPost(posts: PostRecord[], expanded: unknown, threadContext: string): PostRecord | undefined {
  const root = asRecord(expanded);
  const data = asRecord(root?.data) ?? root;
  const message = asRecord(data?.message) ?? asRecord(data?.event);
  const referenceValues = [
    data?.parentRef,
    data?.parent_ref,
    data?.threadRef,
    data?.thread_ref,
    message?.parentRef,
    message?.parent_ref,
    message?.threadRef,
    message?.thread_ref
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const byRef = posts.filter((post) => post.threadRefs?.some((ref) => referenceValues.includes(ref.draftRef)));
  if (byRef.length === 1) return byRef[0];

  const inboundChannel = str(data?.channel) ?? str(message?.channel);
  const inboundThreadTs = str(data?.thread_ts) ?? str(data?.threadTs) ?? str(message?.thread_ts) ?? str(message?.threadTs);
  const byTimestamp = posts.filter((post) => post.threadRefs?.some((ref) =>
    ref.provider === 'slack' &&
    Boolean(ref.threadTs) &&
    ref.threadTs === inboundThreadTs &&
    (!ref.channel || !inboundChannel || ref.channel === inboundChannel)
  ));
  if (byTimestamp.length === 1) return byTimestamp[0];

  const normalizedContext = normalizeTitle(threadContext);
  if (!normalizedContext) return undefined;
  const byTitle = posts.filter((post) => post.stories.some((story) => {
    const title = normalizeTitle(story.title);
    return title.length >= 12 && normalizedContext.includes(title);
  }));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

async function loadSlackThreadContext(ctx: WorkforceCtx, expanded: unknown): Promise<string> {
  const inline = inlineSlackThreadParentText(expanded);
  if (inline) {
    ctx.log('info', 'hn-monitor.qa.thread-context', { source: 'event', available: true });
    return truncate(inline, 8_000);
  }

  const root = asRecord(expanded);
  const path = str(root?.path);
  const match = path?.match(/^(\/slack\/channels\/[^/]+\/threads\/[^/]+)\/replies\/[^/]+\/meta\.json$/u);
  const channelRoot = path?.match(/^(\/slack\/channels\/[^/]+)\/(?:messages|threads)\//u)?.[1];
  const files = (ctx as WorkforceCtx & { files?: WorkforceCtx['files'] }).files;
  const data = asRecord(root?.data);
  const channel = str(data?.channel);
  const threadTs = str(data?.thread_ts) ?? str(data?.threadTs);
  const mountedParentPath = channelRoot && threadTs
    ? `${channelRoot}/messages/${slackTimestampPathToken(threadTs)}/meta.json`
    : null;
  const bareParentPath = channel && threadTs
    ? `/slack/channels/${encodeURIComponent(channel)}/messages/${slackTimestampPathToken(threadTs)}/meta.json`
    : null;
  const parentPaths = [match?.[1] ? `${match[1]}/meta.json` : null, mountedParentPath, bareParentPath]
    .filter((candidate): candidate is string => Boolean(candidate));
  if (files) {
    for (const parentPath of parentPaths) {
      try {
        const parent = JSON.parse(await files.read(parentPath)) as unknown;
        const text = textFromSlackRecord(parent);
        if (text) {
          ctx.log('info', 'hn-monitor.qa.thread-context', { source: 'relayfile', available: true });
          return truncate(text, 8_000);
        }
      } catch {
        // Try the next compatible Slack layout.
      }
    }
  }
  ctx.log('info', 'hn-monitor.qa.thread-context', { source: 'none', available: false });
  return '';
}

function slackTimestampPathToken(value: string): string {
  return value.replace(/\./gu, '_').replace(/[^A-Za-z0-9_-]/gu, '');
}

function inlineSlackThreadParentText(expanded: unknown): string {
  const root = asRecord(expanded);
  const data = asRecord(root?.data) ?? root;
  const message = asRecord(data?.message) ?? asRecord(data?.event);
  const candidates = [
    data?.thread_parent,
    data?.threadParent,
    data?.parent_message,
    data?.parentMessage,
    data?.parent,
    message?.thread_parent,
    message?.threadParent,
    message?.parent_message,
    message?.parentMessage,
    message?.parent
  ];
  for (const candidate of candidates) {
    const text = textFromSlackRecord(candidate);
    if (text) return text;
  }
  return str(data?.thread_parent_text) ?? str(data?.parent_text) ?? '';
}

function textFromSlackRecord(value: unknown): string {
  if (typeof value === 'string') return oneLine(value);
  const record = asRecord(value);
  if (!record) return '';
  return oneLine(str(record.text) ?? str(record.body) ?? str(record.digest) ?? '');
}

async function loadSeen(ctx: WorkforceCtx): Promise<number[]> {
  const items = await ctx.memory.recall('hn-monitor seen story ids already posted', {
    tags: ['hn-monitor:seen'],
    scope: 'workspace',
    limit: 20,
    failOnError: true
  });
  for (const item of [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    try {
      const parsed = JSON.parse(item.content) as number[] | { ids?: unknown };
      const ids = Array.isArray(parsed) ? parsed : parsed.ids;
      if (Array.isArray(ids)) return ids.filter((id): id is number => Number.isSafeInteger(id));
    } catch {
      // try the next recalled version
    }
  }
  return [];
}
async function saveSeen(ctx: WorkforceCtx, ids: number[]): Promise<void> {
  await saveCriticalMemory(ctx, JSON.stringify({ kind: 'hn-monitor seen story ids already posted', ids }), {
    tags: ['hn-monitor:seen'],
    scope: 'workspace'
  });
}
async function savePost(ctx: WorkforceCtx, record: PostRecord): Promise<boolean> {
  let exactStateSaved = false;
  try {
    const result = await saveExactPost(ctx, record);
    exactStateSaved = result.saved;
    if (!result.applicable) {
      ctx.log('info', 'hn-monitor.post-state-not-applicable', { reason: 'Slack is not configured' });
    } else if (result.saved) {
      ctx.log('info', 'hn-monitor.post-state-saved', {
        stories: record.stories.length,
        threadShardSaved: result.threadShardSaved,
        indexSaved: result.indexSaved
      });
    } else {
      ctx.log('error', 'hn-monitor.post-state-unavailable', { reason: 'Slack exact-state path unavailable' });
    }
  } catch (error) {
    ctx.log('error', 'hn-monitor.post-state-unavailable', { error: String(error) });
  }

  try {
    const receipt = await ctx.memory.save(JSON.stringify({ kind: 'hn-monitor posted digest', ...record }), {
      tags: ['hn-monitor:post'],
      scope: 'workspace'
    });
    if (receipt?.id) {
      ctx.log('info', 'hn-monitor.post-memory-saved', { memoryId: receipt.id });
    } else {
      ctx.log('warn', 'hn-monitor.post-memory-unavailable', { reason: 'memory save returned no receipt' });
    }
  } catch (error) {
    ctx.log('warn', 'hn-monitor.post-memory-unavailable', { error: String(error) });
  }
  return exactStateSaved;
}

async function loadDigestOutbox(ctx: WorkforceCtx): Promise<DigestOutbox | null> {
  const items = await ctx.memory.recall('hn-monitor durable digest outbox', {
    tags: ['hn-monitor:digest-outbox'],
    scope: 'workspace',
    limit: 20,
    failOnError: true
  });
  for (const item of [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    if (!item.content) continue;
    try {
      const value = JSON.parse(item.content) as unknown;
      if (isClearedDigestOutbox(value)) return null;
      if (isDigestOutbox(value)) return value;
    } catch {
      // try the next recalled version
    }
  }
  return null;
}

async function migrateLegacyDigestOutbox(
  ctx: WorkforceCtx,
  configuredTargets: ReadonlyArray<string>
): Promise<DigestOutbox | null> {
  const [pendingBody, pendingState] = await Promise.all([
    loadLegacyPendingThreadBody(ctx),
    loadLegacyPendingPostState(ctx)
  ]);
  if (pendingBody) {
    const targets = supportedDigestTargets(pendingBody.targets.split(','));
    if (targets.length === 0) return null;
    const batchKey = scheduledDigestBatchKey(pendingBody.stories);
    const outbox = newDigestOutbox(
      batchKey,
      pendingBody.header,
      pendingBody.body,
      pendingBody.stories,
      [],
      targets
    );
    outbox.phase = 'bodies';
    outbox.createdAt = pendingBody.createdAt;
    outbox.legacyRecovery = true;
    for (const [provider, state] of digestProviderEntries(outbox)) {
      const ref = pendingBody.headerRefs.find((candidate) => candidate.provider === provider);
      state.header.status = ref ? 'delivered' : 'omitted';
      state.header.ref = ref;
      if (!ref) state.body.status = 'omitted';
    }
    await saveDigestOutbox(ctx, outbox);
    ctx.log('info', 'hn-monitor.legacy-recovery-migrated', { phase: 'bodies', batchKey });
    return outbox;
  }
  if (pendingState) {
    const configured = supportedDigestTargets(configuredTargets);
    const recorded = supportedDigestTargets((pendingState.record.threadRefs ?? []).map((ref) => ref.provider));
    const targets = recorded.length > 0 ? recorded : configured;
    if (targets.length === 0) return null;
    const batchKey = scheduledDigestBatchKey(pendingState.record.stories);
    const lines = pendingState.record.digest.split('\n');
    const outbox = newDigestOutbox(
      batchKey,
      lines[0] ?? pendingState.record.digest,
      lines.slice(1).join('\n'),
      pendingState.record.stories,
      [],
      targets
    );
    outbox.phase = 'state';
    outbox.createdAt = pendingState.record.postedAt;
    outbox.legacyRecovery = true;
    for (const [provider, state] of digestProviderEntries(outbox)) {
      const ref = pendingState.record.threadRefs?.find((candidate) => candidate.provider === provider);
      state.header.status = ref ? 'delivered' : 'omitted';
      state.header.ref = ref;
      state.body.status = ref ? 'delivered' : 'omitted';
    }
    await saveDigestOutbox(ctx, outbox);
    ctx.log('info', 'hn-monitor.legacy-recovery-migrated', { phase: 'state', batchKey });
    return outbox;
  }
  return null;
}

async function loadLegacyPendingThreadBody(ctx: WorkforceCtx): Promise<LegacyPendingThreadBody | null> {
  const items = await ctx.memory.recall('hn-monitor pending threaded digest body', {
    tags: ['hn-monitor:pending-thread-body'],
    scope: 'workspace',
    limit: 20,
    failOnError: true
  });
  for (const item of [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    try {
      const record = asRecord(JSON.parse(item.content));
      if (record?.cleared === true) return null;
      if (
        record &&
        typeof record.targets === 'string' &&
        typeof record.header === 'string' &&
        typeof record.body === 'string' &&
        typeof record.createdAt === 'string' &&
        Array.isArray(record.stories) && record.stories.every(isPostedStory) &&
        Array.isArray(record.headerRefs) && record.headerRefs.every(isSavedHeaderRef)
      ) return record as unknown as LegacyPendingThreadBody;
    } catch {
      // try the next recalled version
    }
  }
  return null;
}

async function loadLegacyPendingPostState(ctx: WorkforceCtx): Promise<LegacyPendingPostState | null> {
  const items = await ctx.memory.recall('hn-monitor pending exact post state', {
    tags: ['hn-monitor:pending-post-state'],
    scope: 'workspace',
    limit: 20,
    failOnError: true
  });
  for (const item of [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))) {
    try {
      const record = asRecord(JSON.parse(item.content));
      if (record?.cleared === true) return null;
      if (
        record &&
        isPostRecord(record.record) &&
        record.record.stories.every(isPostedStory) &&
        (record.record.threadRefs ?? []).every(isSavedHeaderRef)
      ) {
        return { record: record.record };
      }
    } catch {
      // try the next recalled version
    }
  }
  return null;
}

function supportedDigestTargets(values: ReadonlyArray<string>): DigestProvider[] {
  return [...new Set(values.filter((value): value is DigestProvider => value === 'slack' || value === 'telegram'))];
}

function isSavedHeaderRef(value: unknown): value is SavedHeaderRef {
  const ref = asRecord(value);
  return Boolean(
    ref &&
    (ref.provider === 'slack' || ref.provider === 'telegram') &&
    typeof ref.draftRef === 'string' && ref.draftRef.length > 0
  );
}

async function clearLegacyRecoveryMarkers(ctx: WorkforceCtx): Promise<void> {
  await saveCriticalMemory(ctx, JSON.stringify({
    kind: 'hn-monitor pending thread body',
    cleared: true,
    createdAt: new Date().toISOString()
  }), {
    tags: ['hn-monitor:pending-thread-body'],
    scope: 'workspace'
  });
  await saveCriticalMemory(ctx, JSON.stringify({
    kind: 'hn-monitor pending exact post state',
    cleared: true,
    createdAt: new Date().toISOString()
  }), {
    tags: ['hn-monitor:pending-post-state'],
    scope: 'workspace'
  });
}

function isClearedDigestOutbox(value: unknown): boolean {
  const record = asRecord(value);
  return record?.kind === 'hn-monitor digest outbox' &&
    record.version === 1 &&
    record.cleared === true &&
    typeof record.batchKey === 'string' &&
    /^hn-monitor:v1:\d+(?:,\d+)*$/u.test(record.batchKey);
}

function isDigestOutbox(value: unknown): value is DigestOutbox {
  const record = asRecord(value);
  if (
    record?.kind !== 'hn-monitor digest outbox' ||
    record.version !== 1 ||
    record.cleared === true ||
    typeof record.batchKey !== 'string' ||
    !/^hn-monitor:v1:\d+(?:,\d+)*$/u.test(record.batchKey) ||
    !['claim', 'headers', 'bodies', 'state'].includes(String(record.phase)) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.header !== 'string' ||
    typeof record.body !== 'string' ||
    !Array.isArray(record.stories) ||
    !record.stories.every((story) => isPostedStory(story)) ||
    !isSafeIntegerArray(record.seenBefore) ||
    !isSafeIntegerArray(record.seenClaim) ||
    (record.legacyRecovery !== undefined && record.legacyRecovery !== true)
  ) return false;

  const storyIds = record.stories.map((story) => (story as PostedStory).id);
  if (new Set(storyIds).size !== storyIds.length) return false;
  const expectedBatchKey = `hn-monitor:v1:${storyIds.sort((a, b) => a - b).join(',')}`;
  if (record.batchKey !== expectedBatchKey) return false;
  const phase = String(record.phase) as DigestOutboxPhase;
  const providers = asRecord(record.providers);
  if (!providers) return false;
  let count = 0;
  for (const provider of ['slack', 'telegram'] as const) {
    if (providers[provider] === undefined) continue;
    const state = asRecord(providers[provider]);
    const header = asRecord(state?.header);
    const body = asRecord(state?.body);
    if (
      !isDigestOutboxEffect(header, digestOperationKey(record.batchKey, provider, 'header'), provider) ||
      !isDigestOutboxEffect(body, digestOperationKey(record.batchKey, provider, 'body'), provider)
    ) return false;
    if ((phase === 'bodies' || phase === 'state') && header?.status === 'pending') return false;
    if (phase === 'state' && body?.status === 'pending') return false;
    count += 1;
  }
  return count > 0;
}

function isDigestOutboxEffect(
  value: Record<string, unknown> | null,
  operationKey: string,
  provider: DigestProvider
): boolean {
  if (
    !value ||
    !['pending', 'delivered', 'omitted'].includes(String(value.status)) ||
    value.operationKey !== operationKey
  ) return false;
  if (value.ref === undefined) return true;
  const ref = asRecord(value.ref);
  return ref?.provider === provider && typeof ref.draftRef === 'string' && ref.draftRef.length > 0;
}

function isPostedStory(value: unknown): value is PostedStory {
  const story = asRecord(value);
  return Boolean(
    story &&
    Number.isSafeInteger(story.id) && Number(story.id) > 0 &&
    Number.isSafeInteger(story.rank) && Number(story.rank) > 0 &&
    typeof story.title === 'string' && story.title.length > 0 &&
    typeof story.url === 'string' && story.url.length > 0
  );
}

function isSafeIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => Number.isSafeInteger(item));
}

async function saveDigestOutbox(ctx: WorkforceCtx, outbox: DigestOutbox): Promise<void> {
  outbox.updatedAt = new Date().toISOString();
  await saveCriticalMemory(ctx, JSON.stringify(outbox), {
    tags: ['hn-monitor:digest-outbox'],
    scope: 'workspace'
  });
}

async function clearDigestOutbox(ctx: WorkforceCtx, batchKey: string): Promise<void> {
  await saveCriticalMemory(ctx, JSON.stringify({
    kind: 'hn-monitor digest outbox',
    version: 1,
    cleared: true,
    batchKey,
    createdAt: new Date().toISOString()
  }), {
    tags: ['hn-monitor:digest-outbox'],
    scope: 'workspace'
  });
}

async function saveCriticalMemory(
  ctx: WorkforceCtx,
  content: string,
  opts: { tags: string[]; scope: 'workspace' }
): Promise<void> {
  const receipt = await ctx.memory.save(content, opts);
  if (!receipt?.id) throw new Error(`durable memory write returned no receipt (${opts.tags.join(',')})`);
}

async function loadPosts(ctx: WorkforceCtx): Promise<PostRecord[]> {
  const items = await ctx.memory.recall('hn-monitor posted digest', {
    tags: ['hn-monitor:post'],
    scope: 'workspace',
    limit: 60
  });
  const posts: PostRecord[] = [];
  for (const item of items) {
    try {
      const parsed = JSON.parse(item.content) as unknown;
      if (isPostRecord(parsed)) posts.push(parsed);
    } catch {
      // skip malformed records
    }
  }
  return posts.sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''));
}
