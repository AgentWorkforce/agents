import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linearClient as relayLinearClient } from '@relayfile/relay-helpers';

import linearAgent, { handleLinearEvent } from '../.test-build/linear/agent.js';

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
  assert.deepEqual(runtime.fileWrites, []);
  assert.deepEqual(runtime.workflowRuns[0].args, {
    repo: 'AgentWorkforce/cloud',
    branch: 'codex/linear-ar-70',
    issueTitle: 'Fix the failing Linear implementer',
    issueBody: 'The chat lead should answer and delegate implementation when asked.',
    userPrompt: 'Please implement this.',
    issueId: 'issue-1',
    issueIdentifier: 'AR-70',
    issueUrl: 'https://linear.app/agentrelay/issue/AR-70',
    openPrArgs: {
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
    },
  });

  const workflowSource = await readFile('workflows/linear-chat-lead.ts', 'utf8');
  assert.match(workflowSource, /process\.env\.invocationArgs/);
  assert.match(workflowSource, /git clone --filter=blob:none/);
  assert.match(workflowSource, /linear-create-pr\.cjs/);
  assert.match(workflowSource, /randomUUID/);
  assert.match(workflowSource, /printf %s/);
  assert.match(workflowSource, /rm -f "\$args_path"/);
  assert.doesNotMatch(workflowSource, /CREATE_PR_SCRIPT_B64/);
  assert.doesNotMatch(workflowSource, /CREATE_PR_ARGS_B64/);
  assert.doesNotMatch(workflowSource, /base64 -d/);
  assert.doesNotMatch(workflowSource, /node -e/);
  assert.doesNotMatch(workflowSource, /String\.raw/);

  const createPrScript = await readFile('workflows/linear-create-pr.cjs', 'utf8');
  assert.match(createPrScript, /\/api\/v1\/github\/pull-request/);
  assert.match(createPrScript, /WORKFORCE_WORKSPACE_TOKEN/);
  assert.match(createPrScript, /lstatSync/);
  assert.match(createPrScript, /isSymbolicLink/);
  assert.match(createPrScript, /refs\/remotes\/origin\/HEAD/);
  assert.match(createPrScript, /baseBranch/);
  assert.doesNotMatch(createPrScript, /baseBranch: 'main'/);
  assert.doesNotMatch(createPrScript, /gh pr create/);

  assert.deepEqual(runtime.workflowRuns[0].args.openPrArgs, {
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

test('AgentSessionEvent falls back to issue comments when session methods are unavailable', async () => {
  const runtime = ctx();
  const linear = linearClient();
  delete linear.agentActivity;
  delete linear.respond;
  delete linear.acknowledge;

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

  assert.deepEqual(linear.activities, []);
  assert.deepEqual(linear.comments, [{ issueId: 'issue-1', body: 'I can help with that.' }]);
  assert.ok(runtime.memorySaves.some((entry) => entry.content === 'user: What is the current plan?'));
  assert.ok(runtime.memorySaves.some((entry) => entry.content === 'assistant: I can help with that.'));
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

test('resource wrapper without payload is treated as the record', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event('AppUserNotification.issueCommentMention', {
    resource: {
      provider: 'linear',
      objectType: 'comment',
      body: '@agentrelay please explain this.',
      issue_id: 'issue-1',
      issue_identifier: 'AR-70',
    },
  }), linear);

  assert.deepEqual(linear.comments, [{ issueId: 'issue-1', body: 'I can help with that.' }]);
  assert.ok(runtime.logs.some((log) =>
    log.message === 'linear event' &&
    Array.isArray(log.attrs?.recordKeys) &&
    log.attrs.recordKeys.includes('body')
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

test('relay helper reads Linear issues from by-uuid alias without raw-id file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'linear-chat-lead-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issueId = '5d6f2e15-0f1d-45ed-826b-183265809202';
  const issue = {
    id: issueId,
    identifier: 'AR-70',
    title: 'Fix Linear by-uuid reads',
  };

  await mkdir(path.join(root, 'linear/issues/by-uuid'), { recursive: true });
  await writeFile(
    path.join(root, 'linear/issues/by-uuid', `${issueId}.json`),
    JSON.stringify(issue),
  );

  assert.deepEqual(
    await relayLinearClient({ relayfileMountRoot: root, writebackTimeoutMs: 0 }).getIssue(issueId),
    issue,
  );
});
