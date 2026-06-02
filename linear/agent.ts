/**
 * linear-chat-lead handler.
 *
 * Owns Linear Agent Session chat without booting a coding sandbox. It responds
 * via Linear agent activities, keeps thread memory by session id, and delegates
 * implementation requests to a workflow that provisions the coding box.
 */
import {
  defineAgent,
  unwrapResourceRecord,
  type WorkforceCtx,
  type WorkforceProviderEvent,
} from '@agentworkforce/runtime';
import { linearClient } from '@relayfile/relay-helpers';
import { LINEAR_CREATE_PR_SCRIPT } from './create-pr.script.js';

const IMPLEMENT_WORKFLOW_NAME = 'linear-chat-lead';
const IMPLEMENT_WORKFLOW_PATH = `workflows/${IMPLEMENT_WORKFLOW_NAME}.ts`;
const CREATE_PR_SCRIPT_PATH = `/tmp/${IMPLEMENT_WORKFLOW_NAME}-create-pr.cjs`;
const CREATE_PR_ARGS_PATH = `/tmp/${IMPLEMENT_WORKFLOW_NAME}-open-pr.args.json`;
const MEMORY_TAG = 'linear-agent-session';

interface LinearIssue {
  id?: string;
  identifier?: string;
  title: string;
  description: string | null;
  url?: string;
  [key: string]: unknown;
}

interface LinearClientLike {
  getIssue<T>(issueId: string): Promise<T>;
  comment(issueId: string, body: string): Promise<unknown>;
  agentActivity(
    sessionId: string,
    activity: { type: 'thought' | 'response' | 'elicitation' | 'action' | 'error'; body: string },
  ): Promise<unknown>;
  respond(sessionId: string, body: string): Promise<unknown>;
  acknowledge(sessionId: string): Promise<unknown>;
}

interface ChatIntent {
  intent: 'chat' | 'implement';
  reply: string;
}

interface LinearEventContext {
  record: Record<string, unknown>;
  issueId?: string;
  sessionId?: string;
  body: string;
  fallbackComment: boolean;
}

export default defineAgent({
  triggers: {
    linear: [
      {
        on: 'AgentSessionEvent.created',
        paths: ['/linear/agent-sessions/**', '/linear/comments/**'],
      },
      {
        on: 'AgentSessionEvent.prompted',
        paths: ['/linear/agent-sessions/**', '/linear/comments/**'],
      },
      {
        on: 'AppUserNotification.issueCommentMention',
        paths: ['/linear/app-user-notifications/**', '/linear/comments/**'],
      },
      { on: 'issue.create', paths: ['/linear/issues/**'], match: 'agentrelay' },
    ],
  },
  handler: async (ctx, event) => {
    await handleLinearEvent(ctx, event, linearClient());
  },
});

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
    hasSessionId: Boolean(readSessionId(event.payload)),
  });

  if (event.source !== 'linear') {
    logSkip(ctx, event, 'non-linear event source');
    return;
  }

  if (isOwnEvent(ctx, event)) {
    logSkip(ctx, event, 'own activity');
    return;
  }

  const eventContext = linearEventContext(event);
  if (!eventContext.issueId) {
    logSkip(ctx, event, 'missing issue id');
    return;
  }

  if (eventContext.fallbackComment) {
    const mention = commentMentionsAgent(ctx, event.payload);
    if (!mention.matched) {
      logSkip(ctx, event, mention.reason, mention.attrs);
      return;
    }
  }

  const issue = await linear.getIssue<LinearIssue>(eventContext.issueId);
  if (eventContext.sessionId) {
    await postThought(linear, eventContext.sessionId);
  }

  const history = eventContext.sessionId
    ? await recallSessionThread(ctx, eventContext.sessionId)
    : [];
  const intent = await classifyIntent(ctx, event, eventContext, issue, history);

  if (intent.intent === 'implement') {
    const start = intent.reply || 'I will start an implementation workflow and post the PR here when it is ready.';
    await replyToLinear(linear, eventContext, start);
    await rememberTurn(ctx, eventContext, 'assistant', start);

    const prUrl = await delegateImplementation(ctx, issue, eventContext);
    const done = prUrl
      ? `Implementation is complete: ${prUrl}`
      : 'The implementation workflow finished, but I could not find a PR URL in its output. Check the workflow logs for details.';
    await replyToLinear(linear, eventContext, done);
    await rememberTurn(ctx, eventContext, 'assistant', done);
    return;
  }

  await replyToLinear(linear, eventContext, intent.reply);
  await rememberTurn(ctx, eventContext, 'user', eventContext.body);
  await rememberTurn(ctx, eventContext, 'assistant', intent.reply);
}

