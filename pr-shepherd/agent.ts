/**
 * PR Shepherd — agent handler.
 *
 * Two wakeup paths:
 *
 * 1. GitHub webhooks → updateLedger()
 *    Maintains a cloud-side ledger of PR state: last human activity,
 *    last bot activity, CI status, review state. Updated as events land;
 *    no crawl on each timer tick.
 *
 * 2. Cron timer (hourly) → evaluateLedger()
 *    Evaluates the ledger against the staleness taxonomy and fires the
 *    escalation ladder. Cloud is the sole escalator — two instances of this
 *    agent would double-ping the same PR (the AR-448 pattern in a new costume).
 *
 * 3. Relay DM → handleInboxMessage()
 *    Answers questions about PR state grounded in the ledger; no inference.
 *
 * DRY_RUN=true: the cron path runs all evaluation logic, logs every alert it
 * would fire, but writes nothing to Slack and records no escalation entries.
 * Use this for the initial read-only proof against real PRs.
 *
 * Backfill: on the first cron tick the ledger is empty (webhooks only describe
 * PRs that move after listening starts). backfillLedger() performs a one-time
 * REST crawl of all open PRs in the org and seeds the ledger from the GitHub
 * API. Closed PRs are never backfilled. PRs over 60 days old that emit no
 * webhook events are caught only by this path — do not skip it.
 *
 * See: principals/khaliq/workstreams/pr-shepherd-agent.md
 */

import {
  defineAgent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  type AgentEvent,
  type WorkforceCtx
} from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

// ── Types ───────────────────────────────────────────────────────────────────

/** One entry in the cloud-side ledger, keyed by {owner}/{repo}/{prNumber}. */
export interface PrLedgerEntry {
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  url: string;
  author: string;
  /** Carried in from trajectory-lead; never invented here. Null until linked. */
  workUnitId: string | null;
  /**
   * The surface that owns this work unit — e.g. "linear", "github", "notion".
   * Chief's ruling (2026-08-11): work_unit_id is scoped by work_unit_surface;
   * the two fields together form the durable, surface-agnostic reference.
   * Display as "{surface}:{id}" — never assume Linear.
   */
  workUnitSurface: string | null;
  /**
   * ai-hist session UUID — the durable conversation reference for this PR.
   * Carried in from trajectory-lead alongside workUnitId; never invented here.
   *
   * This field is LOAD-BEARING for durability. Relaycast messages have a 30-day
   * TTL (relaycast cloudflare.ts messageTtlDays: 30) and are not suitable as
   * 6-month pointer targets. The ai-hist session UUID is the permanent record —
   * it survives relay restarts, relaycast schema changes, and the TTL window.
   *
   * Null until factory session-UUID injection at commit time is confirmed
   * (cloud#2981 open question 1). When present, stamped in every Slack alert
   * so a human can run `ai-hist session <uuid>` and read the full conversation
   * context behind the PR.
   */
  sessionRef: string | null;
  isDraft: boolean;
  openedAt: string;                  // ISO; when the PR was opened on GitHub
  /** Last timestamp where the actor is a human (not a bot or CI). */
  lastHumanActivityAt: string;
  /** Last timestamp from any automated actor (CI, bot push). */
  lastBotActivityAt: string | null;
  ciStatus: 'pending' | 'passing' | 'failing' | null;
  reviewState: 'awaiting-review' | 'changes-requested' | 'approved' | null;
  /** ISO; null until the PR is merged or closed. */
  closedAt: string | null;
  /** ISO; when this ledger entry was last written. */
  ledgerUpdatedAt: string;
}

/** One escalation record, keyed by {owner}/{repo}/{prNumber}/{bin}/{rung}. */
export interface EscalationRecord {
  firedAt: string;        // ISO
  slackTs: string | null; // delivered ts from Slack, null in dry-run
  /** ref from slackClient().post() — used for rung-2 replyTo threading. */
  slackRef: string | null;
}

export type StalenesssBin = 'awaiting-review' | 'awaiting-author' | 'ci-red' | 'abandoned';

