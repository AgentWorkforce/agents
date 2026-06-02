import assert from 'node:assert/strict';
import test from 'node:test';

import linearAgent, { handleLinearEvent } from '../.test-build/linear/agent.js';
import { LINEAR_CREATE_PR_SCRIPT } from '../.test-build/linear/create-pr.script.js';

function ctx(overrides = {}) {
  const logs = [];
  const llmPrompts = [];
  const memorySaves = [];
  const workflowRuns = [];
  const fileWrites = [];
  const runtime = {
    logs,
    llmPrompts,
    memorySaves,
    workflowRuns,
    fileWrites,
    workspaceId: 'workspace-1',
    agentName: 'linear-chat-lead',
    agent: { id: 'agent-linear', deployedName: 'Agent Relay', spawnedByAgentId: null },
    deployment: { id: 'deployment-1', triggerKind: 'radio', parentDeploymentId: null },
    persona: {
      id: 'linear-chat-lead',
      inputs: {},
      inputSpecs: { MENTION: { env: 'MENTION', optional: true } },
    },
    llm: {
      complete: async (prompt) => {
        llmPrompts.push(prompt);
        return JSON.stringify({ intent: 'chat', reply: 'I can help with that.' });
      },
    },
    memory: {
      recall: async () => [{ content: 'user: earlier context' }],
      save: async (content, opts) => {
        memorySaves.push({ content, opts });
        return { id: `memory-${memorySaves.length}` };
      },
    },
    files: {
      write: async (path, contents) => fileWrites.push({ path, contents }),
      read: async () => '',
    },
    workflow: {
      run: async (name, args) => {
        workflowRuns.push({ name, args });
        return {
          runId: 'run-1',
          completion: async () => ({
            status: 'success',
            output: 'Opened https://github.com/AgentWorkforce/cloud/pull/123',
          }),
        };
      },
    },
    sandbox: { cwd: '/workspace', exec: async () => ({ output: '', exitCode: 0 }) },
    harness: { run: async () => { throw new Error('harness should not run'); } },
    log: (level, message, attrs) => logs.push({ level, message, attrs }),
    ...overrides,
  };
  return runtime;
}

function linearClient() {
  const comments = [];
  const activities = [];
  return {
    comments,
    activities,
    async getIssue(issueId) {
      return {
        id: issueId,
        identifier: 'AR-70',
        title: 'Fix the failing Linear implementer',
        description: 'The chat lead should answer and delegate implementation when asked.',
        url: 'https://linear.app/agentrelay/issue/AR-70',
      };
    },
    async comment(issueId, body) {
      comments.push({ issueId, body });
      return { id: `comment-${comments.length}`, url: 'https://linear.test/comment' };
    },
    async agentActivity(sessionId, activity) {
      activities.push({ sessionId, activity });
      return { id: `activity-${activities.length}`, url: 'https://linear.test/activity' };
    },
    async respond(sessionId, body) {
      activities.push({ sessionId, activity: { type: 'response', body } });
      return { id: `response-${activities.length}`, url: 'https://linear.test/activity' };
    },
    async acknowledge(sessionId) {
      activities.push({ sessionId, activity: { type: 'thought', body: 'Acknowledged.' } });
      return { id: `ack-${activities.length}`, url: 'https://linear.test/activity' };
    },
  };
}

function event(type, payload) {
  return {
    source: 'linear',
    id: `evt-${type}`,
    occurredAt: '2026-06-02T19:00:00.000Z',
    attempt: 1,
    workspaceId: 'workspace-1',
    type,
    payload,
  };
}

test('declares version-skew-tolerant Linear trigger path coverage', () => {
  assert.deepEqual(linearAgent.triggers.linear.slice(0, 3), [
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
  ]);
});