function linearEventContext(event: WorkforceProviderEvent): LinearEventContext {
  const record = linearRecordPayload(event.payload) as Record<string, unknown>;
  return {
    record,
    issueId: readIssueId(event.payload, event.type),
    sessionId: readSessionId(event.payload),
    body: readPromptBody(event.payload),
    fallbackComment: event.type === 'AppUserNotification.issueCommentMention' || event.type === 'comment.create',
  };
}

async function postThought(linear: LinearClientLike, sessionId: string): Promise<void> {
  try {
    await linear.agentActivity(sessionId, { type: 'thought', body: 'Reading the thread and preparing a response.' });
  } catch {
    await linear.acknowledge(sessionId);
  }
}

async function replyToLinear(
  linear: LinearClientLike,
  eventContext: LinearEventContext,
  body: string,
): Promise<void> {
  if (eventContext.sessionId) {
    await linear.respond(eventContext.sessionId, body);
    return;
  }
  if (!eventContext.issueId) {
    throw new Error('Cannot reply without a Linear issue id');
  }
  await linear.comment(eventContext.issueId, body);
}

async function classifyIntent(
  ctx: WorkforceCtx,
  event: WorkforceProviderEvent,
  eventContext: LinearEventContext,
  issue: LinearIssue,
  history: string[],
): Promise<ChatIntent> {
  const body = eventContext.body || '(no explicit prompt body)';
  const response = await ctx.llm.complete([
    'You are the Linear Agent Relay chat lead.',
    'Classify the user intent and draft one concise Linear reply.',
    'Return only JSON with shape {"intent":"chat"|"implement","reply":"..."}',
    'Use intent "implement" only when the user asks you to change code, fix an issue, implement a task, or open a PR.',
    'For issue.create labelled agentrelay, prefer "implement" unless the issue clearly asks only for discussion.',
    '',
    `Event type: ${event.type}`,
    `Issue: ${issue.identifier ? `${issue.identifier} ` : ''}${issue.title}`,
    `Issue URL: ${issue.url ?? '(unknown)'}`,
    `Issue description:\n${issue.description ?? ''}`,
    history.length ? `Prior thread memory:\n${history.join('\n\n')}` : 'Prior thread memory: none',
    `User prompt:\n${body}`,
  ].join('\n'), { maxTokens: 700 });
  return parseChatIntent(response, event.type, body);
}

function parseChatIntent(response: string, eventType: string, body: string): ChatIntent {
  const jsonText = response.match(/\{[\s\S]*\}/)?.[0] ?? response;
  try {
    const parsed = JSON.parse(jsonText) as Partial<ChatIntent>;
    const intent = parsed.intent === 'implement' || parsed.intent === 'chat'
      ? parsed.intent
      : inferIntent(eventType, body);
    const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
      ? parsed.reply.trim()
      : defaultReply(intent);
    return { intent, reply };
  } catch {
    const intent = inferIntent(eventType, body);
    return {
      intent,
      reply: response.trim() || defaultReply(intent),
    };
  }
}

function inferIntent(eventType: string, body: string): ChatIntent['intent'] {
  if (eventType === 'issue.create') return 'implement';
  return /\b(implement|fix|ship|code|open\s+(?:a\s+)?pr|pull request)\b/iu.test(body)
    ? 'implement'
    : 'chat';
}

function defaultReply(intent: ChatIntent['intent']): string {
  return intent === 'implement'
    ? 'I will start an implementation workflow and post the PR here when it is ready.'
    : 'I am here and ready to help with this Linear issue.';
}