export interface StalenessResult {
  bin: StalenesssBin;
  daysSinceRelevantActivity: number;
  reason: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const LEDGER_TAG = 'pr-shepherd:ledger';
const ESCALATION_TAG_PREFIX = 'pr-shepherd:escalation';
const BACKFILL_DONE_TAG = 'pr-shepherd:backfill-done';
const BOT_LOGIN_PATTERNS = [/\[bot\]$/i, /^dependabot/i, /^renovate/i, /^github-actions/i];

// ── Entry point ─────────────────────────────────────────────────────────────

export default defineAgent({
  // Cron: hourly evaluation of the ledger against the staleness taxonomy.
  // Name follows rule §5 of the SKILL.md — operationally useful, not job1.
  schedules: [{ name: 'stale-pr-scan', cron: '0 * * * *', tz: 'UTC' }],

  // Webhooks: maintain the ledger as events land; no crawl on each tick.
  // Event types mirror agents/review/agent.ts:75-98 (the proven pattern)
  // plus pull_request.closed to mark merged/closed entries.
  triggers: {
    github: [
      { on: 'pull_request.opened' },
      { on: 'pull_request.edited' },       // trajectory pointer back-annotated via PATCH /pulls/{number}
      { on: 'pull_request.closed' },
      { on: 'pull_request.synchronize' },
      { on: 'pull_request.converted_to_draft' },
      { on: 'pull_request.ready_for_review' },
      { on: 'pull_request_review.submitted' },
      { on: 'pull_request_review_comment.created' },
      { on: 'check_run.completed' },
      { on: 'issue_comment.created' }
    ]
  },

  handler: async (ctx, event) => {
    // Cron: evaluate ledger, fire escalation ladder.
    if (isCronTickEvent(event)) {
      return evaluateLedger(ctx);
    }

    // Relay DM: answer questions about PR state grounded in the ledger.
    if (isRelaycastMessageEvent(event)) {
      return handleInboxMessage(ctx, event);
    }

    // GitHub webhook: update ledger entry.
    if (event.type.startsWith('github.')) {
      const data = (await event.expand('full')).data;
      return updateLedger(ctx, event.type, data);
    }
  }
});

// ── Ledger update (webhook path) ────────────────────────────────────────────

/**
 * Process a GitHub webhook event and upsert the corresponding ledger entry.
 * The actor field on every event is used to distinguish human vs bot activity —
 * no inference from timestamps alone.
 */
export async function updateLedger(
  ctx: WorkforceCtx,
  eventType: string,
  data: unknown
): Promise<void> {
  const d = data as Record<string, unknown>;

  // All events we handle carry a pull_request object (directly or via
  // check_run → pull_requests[0]). Extract the canonical PR reference.
  const pr = extractPr(eventType, d);
  if (!pr) {
    ctx.log('info', 'pr-shepherd.ledger.no-pr', { eventType });
    return;
  }

  const key = ledgerKey(pr.owner, pr.repo, pr.number);
  const existing = await loadLedgerEntry(ctx, key);
  const now = new Date().toISOString();
  const actorLogin = extractActorLogin(d);
  const isBot = actorLogin ? isKnownBot(actorLogin) : false;

  const entry: PrLedgerEntry = existing ?? {
    owner: pr.owner,
    repo: pr.repo,
    prNumber: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    workUnitId: null,
    workUnitSurface: null,
    sessionRef: null,
    isDraft: pr.isDraft,
    openedAt: pr.createdAt,
    lastHumanActivityAt: pr.createdAt,
    lastBotActivityAt: null,
    ciStatus: null,
    reviewState: null,
    closedAt: null,
    ledgerUpdatedAt: now
  };

  // Update fields based on event type.
  if (eventType === 'github.pull_request.opened') {
    entry.title = pr.title;
    entry.isDraft = pr.isDraft;
    entry.reviewState = 'awaiting-review';
    if (!isBot) entry.lastHumanActivityAt = now;
  }

  if (eventType === 'github.pull_request.closed') {
    entry.closedAt = now;
    // Keep the entry — closed PRs remain in the ledger for reference
    // and so the trajectory trace can walk merge → deploy. They are
    // silently excluded from staleness evaluation.
  }

  if (eventType === 'github.pull_request.synchronize') {
    // New commit pushed to the PR branch.
    if (!isBot) {
      entry.lastHumanActivityAt = now;
      // A new commit clears awaiting-author (author responded to review).
      if (entry.reviewState === 'changes-requested') {
        entry.reviewState = 'awaiting-review';
      }
    } else {
      entry.lastBotActivityAt = now;
    }
  }

  if (eventType === 'github.pull_request.converted_to_draft') {
    entry.isDraft = true;
  }

  if (eventType === 'github.pull_request.ready_for_review') {
    entry.isDraft = false;
    entry.reviewState = 'awaiting-review';
    if (!isBot) entry.lastHumanActivityAt = now;
  }

  if (eventType === 'github.pull_request_review.submitted') {
    const review = d.review as Record<string, unknown> | undefined;
    const state = review?.state as string | undefined;
    if (!isBot) entry.lastHumanActivityAt = now;
    if (state === 'changes_requested') {
      entry.reviewState = 'changes-requested';
    } else if (state === 'approved') {
      entry.reviewState = 'approved';
    }
  }

  if (eventType === 'github.pull_request_review_comment.created') {
    if (!isBot) entry.lastHumanActivityAt = now;
  }

  if (eventType === 'github.issue_comment.created') {
    if (!isBot) entry.lastHumanActivityAt = now;
  }

  if (eventType === 'github.check_run.completed') {
    const checkRun = d.check_run as Record<string, unknown> | undefined;
    const conclusion = checkRun?.conclusion as string | undefined;
    entry.lastBotActivityAt = now;
    if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') {
      entry.ciStatus = 'passing';
    } else if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
      entry.ciStatus = 'failing';
    } else {
      entry.ciStatus = 'pending';
    }
  }

  // Parse the trajectory pointer from the PR body on every pull_request event.
  // The pointer is appended by trajectory-lead when it links the PR to a work
  // unit — it may arrive on any subsequent event after the PR is opened.
  // Never clobber an existing non-null value with null (pointer may be absent
  // on a synchronize event if the body wasn't included in the payload).
  if (eventType.startsWith('github.pull_request') && pr.body !== null) {
    const pointer = extractTrajectoryPointer(pr.body);
    if (pointer.workUnitId !== null) entry.workUnitId = pointer.workUnitId;
    if (pointer.workUnitSurface !== null) entry.workUnitSurface = pointer.workUnitSurface;
    if (pointer.sessionRef !== null) entry.sessionRef = pointer.sessionRef;
    if (pointer.workUnitId !== null) {
      ctx.log('info', 'pr-shepherd.ledger.trajectory-pointer', {
        key,
        workUnitId: pointer.workUnitId,
        workUnitSurface: pointer.workUnitSurface,
        sessionRef: pointer.sessionRef
      });
    }
  }

  entry.ledgerUpdatedAt = now;

  await saveLedgerEntry(ctx, key, entry);
  ctx.log('info', 'pr-shepherd.ledger.updated', {
    key,
    eventType,
    reviewState: entry.reviewState,
    ciStatus: entry.ciStatus,
    closedAt: entry.closedAt
  });
}