test('AgentSessionEvent.prompted sends thought then response and saves session memory', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event('AgentSessionEvent.prompted', {
    resource: {
      provider: 'linear',
      objectType: 'comment',
      payload: {
        type: 'AgentSessionEvent',
        action: 'prompted',
        agentSession: { id: 'session-1', issue: { id: 'issue-1', identifier: 'AR-70' } },
        agentActivity: { id: 'activity-1', body: 'What is the current plan?' },
      },
    },
  }), linear);

  assert.deepEqual(linear.activities.map((entry) => entry.activity.type), ['thought', 'response']);
  assert.equal(linear.activities[0]?.sessionId, 'session-1');
  assert.match(linear.activities[1]?.activity.body, /I can help/);
  assert.equal(runtime.llmPrompts.length, 1);
  assert.match(runtime.llmPrompts[0], /earlier context/);
  assert.equal(runtime.workflowRuns.length, 0);
  assert.ok(runtime.memorySaves.some((entry) => entry.content === 'user: What is the current plan?'));
  assert.ok(runtime.memorySaves.some((entry) => entry.content === 'assistant: I can help with that.'));
});

test('AgentSessionEvent implement request delegates to workflow and posts PR link', async () => {
  const runtime = ctx({
    llm: {
      complete: async () => JSON.stringify({
        intent: 'implement',
        reply: 'Starting an implementation workflow now.',
      }),
    },
  });
  const linear = linearClient();

  await handleLinearEvent(runtime, event('AgentSessionEvent.prompted', {
    resource: {
      provider: 'linear',
      objectType: 'comment',
      payload: {
        type: 'AgentSessionEvent',
        action: 'prompted',
        agentSession: { id: 'session-1', issue: { id: 'issue-1', identifier: 'AR-70' } },
        agentActivity: { id: 'activity-1', body: 'Please implement this.' },
      },
    },
  }), linear);

  assert.equal(runtime.workflowRuns.length, 1);
  assert.equal(runtime.workflowRuns[0].name, 'linear-chat-lead');
  const workflowWrite = runtime.fileWrites.find((entry) => entry.path === 'workflows/linear-chat-lead.ts');
  assert.ok(workflowWrite);
  assert.match(workflowWrite.contents, /git clone --filter=blob:none/);
  assert.match(workflowWrite.contents, /const CREATE_PR_SCRIPT_PATH = "\/tmp\/linear-chat-lead-create-pr\.cjs"/);
  assert.match(workflowWrite.contents, /const CREATE_PR_ARGS_PATH = "\/tmp\/linear-chat-lead-open-pr\.args\.json"/);
  assert.match(workflowWrite.contents, /printf %s ' \+ CREATE_PR_SCRIPT_B64 \+ ' \| base64 -d > ' \+ CREATE_PR_SCRIPT_PATH/);
  assert.match(workflowWrite.contents, /printf %s ' \+ CREATE_PR_ARGS_B64 \+ ' \| base64 -d > ' \+ CREATE_PR_ARGS_PATH/);
  assert.match(workflowWrite.contents, /node ' \+ CREATE_PR_SCRIPT_PATH \+ ' ' \+ CREATE_PR_ARGS_PATH/);
  assert.doesNotMatch(workflowWrite.contents, /node -e/);
  assert.doesNotMatch(workflowWrite.contents, /String\.raw/);
  assert.doesNotMatch(workflowWrite.contents, /OPEN_PR_SCRIPT/);
  assert.doesNotMatch(workflowWrite.contents, /shellQuote/);
  assert.doesNotMatch(workflowWrite.contents, /PR_TITLE/);
  assert.doesNotMatch(workflowWrite.contents, /PR_BODY/);
  assert.doesNotMatch(workflowWrite.contents, /Resolve AR-70/);
  assert.match(LINEAR_CREATE_PR_SCRIPT, /\/api\/v1\/github\/pull-request/);
  assert.match(LINEAR_CREATE_PR_SCRIPT, /WORKFORCE_WORKSPACE_TOKEN/);
  assert.doesNotMatch(LINEAR_CREATE_PR_SCRIPT, /gh pr create/);
  const scriptB64 = workflowWrite.contents.match(/const CREATE_PR_SCRIPT_B64 = "([^"]+)";/)?.[1];
  const argsB64 = workflowWrite.contents.match(/const CREATE_PR_ARGS_B64 = "([^"]+)";/)?.[1];
  assert.ok(scriptB64);
  assert.ok(argsB64);
  assert.equal(Buffer.from(scriptB64, 'base64').toString('utf8'), LINEAR_CREATE_PR_SCRIPT);
  const args = JSON.parse(Buffer.from(argsB64, 'base64').toString('utf8'));
  assert.deepEqual(args, {
    repoDir: './repo',
    owner: 'AgentWorkforce',
    repo: 'cloud',
    branch: 'codex/linear-ar-70',
    title: 'Resolve AR-70: Fix the failing Linear implementer',
    body: [
      'Linear issue: https://linear.app/agentrelay/issue/AR-70',
      'Prompt:\nPlease implement this.',
      'Implemented by linear-chat-lead delegation.',
    ].join('\n\n'),
  });
  assert.deepEqual(linear.activities.map((entry) => entry.activity.type), ['thought', 'response', 'response']);
  assert.match(linear.activities.at(-1)?.activity.body, /https:\/\/github\.com\/AgentWorkforce\/cloud\/pull\/123/);
});

test('AppUserNotification.issueCommentMention uses comment fallback', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event('AppUserNotification.issueCommentMention', {
    resource: {
      provider: 'linear',
      objectType: 'comment',
      payload: {
        type: 'AppUserNotification',
        action: 'issueCommentMention',
        notification: {
          issue: { id: 'issue-1', identifier: 'AR-70' },
          comment: { body: '@agentrelay what can you do here?' },
        },
      },
    },
  }), linear);

  assert.deepEqual(linear.comments, [{ issueId: 'issue-1', body: 'I can help with that.' }]);
  assert.equal(linear.activities.length, 0);
});

