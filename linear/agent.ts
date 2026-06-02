/**
 * linear-implementer handler.
 *
 *   a Linear issue.create / comment.create event fires
 *     → fetch the issue
 *     → hand it to the coding agent to implement + open a PR
 *     → comment the PR link back on the Linear issue
 *
 * The repo is already in the sandbox: the cloud materializes the github
 * integration's repo into ctx.sandbox.cwd via relayfile, so there's no clone.
 */
import {
  defineAgent,
  type WorkforceCtx,
  type WorkforceProviderEvent
} from '@agentworkforce/runtime';
import { linearClient } from '@relayfile/relay-helpers';

interface LinearIssue {
  id?: string;
  identifier?: string;
  title: string;
  description: string | null;
  url?: string;
  [key: string]: unknown;
}

export default defineAgent({
  // Two Linear triggers — `on` autocompletes Linear's catalog events.
  triggers: {
    linear: [
      { on: 'issue.create', match: 'agentrelay' }, // new issues labelled "agentrelay"
      { on: 'comment.create' } // …or a comment that @-mentions the agent (handler enforces MENTION + skips its own replies)
    ]
  },
  handler: async (ctx, event) => {
    await handleLinearEvent(ctx, event, linearClient());
  }
});

interface LinearClientLike {
  getIssue<T>(issueId: string): Promise<T>;
  comment(issueId: string, body: string): Promise<unknown>;
}

export async function handleLinearEvent(
  ctx: WorkforceCtx,
  event: WorkforceProviderEvent,
  linear: LinearClientLike,
): Promise<void> {
  ctx.log?.('info', 'linear event', {
    eventId: event.id,
    type: event.type,
    payloadKeys: payloadKeys(event.payload),
    recordKeys: payloadKeys(linearRecordPayload(event.payload)),
    hasIssueId: Boolean(readIssueId(event.payload, event.type)),
  });

  if (event.source !== 'linear') {
    logSkip(ctx, event, 'non-linear event source');
    return;
  }

  // Keep the self-reply loop guard, but do not silently return.
  if (event.type === 'comment.create') {
    if (isOwnComment(ctx, event.payload)) {
      logSkip(ctx, event, 'own comment');
      return;
    }
    const mention = commentMentionsAgent(ctx, event.payload);
    if (!mention.matched) {
      logSkip(ctx, event, mention.reason, mention.attrs);
      return;
    }
  }

  const issueId = readIssueId(event.payload, event.type);
  if (!issueId) {
    logSkip(ctx, event, 'missing issue id');
    return;
  }
  const issue = await linear.getIssue<LinearIssue>(issueId);

  // The issue may name its own target repo (a github URL); if so, tell the agent
  // to work there — otherwise it uses the materialized repo.
  const repo = parseRepo(issue);

  const run = await ctx.harness.run({
    cwd: ctx.sandbox.cwd, // repo materialized by the cloud via relayfile — no clone, no gh/git
    prompt: [
      'Comprehensively implement this Linear issue — make every change needed to fully resolve it, not a partial fix.',
      repo ? `The target repository is \`${repo}\`.` : '',
      'Then open a GitHub pull request with your changes (the GitHub integration opens it; do not use git or the `gh` CLI). Put the PR URL on the last line.',
      '',
      `# ${issue.title}`,
      issue.description ?? ''
    ].filter(Boolean).join('\n')
  });

  const prUrl = findPrUrl(run.output);
  await linear.comment(
    issueId,
    prUrl
      ? `:rocket: Opened a PR: ${prUrl}`
      : "I worked on this but couldn't open a PR — check the run logs."
  );
}

/** The issue id for this event. For `comment.create`, `data.id` is the COMMENT
 *  id, so prefer issue-specific fields and only fall back to `data.id`
 *  (which is the issue id for `issue.create`). */