async function delegateImplementation(
  ctx: WorkforceCtx,
  issue: LinearIssue,
  eventContext: LinearEventContext,
): Promise<string | undefined> {
  const repo = parseRepo(issue) ?? 'AgentWorkforce/cloud';
  const workflowArgs = workflowInputs({
    issue,
    prompt: eventContext.body,
    repo,
  });
  await ctx.files.write(IMPLEMENT_WORKFLOW_PATH, workflowSource(workflowArgs));
  const run = await ctx.workflow.run(IMPLEMENT_WORKFLOW_NAME, {
    issueId: issue.id ?? eventContext.issueId,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueUrl: issue.url,
    repo,
  });
  const completion = await run.completion();
  return findPrUrl(String(completion.output ?? ''));
}

function workflowInputs(args: {
  issue: LinearIssue;
  prompt: string;
  repo: string;
}): {
  repo: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  issueTitle: string;
  issueBody: string;
  userPrompt: string;
  openPrArgs: {
    repoDir: string;
    owner: string;
    repo: string;
    branch: string;
    title: string;
    body: string;
  };
} {
  const [owner, name] = args.repo.split('/');
  const branch = `codex/linear-${safeName(args.issue.identifier ?? args.issue.id ?? 'issue')}`;
  const prTitle = `Resolve ${args.issue.identifier ? `${args.issue.identifier}: ` : ''}${args.issue.title}`;
  const prBody = [
    args.issue.url ? `Linear issue: ${args.issue.url}` : '',
    args.prompt ? `Prompt:\n${args.prompt}` : '',
    'Implemented by linear-chat-lead delegation.',
  ].filter(Boolean).join('\n\n');
  return {
    repo: args.repo,
    repoOwner: owner ?? 'AgentWorkforce',
    repoName: name ?? 'cloud',
    branch,
    issueTitle: args.issue.title,
    issueBody: args.issue.description ?? '',
    userPrompt: args.prompt,
    openPrArgs: {
      repoDir: './repo',
      owner: owner ?? 'AgentWorkforce',
      repo: name ?? 'cloud',
      branch,
      title: prTitle,
      body: prBody,
    },
  };
}

function workflowSource(args: ReturnType<typeof workflowInputs>): string {
  const createPrScriptB64 = Buffer.from(LINEAR_CREATE_PR_SCRIPT, 'utf8').toString('base64');
  const createPrArgsB64 = Buffer.from(JSON.stringify(args.openPrArgs, null, 2), 'utf8').toString('base64');
  return `
import { workflow } from '@agent-relay/sdk/workflows';

const REPO_DIR = './repo';
const REPO = ${JSON.stringify(args.repo)};
const BRANCH = ${JSON.stringify(args.branch)};
const ISSUE_TITLE = ${JSON.stringify(args.issueTitle)};
const ISSUE_BODY = ${JSON.stringify(args.issueBody)};
const USER_PROMPT = ${JSON.stringify(args.userPrompt)};
const CREATE_PR_SCRIPT_PATH = ${JSON.stringify(CREATE_PR_SCRIPT_PATH)};
const CREATE_PR_ARGS_PATH = ${JSON.stringify(CREATE_PR_ARGS_PATH)};
const CREATE_PR_SCRIPT_B64 = ${JSON.stringify(createPrScriptB64)};
const CREATE_PR_ARGS_B64 = ${JSON.stringify(createPrArgsB64)};

await workflow('linear-chat-lead')
  .description('Implement a Linear issue delegated by the chat lead')
  .pattern('dag')
  .timeout(4_500_000)
  .agent('impl', { cli: 'codex', preset: 'worker', role: 'Implement the Linear issue and prepare a PR.', retries: 1, maxTokens: 32000 })
  .step('clone', {
    type: 'deterministic',
    command: [
      'set -e',
      'rm -rf ' + REPO_DIR,
      'git clone --filter=blob:none https://github.com/' + REPO + '.git ' + REPO_DIR,
      'cd ' + REPO_DIR + ' && git checkout -B ' + BRANCH,
      'cd ' + REPO_DIR + ' && git config user.email linear-chat-lead@agentworkforce.local',
      'cd ' + REPO_DIR + ' && git config user.name linear-chat-lead',
      'cd ' + REPO_DIR + ' && git rev-parse HEAD > .linear-chat-base-sha'
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 900000,
  })
  .step('implement', {
    agent: 'impl',
    dependsOn: ['clone'],
    task: [
      'Work in ' + REPO_DIR + ' on branch ' + BRANCH + '.',
      'Linear issue: ' + ISSUE_TITLE,
      'User prompt: ' + USER_PROMPT,
      'Issue body:\\n' + ISSUE_BODY,
      'Make the code changes needed to fully satisfy the Linear request.',
      'Do not commit, push, or open a PR; the final deterministic step handles that.'
    ].join('\\n\\n'),
    verification: { type: 'exit_code' },
    timeoutMs: 1_800_000,
    retries: 1,
  })
  .step('open-pr', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: [
      'set -e',
      'printf %s ' + CREATE_PR_SCRIPT_B64 + ' | base64 -d > ' + CREATE_PR_SCRIPT_PATH,
      'printf %s ' + CREATE_PR_ARGS_B64 + ' | base64 -d > ' + CREATE_PR_ARGS_PATH,
      'node ' + CREATE_PR_SCRIPT_PATH + ' ' + CREATE_PR_ARGS_PATH
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 300000,
  })
  .run();
`;
}