test('AppUserNotification without a mention logs a skip and does not reply', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event('AppUserNotification.issueCommentMention', {
    resource: {
      provider: 'linear',
      objectType: 'comment',
      payload: {
        type: 'AppUserNotification',
        action: 'issueCommentMention',
        notification: {
          issue: { id: 'issue-1', identifier: 'AR-70' },
          comment: { body: 'Checking in without asking the agent.' },
        },
      },
    },
  }), linear);

  assert.equal(linear.comments.length, 0);
  assert.equal(linear.activities.length, 0);
  assert.ok(runtime.logs.some((log) =>
    log.message === 'linear comment skipped' &&
    log.attrs?.reason === 'comment did not mention agent'
  ));
});

test('issue.create label path delegates without requiring a mention', async () => {
  const runtime = ctx({
    llm: {
      complete: async () => JSON.stringify({
        intent: 'implement',
        reply: 'I will implement this labelled issue.',
      }),
    },
  });
  const linear = linearClient();

  await handleLinearEvent(runtime, event('issue.create', {
    data: {
      id: 'issue-1',
      title: 'Fix the labelled issue',
      description: 'No explicit mention is needed because the trigger is label-scoped.',
    },
  }), linear);

  assert.equal(runtime.workflowRuns.length, 1);
  assert.deepEqual(linear.comments, [
    { issueId: 'issue-1', body: 'I will implement this labelled issue.' },
    { issueId: 'issue-1', body: 'Implementation is complete: https://github.com/AgentWorkforce/cloud/pull/123' },
  ]);
});

test('real relayfile comment record still resolves mention and issue id', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event('AppUserNotification.issueCommentMention', {
    resource: {
      provider: 'linear',
      objectType: 'comment',
      objectId: 'comment-1',
      payload: {
        body: '@agentrelay please explain this.',
        issue_id: 'issue-1',
        issue_identifier: 'AR-70',
      },
    },
  }), linear);

  assert.deepEqual(linear.comments, [{ issueId: 'issue-1', body: 'I can help with that.' }]);
  assert.ok(runtime.logs.some((log) =>
    log.message === 'linear event' &&
    log.attrs?.hasIssueId === true &&
    Array.isArray(log.attrs?.recordKeys) &&
    log.attrs.recordKeys.includes('body')
  ));
});