function readIssueId(payload: unknown, eventType?: string): string | undefined {
  const rec = linearRecordPayload(payload) as {
    body?: string;
    id?: string;
    issueId?: string;
    issue_id?: string;
    issueIdentifier?: string;
    issue_identifier?: string;
    issue?: { id?: string; identifier?: string };
  } | null;
  const p = payload as {
    data?: {
      id?: string;
      issueId?: string;
      issue_id?: string;
      issue?: { id?: string };
      comment?: { issueId?: string; issue_id?: string; issue?: { id?: string } };
    };
    comment?: { issueId?: string; issue_id?: string; issue?: { id?: string } };
    issueId?: string;
    issue_id?: string;
    issue?: { id?: string };
  } | null;
  return (
    rec?.issueId ??
    rec?.issue_id ??
    rec?.issueIdentifier ??
    rec?.issue_identifier ??
    rec?.issue?.id ??
    rec?.issue?.identifier ??
    p?.data?.issueId ??
    p?.data?.issue_id ??
    p?.data?.issue?.id ??
    p?.data?.comment?.issueId ??
    p?.data?.comment?.issue_id ??
    p?.data?.comment?.issue?.id ??
    p?.comment?.issueId ??
    p?.comment?.issue_id ??
    p?.comment?.issue?.id ??
    p?.issueId ??
    p?.issue_id ??
    p?.issue?.id ??
    (eventType === 'comment.create' ? undefined : p?.data?.id ?? rec?.id)
  );
}
function commentBody(payload: unknown): string {
  const rec = linearRecordPayload(payload) as { body?: string } | null;
  const p = payload as {
    body?: string;
    data?: { body?: string; comment?: { body?: string } };
    comment?: { body?: string };
  } | null;
  return rec?.body ?? p?.data?.body ?? p?.data?.comment?.body ?? p?.comment?.body ?? p?.body ?? '';
}
/** True if a comment event is the agent's own PR-link reply (loop guard). */
function isOwnComment(ctx: WorkforceCtx, payload: unknown): boolean {
  const body = commentBody(payload);
  if (!body.includes('Opened a PR') && !body.includes("couldn't open a PR")) return false;
  return commentAuthorMatchesAgent(ctx, payload);
}
interface MentionMatch {
  matched: boolean;
  reason: string;
  attrs?: Record<string, unknown>;
}