// ── Ledger evaluation (cron path) ───────────────────────────────────────────

/**
 * Load every ledger entry, classify staleness, and fire the escalation ladder.
 * Cloud is the sole writer of escalation records and Slack alerts — a second
 * instance running this path would double-ping. If you deploy a local reader,
 * set LOCAL_READ_ONLY=true and never run evaluateLedger() locally.
 */
export async function evaluateLedger(ctx: WorkforceCtx): Promise<void> {
  const isLocalReadOnly = resolveInput(ctx, 'LOCAL_READ_ONLY') === 'true';
  if (isLocalReadOnly) {
    ctx.log('info', 'pr-shepherd.evaluate.skip', { reason: 'LOCAL_READ_ONLY=true — local instance, cron path disabled' });
    return;
  }
  const isDryRun = resolveInput(ctx, 'DRY_RUN') === 'true';
  const channel = resolveInput(ctx, 'SLACK_CHANNEL');

  ctx.log('info', 'pr-shepherd.evaluate.start', { dryRun: isDryRun, channel: channel ?? 'none' });

  // Backfill: seed the ledger from the GitHub REST API on the first tick.
  // Only open, non-draft PRs are backfilled. Closed/merged PRs are excluded.
  const backfillDone = await isBackfillDone(ctx);
  if (!backfillDone) {
    await backfillLedger(ctx);
    await markBackfillDone(ctx);
  }

  const entries = await loadAllLedgerEntries(ctx);
  ctx.log('info', 'pr-shepherd.evaluate.loaded', { count: entries.length });

  const thresholds = resolveThresholds(ctx);
  const rung2Multiplier = Number(resolveInput(ctx, 'ESCALATION_RUNG2_MULTIPLIER') ?? '2');

  let evaluated = 0;
  let escalated = 0;
  let skipped = 0;

  for (const entry of entries) {
    // Skip closed PRs and drafts — drafts are not stale by definition.
    if (entry.closedAt || entry.isDraft) {
      skipped++;
      continue;
    }

    const staleness = classifyStaleness(entry, thresholds);
    if (!staleness) {
      evaluated++;
      continue;
    }

    // Rung 1: first escalation for this PR in this bin.
    const rung1Key = escalationKey(entry.owner, entry.repo, entry.prNumber, staleness.bin, 1);
    const rung1Record = await loadEscalationRecord(ctx, rung1Key);

    if (!rung1Record) {
      await escalate(ctx, entry, staleness, 1, channel, isDryRun);
      escalated++;
      evaluated++;
      continue;
    }

    // Rung 2: fires after rung2Multiplier × the bin threshold with no resolution.
    const rung1AgeMs = Date.now() - new Date(rung1Record.firedAt).getTime();
    const thresholdMs = thresholdDays(staleness.bin, thresholds) * 86_400_000;
    const rung2Key = escalationKey(entry.owner, entry.repo, entry.prNumber, staleness.bin, 2);
    const rung2Record = await loadEscalationRecord(ctx, rung2Key);

    if (!rung2Record && rung1AgeMs >= thresholdMs * rung2Multiplier) {
      await escalate(ctx, entry, staleness, 2, channel, isDryRun, rung1Record.slackRef ?? undefined);
      escalated++;
    }

    // Rung 3 is a Chief DM — escalate() handles it for rung 3. Not time-gated
    // further here; rung 2 fires it on the first evaluation after rung 2 fires.
    // (Intentionally simple for V1 — revisit after measuring rung-2 traffic.)

    evaluated++;
  }

  ctx.log('info', 'pr-shepherd.evaluate.done', { evaluated, escalated, skipped, dryRun: isDryRun });
}

/**
 * Classify a ledger entry into a staleness bin, or return null if the PR is
 * not yet stale. Every result includes a human-readable reason string — an
 * alert that cannot say why it fired trains people to ignore it.
 */
