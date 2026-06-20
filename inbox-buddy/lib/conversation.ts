/**
 * Conversational continuity for inbox-buddy.
 *
 * `ctx.llm.complete()` is stateless per call, and the stock chat pattern
 * (neon/hn/daytona/gcp) reloads a full snapshot each turn with no memory of the
 * conversation — so the agent forgets every prior turn.
 *
 * THE FIX (here): persist the conversation transcript ourselves in `ctx.memory`
 * (workspace scope), keyed by the Slack conversation (see
 * `conversationKeyForSlack` in lib/slack.ts), and replay it into each prompt.
 * This gives true multi-turn continuity over `ctx.llm.complete`, independent of
 * any harness session-resume.
 */
import type { WorkforceCtx } from '@agentworkforce/runtime';

export interface ConvTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

/** Keep prompts bounded: replay at most the last N turns. */
export const MAX_TURNS = 16;

/** Memory tag for a conversation's transcript record. */
export function convTag(key: string): string {
  return `inbox-buddy:conv:${key}`;
}

/**
 * Load the transcript for a conversation, oldest-first. We store the whole
 * transcript as a single evolving JSON blob (same pattern as hn-monitor's
 * seen-set): `recall(..., { limit: 1 })` returns the most recent save.
 */
export async function loadConversation(ctx: WorkforceCtx, key: string): Promise<ConvTurn[]> {
  try {
    const [item] = await ctx.memory.recall(`conversation ${key}`, {
      tags: [convTag(key)],
      scope: 'workspace',
      limit: 1
    });
    if (!item) return [];
    const parsed = JSON.parse(item.content) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is ConvTurn =>
        !!t && typeof t === 'object' &&
        ((t as ConvTurn).role === 'user' || (t as ConvTurn).role === 'assistant') &&
        typeof (t as ConvTurn).text === 'string'
    );
  } catch {
    return [];
  }
}

/** Persist the transcript (trimmed to the last MAX_TURNS) for a conversation. */
export async function saveConversation(ctx: WorkforceCtx, key: string, turns: ConvTurn[]): Promise<void> {
  await ctx.memory.save(JSON.stringify(turns.slice(-MAX_TURNS)), {
    tags: [convTag(key)],
    scope: 'workspace'
  });
}

/**
 * Append the new user turn + the assistant reply and persist. Returns the
 * updated transcript. `now` is injectable for deterministic tests.
 */
export async function recordTurn(
  ctx: WorkforceCtx,
  key: string,
  prior: ConvTurn[],
  userText: string,
  assistantText: string,
  now: () => Date = () => new Date()
): Promise<ConvTurn[]> {
  const at = now().toISOString();
  const updated: ConvTurn[] = [
    ...prior,
    { role: 'user', text: userText, at },
    { role: 'assistant', text: assistantText, at }
  ];
  await saveConversation(ctx, key, updated);
  return updated;
}

/**
 * Render prior turns as a readable transcript for the prompt. Empty string when
 * there is no history (first turn), so the caller can omit the section.
 */
export function renderTranscript(turns: ConvTurn[]): string {
  if (turns.length === 0) return '';
  return turns
    .slice(-MAX_TURNS)
    .map((t) => `${t.role === 'user' ? 'User' : 'You (inbox-buddy)'}: ${t.text}`)
    .join('\n');
}
