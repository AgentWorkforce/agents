/**
 * Gmail VFS access for inbox-buddy.
 *
 * IMPORTANT — the materialized path is `/google-mail/threads/<threadId>.json`,
 * NOT `/gmail/...`. The `/gmail` root in `relayfile-adapters/packages/gmail`
 * is a legacy adapter that cloud does not use. The authoritative materializer
 * is cloud's `record-writer.ts` (`computeGoogleMailRecordPath`,
 * `googleMailThreadMainIndexPath`), which writes Google Mail threads under the
 * canonical provider id `google-mail`:
 *
 *   /google-mail/threads/<threadId>.json   one thread (headers + per-message snippet)
 *   /google-mail/threads/_index.json       digest index (we skip it when listing)
 *   /google-mail/LAYOUT.md                 mount self-description
 *
 * Scoping a persona to `/gmail/**` would silently mount an empty tree (the
 * integration-scope trap). We scope `/google-mail/**` and read it here with the
 * runtime VFS helpers (no Gmail token — auth lives in the Nango connection).
 *
 * The thread record shape mirrors the Nango `GoogleMailThread` model
 * (`cloud/nango-integrations/google-mail-relay/syncs/gmail-record-shapes.ts`):
 * the `fetch-threads` sync stores per-message headers + `snippet` (NOT full
 * bodies — those live under `/google-mail/messages`). Headers + snippets are
 * enough to answer questions about recent threads.
 */
import {
  listJsonFiles,
  type IntegrationClientOptions
} from '@agentworkforce/runtime';

export const GOOGLE_MAIL_PROVIDER = 'google-mail';
export const THREADS_DIR = '/google-mail/threads';

/** One message inside a thread record (compacted, headers + snippet). */
export interface GmailThreadMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
}

/** A materialized Gmail thread record. */
export interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messageIds?: string[];
  messageCount?: number;
  messages?: GmailThreadMessage[];
}

/** A thread record must have an id and a messages/messageIds array. */
export function isThreadRecord(value: unknown): value is GmailThread {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && (Array.isArray(v.messages) || Array.isArray(v.messageIds));
}

/**
 * Latest activity time (ms) for a thread — the max `internalDate` over its
 * messages. `internalDate` is epoch-ms as a string. Threads with no parseable
 * date sort to the bottom (returns 0).
 */
export function threadLatestMs(thread: GmailThread): number {
  const dates = (thread.messages ?? [])
    .map((m) => Number(m.internalDate))
    .filter((n) => Number.isFinite(n) && n > 0);
  return dates.length > 0 ? Math.max(...dates) : 0;
}

/** Newest-first by latest message activity. Pure; does not mutate input. */
export function sortThreadsByRecencyDesc(threads: GmailThread[]): GmailThread[] {
  return [...threads].sort((a, b) => threadLatestMs(b) - threadLatestMs(a));
}

/**
 * Read recent threads from the mount, newest first. Best-effort: an unsynced /
 * missing mount returns [] rather than throwing, so the chat path can still
 * reply ("I don't see any email yet") instead of erroring. `_index.json` and
 * any non-thread files are filtered out.
 */
export async function loadRecentThreads(
  client: IntegrationClientOptions,
  limit = 200
): Promise<GmailThread[]> {
  let entries: Array<{ path: string; value: GmailThread }>;
  try {
    entries = await listJsonFiles<GmailThread>(client, GOOGLE_MAIL_PROVIDER, 'listThreads', THREADS_DIR);
  } catch {
    return [];
  }
  const threads = entries
    .filter((e) => !e.path.endsWith('/_index.json'))
    .map((e) => e.value)
    .filter(isThreadRecord);
  return sortThreadsByRecencyDesc(threads).slice(0, limit);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'about', 'with', 'that', 'this', 'from', 'to', 'of', 'on', 'in',
  'for', 'and', 'or', 'my', 'me', 'i', 'what', 'whats', 'was', 'is', 'are', 'did',
  'do', 'does', 'thread', 'threads', 'email', 'emails', 'mail', 'message', 'messages',
  'tell', 'show', 'find', 'who', 'when', 'where', 'which', 'any', 'all', 'recent', 'latest'
]);

/** Lowercase alphanumeric tokens from a query, minus stopwords. */
export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Searchable haystack for a thread: every subject/from/to/snippet, lowercased. */
function threadHaystack(thread: GmailThread): string {
  const parts: string[] = [thread.snippet ?? ''];
  for (const m of thread.messages ?? []) {
    parts.push(m.subject ?? '', m.from ?? '', m.to ?? '', m.snippet ?? '');
  }
  return parts.join('  ').toLowerCase();
}

/**
 * Rank threads against a free-text reference ("that thread with Alice about the
 * export"). Returns only threads that match at least one token, best match
 * first, ties broken by recency. Empty when nothing matches — callers fall back
 * to the recent overview rather than guessing. Pure and deterministic.
 */
export function selectThreads(threads: GmailThread[], query: string, limit = 5): GmailThread[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const scored = threads
    .map((thread) => {
      const hay = threadHaystack(thread);
      let score = 0;
      for (const token of tokens) if (hay.includes(token)) score += 1;
      return { thread, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || threadLatestMs(b.thread) - threadLatestMs(a.thread));
  return scored.slice(0, limit).map((s) => s.thread);
}

function isoFromInternalMs(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/** One-line-per-thread overview for the prompt: subject, who, when, count, snippet. */
export function compactThreadOverview(thread: GmailThread): Record<string, unknown> {
  const messages = thread.messages ?? [];
  const first = messages[0];
  const last = messages[messages.length - 1] ?? first;
  return {
    id: thread.id,
    subject: first?.subject ?? last?.subject ?? '(no subject)',
    from: first?.from,
    latestFrom: last?.from,
    lastActivity: isoFromInternalMs(threadLatestMs(thread)) ?? last?.date,
    messageCount: thread.messageCount ?? messages.length,
    labels: [...new Set(messages.flatMap((m) => m.labelIds ?? []))],
    snippet: last?.snippet ?? thread.snippet
  };
}

/** Full per-message detail for a focused thread (the deep-dive view). */
export function expandThread(thread: GmailThread): Record<string, unknown> {
  return {
    id: thread.id,
    messageCount: thread.messageCount ?? (thread.messages ?? []).length,
    messages: (thread.messages ?? []).map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      date: m.date ?? isoFromInternalMs(Number(m.internalDate)),
      subject: m.subject,
      labels: m.labelIds,
      snippet: m.snippet
    }))
  };
}