export function classifyStaleness(
  entry: PrLedgerEntry,
  thresholds: StaleThresholds
): StalenessResult | null {
  const now = Date.now();
  const lastHumanMs = now - new Date(entry.lastHumanActivityAt).getTime();
  const openedMs = now - new Date(entry.openedAt).getTime();

  // ci-red: CI failing with no new human commit for N days.
  if (entry.ciStatus === 'failing') {
    const lastActivityMs = entry.lastBotActivityAt
      ? now - new Date(entry.lastBotActivityAt).getTime()
      : lastHumanMs;
    const days = lastActivityMs / 86_400_000;
    if (days >= thresholds.ciRedDays) {
      return {
        bin: 'ci-red',
        daysSinceRelevantActivity: Math.floor(days),
        reason: `CI has been failing for ${Math.floor(days)} day(s) with no new commit addressing it.`
      };
    }
  }

  // awaiting-author: changes requested with no author push for N days.
  if (entry.reviewState === 'changes-requested') {
    const days = lastHumanMs / 86_400_000;
    if (days >= thresholds.awaitingAuthorDays) {
      return {
        bin: 'awaiting-author',
        daysSinceRelevantActivity: Math.floor(days),
        reason: `Changes were requested ${Math.floor(days)} day(s) ago and the author has not pushed a new commit.`
      };
    }
  }

  // awaiting-review: opened or synchronized but no reviewer action for N days.
  if (entry.reviewState === 'awaiting-review') {
    const days = lastHumanMs / 86_400_000;
    if (days >= thresholds.awaitingReviewDays) {
      return {
        bin: 'awaiting-review',
        daysSinceRelevantActivity: Math.floor(days),
        reason: `No reviewer action for ${Math.floor(days)} day(s) since the last push.`
      };
    }
  }

  // abandoned: no human activity of any kind for N days — catches PRs that
  // slipped through every other bin (e.g. author never requested review,
  // CI is green, no activity at all).
  if (lastHumanMs / 86_400_000 >= thresholds.abandonedDays) {
    return {
      bin: 'abandoned',
      daysSinceRelevantActivity: Math.floor(lastHumanMs / 86_400_000),
      reason: `No human activity for ${Math.floor(lastHumanMs / 86_400_000)} day(s).`
    };
  }

  // Open for >30 days: flag for abandoned check regardless of other state.
  if (openedMs / 86_400_000 >= 30 && entry.reviewState !== 'approved') {
    return {
      bin: 'abandoned',
      daysSinceRelevantActivity: Math.floor(openedMs / 86_400_000),
      reason: `PR has been open for ${Math.floor(openedMs / 86_400_000)} day(s) without merging or closing.`
    };
  }

  return null;
}

// ── Escalation ───────────────────────────────────────────────────────────────

/**
 * Fire one rung of the escalation ladder for a stale PR.
 *
 * In DRY_RUN mode: logs what would be posted, writes no Slack message,
 * records no escalation entry. The log is observable and proves the logic
 * without touching Slack.
 *
 * Rung 1: Slack header post (one per PR per bin).
 * Rung 2: Slack thread reply via replyTo (NOT threadTs — see 2026-08-07 defect
 *         where threadTs caused every reply to post top-level instead of threading).
 * Rung 3: DM to Chief via relay (future: via ctx.relay.dm('chief', ...)).
 */
export async function escalate(
  ctx: WorkforceCtx,
  entry: PrLedgerEntry,
  staleness: StalenessResult,
  rung: 1 | 2 | 3,
  channel: string | null | undefined,
  dryRun: boolean,
  parentRef?: string
): Promise<void> {
  const header = formatEscalationHeader(entry, staleness, rung);
  const body = formatEscalationBody(entry, staleness, rung);
  const key = escalationKey(entry.owner, entry.repo, entry.prNumber, staleness.bin, rung);

  if (dryRun || !channel) {
    // DRY_RUN: log every alert that would fire. Proves the logic without Slack.
    ctx.log('info', 'pr-shepherd.escalate.dry-run', {
      key,
      rung,
      bin: staleness.bin,
      header,
      body,
      dryRun,
      channelConfigured: !!channel
    });
    return;
  }

  // Rung 3: relay DM to Chief (no Slack post).
  if (rung === 3) {
    ctx.log('warn', 'pr-shepherd.escalate.rung3', {
      key,
      entry: `${entry.owner}/${entry.repo}#${entry.prNumber}`,
      reason: staleness.reason
    });
    // TODO: ctx.relay.dm('chief', `BLOCKED ON CHIEF: ${header}\n${body}`) once relay DM API is available.
    await saveEscalationRecord(ctx, key, { firedAt: new Date().toISOString(), slackTs: null, slackRef: null });
    return;
  }

  const client = slackClient({ writebackTimeoutMs: 45_000 });

  // Rung 2: thread reply under rung-1 ref.
  if (rung === 2 && parentRef) {
    const reply = await client.post(channel, `${header}\n${body}`, { replyTo: parentRef });
    if (!reply.ts) throw new Error(`pr-shepherd: Slack rung-2 reply to ${channel} got no writeback receipt (silent drop)`);
    ctx.log('info', 'pr-shepherd.escalate.rung2.posted', { key, ts: reply.ts });
    await saveEscalationRecord(ctx, key, { firedAt: new Date().toISOString(), slackTs: reply.ts, slackRef: reply.ref ?? null });
    return;
  }

  // Rung 1: top-level header post.
  const post = await client.post(channel, header);
  if (!post.ts) throw new Error(`pr-shepherd: Slack rung-1 post to ${channel} got no writeback receipt (silent drop)`);
  ctx.log('info', 'pr-shepherd.escalate.rung1.posted', { key, ts: post.ts });

  // Thread the body under the header using replyTo.
  // replyTo uses the cloud's server-side ordered dispatch — no parent-receipt
  // round-trip needed, and thread_ts is set server-side.
  const thread = await client.post(channel, body, { replyTo: post.ref });
  if (!thread.ts) {
    // Header landed — keep the escalation record (prevents a duplicate header
    // on retry) and log loudly instead of rethrowing.
    ctx.log('error', 'pr-shepherd.escalate.rung1.thread-incomplete', { key, headerTs: post.ts });
  }

  await saveEscalationRecord(ctx, key, { firedAt: new Date().toISOString(), slackTs: post.ts, slackRef: post.ref ?? null });
}