async function recallSessionThread(ctx: WorkforceCtx, sessionId: string): Promise<string[]> {
  const items = await ctx.memory.recall(`Linear agent session ${sessionId}`, {
    scope: 'workspace',
    tags: [MEMORY_TAG, sessionId],
    limit: 8,
  });
  return items.map((item) => item.content);
}

async function rememberTurn(
  ctx: WorkforceCtx,
  eventContext: LinearEventContext,
  role: 'user' | 'assistant',
  body: string,
): Promise<void> {
  if (!eventContext.sessionId || !body.trim()) return;
  await ctx.memory.save(`${role}: ${body}`, {
    scope: 'workspace',
    tags: [MEMORY_TAG, eventContext.sessionId],
  });
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
    agentSession?: { issue?: { id?: string; identifier?: string } };
    issue?: { id?: string; identifier?: string };
    notification?: { issue?: { id?: string; identifier?: string } };
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
    rec?.agentSession?.issue?.id ??
    rec?.agentSession?.issue?.identifier ??
    rec?.issue?.id ??
    rec?.issue?.identifier ??
    rec?.notification?.issue?.id ??
    rec?.notification?.issue?.identifier ??
    rec?.issueId ??
    rec?.issue_id ??
    rec?.issueIdentifier ??
    rec?.issue_identifier ??
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

function readSessionId(payload: unknown): string | undefined {
  const rec = linearRecordPayload(payload) as {
    agentSessionId?: string;
    agent_session_id?: string;
    agentSession?: { id?: string };
    agentActivity?: { agentSessionId?: string; agent_session_id?: string };
  } | null;
  return (
    rec?.agentSession?.id ??
    rec?.agentSessionId ??
    rec?.agent_session_id ??
    rec?.agentActivity?.agentSessionId ??
    rec?.agentActivity?.agent_session_id
  );
}

function readPromptBody(payload: unknown): string {
  const rec = linearRecordPayload(payload) as {
    body?: string;
    promptContext?: string;
    agentActivity?: { body?: string; content?: { body?: string } };
    notification?: { comment?: { body?: string } };
    comment?: { body?: string };
  } | null;
  return (
    rec?.agentActivity?.body ??
    rec?.agentActivity?.content?.body ??
    rec?.promptContext ??
    rec?.notification?.comment?.body ??
    rec?.comment?.body ??
    commentBody(payload)
  );
}

function commentBody(payload: unknown): string {
  const rec = linearRecordPayload(payload) as {
    body?: string;
    notification?: { comment?: { body?: string } };
    comment?: { body?: string };
  } | null;
  const p = payload as {
    body?: string;
    data?: { body?: string; comment?: { body?: string } };
    comment?: { body?: string };
  } | null;
  return (
    rec?.body ??
    rec?.notification?.comment?.body ??
    rec?.comment?.body ??
    p?.data?.body ??
    p?.data?.comment?.body ??
    p?.comment?.body ??
    p?.body ??
    ''
  );
}

function isOwnEvent(ctx: WorkforceCtx, event: WorkforceProviderEvent): boolean {
  if (event.type === 'comment.create') {
    return isOwnComment(ctx, event.payload);
  }
  const rec = linearRecordPayload(event.payload) as { agentActivity?: unknown } | null;
  return commentAuthorMatchesAgent(ctx, rec?.agentActivity ?? event.payload);
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
  return unwrapResourceRecord(payload);
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

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._/-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'issue';
}