/** Only act on a comment that explicitly mentions this agent. */
function commentMentionsAgent(ctx: WorkforceCtx, payload: unknown): MentionMatch {
  const aliases = mentionAliases(ctx);
  const body = commentBody(payload);
  const structuredMentions = collectStructuredMentionTexts(payload);

  for (const mention of structuredMentions) {
    const alias = matchingAlias(mention, aliases);
    if (alias) {
      return { matched: true, reason: 'structured mention', attrs: { alias } };
    }
  }

  const bodyAlias = matchingBodyAlias(body, aliases);
  if (bodyAlias) {
    return { matched: true, reason: 'body mention', attrs: { alias: bodyAlias } };
  }

  return {
    matched: false,
    reason: 'comment did not mention agent',
    attrs: {
      aliasCount: aliases.length,
      structuredMentionCount: structuredMentions.length,
    },
  };
}
function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && v.trim() ? v : undefined;
}
function mentionAliases(ctx: WorkforceCtx): string[] {
  const configured = splitAliases(input(ctx, 'MENTION'));
  const inferred = [
    ctx.agent?.id,
    ctx.agentName,
    ctx.agent?.deployedName,
    ctx.persona?.id,
    'agentrelay',
    'agent relay',
  ];
  const aliases = new Set<string>();
  for (const value of [...configured, ...inferred]) {
    for (const alias of aliasVariants(value)) {
      aliases.add(alias);
    }
  }
  return [...aliases];
}
function splitAliases(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}
function aliasVariants(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const withoutAt = trimmed.replace(/^@+/u, '');
  const spaced = withoutAt.replace(/[-_]+/gu, ' ');
  return [trimmed, withoutAt, spaced, compactToken(trimmed), compactToken(withoutAt), compactToken(spaced)]
    .filter((entry, index, entries): entry is string => Boolean(entry) && entries.indexOf(entry) === index);
}
function matchingAlias(value: string, aliases: string[]): string | undefined {
  const normalized = compactToken(value);
  return aliases.find((alias) => compactToken(alias) === normalized);
}
function matchingBodyAlias(body: string, aliases: string[]): string | undefined {
  const explicitMentions = [
    ...body.matchAll(/@\[([^\]]+)\]/gu),
    ...body.matchAll(/@([A-Za-z0-9][A-Za-z0-9_.-]*)/gu),
    ...body.matchAll(/\[([^\]]+)\]\((?:linear|https?):\/\/[^)]*(?:user|users)[^)]*\)/giu),
    ...body.matchAll(/<@([^>]+)>/gu),
  ].map((match) => match[1] ?? '');
  for (const mention of explicitMentions) {
    const alias = matchingAlias(mention, aliases);
    if (alias) return alias;
  }
  return undefined;
}
function commentAuthorMatchesAgent(ctx: WorkforceCtx, payload: unknown): boolean {
  const aliases = mentionAliases(ctx);
  return commentAuthorTexts(payload).some((author) => Boolean(matchingAlias(author, aliases)));
}
function commentAuthorTexts(payload: unknown): string[] {
  const p = payload as {
    actor?: unknown;
    actorId?: string;
    actor_id?: string;
    author?: unknown;
    authorId?: string;
    author_id?: string;
    createdBy?: unknown;
    creator?: unknown;
    data?: {
      actor?: unknown;
      actorId?: string;
      actor_id?: string;
      author?: unknown;
      authorId?: string;
      author_id?: string;
      comment?: {
        actor?: unknown;
        actorId?: string;
        actor_id?: string;
        author?: unknown;
        authorId?: string;
        author_id?: string;
        createdBy?: unknown;
        creator?: unknown;
        user?: unknown;
        userId?: string;
        user_id?: string;
      };
      createdBy?: unknown;
      creator?: unknown;
      user?: unknown;
      userId?: string;
      user_id?: string;
    };
    user?: unknown;
    userId?: string;
    user_id?: string;
  } | null;
  const texts = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      texts.add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const field of ['id', 'userId', 'user_id', 'name', 'displayName', 'display_name', 'handle']) {
      const candidate = (value as Record<string, unknown>)[field];
      if (typeof candidate === 'string') texts.add(candidate);
    }
  };
  add(p?.data?.comment?.user);
  add(p?.data?.comment?.author);
  add(p?.data?.comment?.actor);
  add(p?.data?.comment?.creator);
  add(p?.data?.comment?.createdBy);
  add(p?.data?.comment?.userId);
  add(p?.data?.comment?.user_id);
  add(p?.data?.comment?.authorId);
  add(p?.data?.comment?.author_id);
  add(p?.data?.comment?.actorId);
  add(p?.data?.comment?.actor_id);
  add(p?.data?.user);
  add(p?.data?.author);
  add(p?.data?.actor);
  add(p?.data?.creator);
  add(p?.data?.createdBy);
  add(p?.data?.userId);
  add(p?.data?.user_id);
  add(p?.data?.authorId);
  add(p?.data?.author_id);
  add(p?.data?.actorId);
  add(p?.data?.actor_id);
  add(p?.user);
  add(p?.author);
  add(p?.actor);
  add(p?.creator);
  add(p?.createdBy);
  add(p?.userId);
  add(p?.user_id);
  add(p?.authorId);
  add(p?.author_id);
  add(p?.actorId);
  add(p?.actor_id);
  return [...texts];
}
function collectStructuredMentionTexts(value: unknown): string[] {
  const texts = new Set<string>();
  const seen = new WeakSet<object>();
  collectMentionTexts(value, false, texts, seen);
  return [...texts];
}
function collectMentionTexts(
  value: unknown,
  inMentionField: boolean,
  texts: Set<string>,
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    if (inMentionField) texts.add(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectMentionTexts(item, inMentionField, texts, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const mentionField = inMentionField || /mention/i.test(key);
    if (mentionField && typeof entry === 'object' && entry !== null) {
      for (const field of ['id', 'userId', 'user_id', 'name', 'displayName', 'display_name', 'handle']) {
        const candidate = (entry as Record<string, unknown>)[field];
        if (typeof candidate === 'string') texts.add(candidate);
      }
    }
    collectMentionTexts(entry, mentionField, texts, seen);
  }
}
function compactToken(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
}
function payloadKeys(payload: unknown): string[] {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];
}
function linearRecordPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const outer = payload as Record<string, unknown>;
  const resource = outer.resource && typeof outer.resource === 'object' && !Array.isArray(outer.resource)
    ? outer.resource as Record<string, unknown>
    : outer;
  return resource.payload && typeof resource.payload === 'object' && !Array.isArray(resource.payload)
    ? resource.payload
    : resource;
}
function logSkip(
  ctx: WorkforceCtx,
  event: WorkforceProviderEvent,
  reason: string,
  attrs: Record<string, unknown> = {},
): void {
  ctx.log?.('info', 'linear comment skipped', {
    eventId: event.id,
    type: event.type,
    reason,
    ...attrs,
  });
}
function findPrUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S*github\.com\/\S+\/pull\/\d+/g)?.pop();
}
/** A github repo named in the issue, e.g. `https://github.com/owner/repo`.
 *  Only matches explicit github URLs — a bare `owner/repo` is too ambiguous
 *  (it would catch phrases like "client/server"). */
function parseRepo(issue: { title: string; description: string | null }): string | undefined {
  const text = `${issue.title}\n${issue.description ?? ''}`;
  return text.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git|[)\s/]|$)/i)?.[1];
}