// ── Inbox Q&A (relay DM path) ─────────────────────────────────────────────────

/**
 * Resolve the sender of an inbound relay DM so we can reply back to them
 * directly rather than posting to a fixed Slack channel.
 *
 * The cloud envelope-builder normalises the relaycast `from` to
 * `event.summary.actor`. We probe that first, then the full expansion's
 * `actor`/`from` fields as fallback. Pattern lifted from hn-monitor's
 * resolveRelaySender, verified against the live relay.
 */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
async function resolveRelaySender(
  event: AgentEvent,
  expandedFull: unknown
): Promise<string | undefined> {
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

/**
 * Answer a relay DM about PR state, grounded in the ledger. Never invents data.
 *
 * Reply path (in priority order):
 * 1. ctx.relay.dm(sender) — replies directly in the terminal or agent DM thread.
 *    This is the right path for `workforce agent pr-shepherd` local runs and for
 *    agent-to-agent queries from chief/trajectory-lead.
 * 2. SLACK_CHANNEL fallback — if the sender can't be resolved, post to the
 *    configured Slack channel so the answer doesn't vanish silently.
 * 3. Log-only — if neither is available (dry-run, no channel), log the answer.
 */
export async function handleInboxMessage(
  ctx: WorkforceCtx,
  event: AgentEvent
): Promise<void> {
  const payload = await event.expand('full').catch(() => undefined);
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const nested = (data.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>;
  const question = typeof data.text === 'string' ? data.text
    : typeof nested.text === 'string' ? nested.text : '';

  if (!question.trim()) {
    ctx.log('info', 'pr-shepherd.inbox.no-text');
    return;
  }

  const entries = await loadAllLedgerEntries(ctx);
  const openEntries = entries.filter(e => !e.closedAt);
  const context = openEntries.length
    ? openEntries.map(e => formatLedgerSummary(e)).join('\n')
    : 'The ledger is empty — no open PRs have been tracked yet. Try again after the next cron tick or after backfill completes.';

  const prompt = [
    'You are PR Shepherd. Answer the question using ONLY the ledger data below.',
    'Do not invent PR numbers, titles, or states not present in the ledger.',
    'If the ledger does not cover the question, say so explicitly.',
    '',
    '## Open PR ledger',
    context,
    '',
    '## Question',
    question
  ].join('\n');

  let answer: string;
  try {
    answer = await withTimeout(ctx.llm.complete(prompt, { maxTokens: 1024 }), 45_000, 'ctx.llm.complete');
  } catch (err) {
    ctx.log('warn', 'pr-shepherd.inbox.llm-fallback', { error: String(err) });
    answer = `I couldn't generate an answer right now. The ledger has ${openEntries.length} open PR(s). Here are the most stale:\n` +
      openEntries
        .slice(0, 10)
        .map(e => `- ${e.owner}/${e.repo}#${e.prNumber} — ${e.reviewState ?? 'unknown state'} — last human activity ${e.lastHumanActivityAt}`)
        .join('\n');
  }

  ctx.log('info', 'pr-shepherd.inbox.answered', { question: question.slice(0, 80), answerLength: answer.length });

  // Path 1: reply directly back to the relay sender (terminal / agent-to-agent).
  const sender = await resolveRelaySender(event, payload);
  if (sender && ctx.relay) {
    try {
      const res = await ctx.relay.dm(sender, answer);
      if (res.ok) {
        ctx.log('info', 'pr-shepherd.inbox.relay-replied', { to: sender });
        return;
      }
      ctx.log('warn', 'pr-shepherd.inbox.relay-reply-no-receipt', { to: sender });
    } catch (err) {
      ctx.log('warn', 'pr-shepherd.inbox.relay-reply-failed', { to: sender, error: String(err) });
    }
    // fall through to Slack fallback
  }

  // Path 2: Slack fallback — sender unresolved or relay DM failed.
  const channel = resolveInput(ctx, 'SLACK_CHANNEL');
  if (channel) {
    const result = await slackClient({ writebackTimeoutMs: 45_000 }).post(channel, answer);
    if (!result.ts) {
      ctx.log('warn', 'pr-shepherd.inbox.slack-no-receipt', { channel });
    } else {
      ctx.log('info', 'pr-shepherd.inbox.slack-posted', { ts: result.ts, channel });
    }
    return;
  }

  // Path 3: dry-run / no channel — answer is in the log.
  ctx.log('info', 'pr-shepherd.inbox.no-delivery', { reason: 'sender unresolved and no SLACK_CHANNEL configured' });
}

// ── Backfill ──────────────────────────────────────────────────────────────────

/**
 * One-time backfill: crawl all open, non-draft PRs in the org via GitHub REST
 * API and seed the ledger. This catches PRs over 60 days old that will never
 * emit a webhook event — precisely the ones this agent exists to catch.
 *
 * Chief ruling (2026-08-11): org-wide GitHub App (`repositorySelection: "all"`).
 * Design and implementation target org-wide access. The admin click-through
 * (Khaliq's org-admin action) is the only step that waits — this code is
 * correct once that installation is in place.
 *
 * Only runs once per deployment (guarded by a backfill-done flag in memory).
 * Does NOT overwrite existing ledger entries written by webhooks.
 *
 * At 137 repos with ~240 open PRs, this completes in a single invocation
 * within the 1800s harness timeout.
 */
async function backfillLedger(ctx: WorkforceCtx): Promise<void> {
  const org = resolveInput(ctx, 'ORG') ?? 'AgentWorkforce';
  ctx.log('info', 'pr-shepherd.backfill.start', { org });

  try {
    // Step 1: enumerate all repos in the org (paginated, 100 per page).
    // Uses the org-wide GitHub App token via the relay infrastructure.
    // After the org-admin click-through installs the App with
    // repositorySelection="all", this call covers all 137+ repos.
    const repos = await listOrgRepos(org);
    ctx.log('info', 'pr-shepherd.backfill.repos', { count: repos.length });

    // Step 2: for each repo, list open non-draft PRs and seed the ledger.
    // Does not overwrite entries already written by webhooks (checked by key).
    let seeded = 0;
    let skipped = 0;
    for (const repo of repos) {
      try {
        const prs = await listOpenPrs(org, repo);
        for (const pr of prs) {
          if (pr.draft) { skipped++; continue; }
          const key = ledgerKey(org, repo, pr.number);
          const existing = await loadLedgerEntry(ctx, key);
          if (existing) { skipped++; continue; }  // webhook already wrote it

          const now = new Date().toISOString();
          const pointer = extractTrajectoryPointer(pr.body);
          const entry: PrLedgerEntry = {
            owner: org,
            repo,
            prNumber: pr.number,
            title: pr.title,
            url: pr.html_url,
            author: pr.user?.login ?? 'unknown',
            workUnitId: pointer.workUnitId,
            workUnitSurface: pointer.workUnitSurface,
            sessionRef: pointer.sessionRef,
            isDraft: pr.draft ?? false,
            openedAt: pr.created_at,
            // Use updated_at as a proxy for last human activity at backfill
            // time. Webhooks will correct this as events arrive. This is an
            // honest approximation — better than openedAt for old PRs.
            lastHumanActivityAt: pr.updated_at,
            lastBotActivityAt: null,
            ciStatus: null,
            reviewState: pr.draft ? null : 'awaiting-review',
            closedAt: null,
            ledgerUpdatedAt: now
          };
          await saveLedgerEntry(ctx, key, entry);
          seeded++;
        }
      } catch (repoErr) {
        // Per-repo error: log and continue. A single inaccessible repo
        // must not abort the whole backfill.
        ctx.log('warn', 'pr-shepherd.backfill.repo-error', { repo, error: String(repoErr) });
      }
    }

    ctx.log('info', 'pr-shepherd.backfill.done', { seeded, skipped });
  } catch (err) {
    ctx.log('error', 'pr-shepherd.backfill.error', { error: String(err) });
    // Non-fatal: the ledger fills from webhook events going forward.
    // Log loudly so the operator knows the backfill needs a retry.
  }
}

/**
 * List all repositories in a GitHub org via REST API (paginated).
 * Requires the org-wide GitHub App installation (repositorySelection="all").
 * After Khaliq's org-admin click-through, the App token covers all repos.
 */
async function listOrgRepos(org: string): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/orgs/${org}/repos?type=all&per_page=100&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }
    );
    if (!res.ok) throw new Error(`listOrgRepos: GitHub API ${res.status} for ${org} page ${page}`);
    const data = (await res.json()) as Array<{ name: string }>;
    if (!data.length) break;
    names.push(...data.map(r => r.name));
    if (data.length < 100) break;
    page++;
  }
  return names;
}

interface GhPr {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
}

/**
 * List open PRs for a single repo (paginated). Non-draft only; drafts are
 * excluded from staleness evaluation.
 */
async function listOpenPrs(owner: string, repo: string): Promise<GhPr[]> {
  const prs: GhPr[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } }
    );
    if (res.status === 404) break;  // repo exists but no PRs or no access
    if (!res.ok) throw new Error(`listOpenPrs: GitHub API ${res.status} for ${owner}/${repo} page ${page}`);
    const data = (await res.json()) as GhPr[];
    if (!data.length) break;
    prs.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return prs;
}

// ── Memory helpers ────────────────────────────────────────────────────────────

function ledgerKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}/${prNumber}`;
}

function escalationKey(owner: string, repo: string, prNumber: number, bin: StalenesssBin, rung: number): string {
  return `${owner}/${repo}/${prNumber}/${bin}/${rung}`;
}

async function loadLedgerEntry(ctx: WorkforceCtx, key: string): Promise<PrLedgerEntry | null> {
  const items = await ctx.memory.recall(`pr ledger ${key}`, {
    tags: [LEDGER_TAG, `pr-shepherd:key:${key}`],
    limit: 1
  });
  if (!items.length) return null;
  try {
    return JSON.parse(items[0].content) as PrLedgerEntry;
  } catch {
    return null;
  }
}

async function saveLedgerEntry(ctx: WorkforceCtx, key: string, entry: PrLedgerEntry): Promise<void> {
  await ctx.memory.save(JSON.stringify(entry), {
    tags: [LEDGER_TAG, `pr-shepherd:key:${key}`],
    scope: 'workspace'
  });
}

async function loadAllLedgerEntries(ctx: WorkforceCtx): Promise<PrLedgerEntry[]> {
  const items = await ctx.memory.recall('pr shepherd ledger entries', {
    tags: [LEDGER_TAG],
    scope: 'workspace',
    limit: 500  // Cap: revisit if org grows past ~500 open PRs
  });
  const entries: PrLedgerEntry[] = [];
  for (const item of items) {
    try {
      entries.push(JSON.parse(item.content) as PrLedgerEntry);
    } catch {
      // Skip malformed records
    }
  }
  return entries;
}

async function loadEscalationRecord(ctx: WorkforceCtx, key: string): Promise<EscalationRecord | null> {
  const tag = `${ESCALATION_TAG_PREFIX}:${key}`;
  const items = await ctx.memory.recall(`escalation ${key}`, { tags: [tag], limit: 1 });
  if (!items.length) return null;
  try {
    return JSON.parse(items[0].content) as EscalationRecord;
  } catch {
    return null;
  }
}

async function saveEscalationRecord(ctx: WorkforceCtx, key: string, record: EscalationRecord): Promise<void> {
  const tag = `${ESCALATION_TAG_PREFIX}:${key}`;
  await ctx.memory.save(JSON.stringify(record), { tags: [tag], scope: 'workspace' });
}

async function isBackfillDone(ctx: WorkforceCtx): Promise<boolean> {
  const items = await ctx.memory.recall('pr-shepherd backfill done', { tags: [BACKFILL_DONE_TAG], limit: 1 });
  return items.length > 0;
}

async function markBackfillDone(ctx: WorkforceCtx): Promise<void> {
  await ctx.memory.save('done', { tags: [BACKFILL_DONE_TAG], scope: 'workspace' });
}

// ── Payload extractors ────────────────────────────────────────────────────────

interface PrRef {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  body: string | null;
}

/**
 * Trajectory pointer extracted from the PR body HTML comment written by
 * trajectory-lead when it links a PR to a work unit.
 *
 * Format (per pointer contract agreed 2026-08-11):
 *   <!-- trajectory: work_unit_id={id} work_unit_surface={surface} session_ref={uuid} -->
 *
 * Appended as the last line of the PR description. Missing fields are absent
 * (not empty string) — treat as null in the ledger. The value of work_unit_id
 * is opaque to pr-shepherd; pr-shepherd carries it, never interprets it.
 */
interface TrajectoryPointer {
  workUnitId: string | null;
  workUnitSurface: string | null;
  sessionRef: string | null;
}

/**
 * Parse the trajectory HTML comment from a PR body. Returns all-null when the
 * comment is absent or malformed — never throws, never invents values.
 */
export function extractTrajectoryPointer(body: string | null | undefined): TrajectoryPointer {
  const empty: TrajectoryPointer = { workUnitId: null, workUnitSurface: null, sessionRef: null };
  if (!body) return empty;

  const match = body.match(/<!--\s*trajectory:\s*(.*?)\s*-->/s);
  if (!match) return empty;

  const pairs = match[1];
  function readField(key: string): string | null {
    // Match key=value where value runs until the next key= or end of string.
    const re = new RegExp(`\\b${key}=([^\\s]+)`);
    const m = pairs.match(re);
    return m ? m[1] : null;
  }

  return {
    workUnitId: readField('work_unit_id'),
    workUnitSurface: readField('work_unit_surface'),
    sessionRef: readField('session_ref')
  };
}

function extractPr(eventType: string, d: Record<string, unknown>): PrRef | null {
  const prData = (
    d.pull_request ??
    (Array.isArray((d.check_run as Record<string, unknown> | undefined)?.pull_requests) &&
      ((d.check_run as Record<string, unknown>).pull_requests as unknown[])[0]) ??
    null
  ) as Record<string, unknown> | null;

  if (!prData) return null;

  const repo = d.repository as Record<string, unknown> | undefined;
  const owner = (repo?.owner as Record<string, unknown> | undefined)?.login as string | undefined;
  const repoName = repo?.name as string | undefined;

  if (!owner || !repoName) return null;

  return {
    owner,
    repo: repoName,
    number: prData.number as number,
    title: (prData.title as string | undefined) ?? '',
    url: (prData.html_url as string | undefined) ?? '',
    author: ((prData.user as Record<string, unknown> | undefined)?.login as string | undefined) ?? 'unknown',
    isDraft: (prData.draft as boolean | undefined) ?? false,
    createdAt: (prData.created_at as string | undefined) ?? new Date().toISOString(),
    body: (prData.body as string | undefined) ?? null
  };
}

function extractActorLogin(d: Record<string, unknown>): string | null {
  const sender = d.sender as Record<string, unknown> | undefined;
  return (sender?.login as string | undefined) ?? null;
}

function isKnownBot(login: string): boolean {
  return BOT_LOGIN_PATTERNS.some(p => p.test(login));
}

// ── Formatting ────────────────────────────────────────────────────────────────

const BIN_EMOJI: Record<StalenesssBin, string> = {
  'awaiting-review': ':eyes:',
  'awaiting-author': ':writing_hand:',
  'ci-red': ':red_circle:',
  'abandoned': ':zzz:'
};

function formatEscalationHeader(entry: PrLedgerEntry, staleness: StalenessResult, rung: number): string {
  const emoji = BIN_EMOJI[staleness.bin];
  const rungLabel = rung === 1 ? '' : rung === 2 ? ' *(escalation)*' : ' *(final escalation → Chief)*';
  return `${emoji} *Stale PR — ${staleness.bin}*${rungLabel}: <${entry.url}|${entry.owner}/${entry.repo}#${entry.prNumber}> — ${entry.title}`;
}

function formatEscalationBody(entry: PrLedgerEntry, staleness: StalenessResult, rung: number): string {
  const lines = [
    `*Why:* ${staleness.reason}`,
    `*Author:* @${entry.author}`,
    `*Opened:* ${entry.openedAt.slice(0, 10)}`,
    `*Last human activity:* ${entry.lastHumanActivityAt.slice(0, 10)}`
  ];
  // work_unit_id is scoped by work_unit_surface (Chief ruling 2026-08-11).
  // Display as "{surface}:{id}" — never assume Linear.
  if (entry.workUnitId) {
    const ref = entry.workUnitSurface ? `${entry.workUnitSurface}:${entry.workUnitId}` : entry.workUnitId;
    lines.push(`*Work unit:* ${ref}`);
  }
  if (entry.sessionRef) lines.push(`*Session:* \`${entry.sessionRef}\` — run \`ai-hist session ${entry.sessionRef}\` for full context`);
  if (rung === 3) lines.push(`*Action needed:* Chief ruling required — this PR has received two escalations with no resolution.`);
  return lines.join('\n');
}

function formatLedgerSummary(entry: PrLedgerEntry): string {
  return [
    `## ${entry.owner}/${entry.repo}#${entry.prNumber} — ${entry.title}`,
    `  URL: ${entry.url}`,
    `  Author: ${entry.author}`,
    `  State: ${entry.reviewState ?? 'unknown'}`,
    `  CI: ${entry.ciStatus ?? 'unknown'}`,
    `  Opened: ${entry.openedAt.slice(0, 10)}`,
    `  Last human activity: ${entry.lastHumanActivityAt.slice(0, 10)}`,
    entry.workUnitId ? `  Work unit: ${entry.workUnitSurface ? `${entry.workUnitSurface}:${entry.workUnitId}` : entry.workUnitId}` : '',
    entry.sessionRef ? `  Session ref: ${entry.sessionRef}` : ''
  ].filter(Boolean).join('\n');
}

// ── Threshold helpers ─────────────────────────────────────────────────────────

interface StaleThresholds {
  awaitingReviewDays: number;
  awaitingAuthorDays: number;
  ciRedDays: number;
  abandonedDays: number;
}

function resolveThresholds(ctx: WorkforceCtx): StaleThresholds {
  return {
    awaitingReviewDays: Number(resolveInput(ctx, 'STALE_AWAITING_REVIEW_DAYS') ?? '3'),
    awaitingAuthorDays: Number(resolveInput(ctx, 'STALE_AWAITING_AUTHOR_DAYS') ?? '2'),
    ciRedDays: Number(resolveInput(ctx, 'STALE_CI_RED_DAYS') ?? '1'),
    abandonedDays: Number(resolveInput(ctx, 'STALE_ABANDONED_DAYS') ?? '14')
  };
}

function thresholdDays(bin: StalenesssBin, t: StaleThresholds): number {
  switch (bin) {
    case 'awaiting-review': return t.awaitingReviewDays;
    case 'awaiting-author': return t.awaitingAuthorDays;
    case 'ci-red': return t.ciRedDays;
    case 'abandoned': return t.abandonedDays;
  }
}

// ── Generic helpers ───────────────────────────────────────────────────────────

function resolveInput(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && String(v).trim() ? String(v).trim() : undefined;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
