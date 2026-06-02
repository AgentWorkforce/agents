import assert from 'node:assert/strict';
import test from 'node:test';

import { handleLinearEvent } from '../.test-build/linear/agent.js';

function ctx(overrides = {}) {
  const harnessCalls = [];
  const logs = [];
  return {
    harnessCalls,
    logs,
    workspaceId: 'workspace-1',
    agentName: 'linear-implementer',
    agent: { id: 'agent-linear', deployedName: 'Agent Relay', spawnedByAgentId: null },
    deployment: { id: 'deployment-1', triggerKind: 'radio', parentDeploymentId: null },
    persona: {
      id: 'linear-implementer',
      inputs: {},
      inputSpecs: { MENTION: { env: 'MENTION', optional: true } },
    },
    sandbox: { cwd: '/workspace' },
    harness: {
      run: async (args) => {
        harnessCalls.push(args);
        return { output: 'https://github.com/AgentWorkforce/cloud/pull/123' };
      },
    },
    log: (level, message, attrs) => logs.push({ level, message, attrs }),
    ...overrides,
  };
}

function linearClient() {
  const comments = [];
  return {
    comments,
    async getIssue(issueId) {
      return {
        id: issueId,
        title: 'Fix the failing Linear implementer',
        description: 'The comment trigger should launch the harness and open a PR.',
      };
    },
    async comment(issueId, body) {
      comments.push({ issueId, body });
    },
  };
}

function event(payload) {
  return {
    source: 'linear',
    id: 'evt-comment-1',
    occurredAt: '2026-06-02T19:00:00.000Z',
    attempt: 1,
    workspaceId: 'workspace-1',
    type: 'comment.create',
    payload,
  };
}

test('Linear comment.create with markdown mention reaches harness without literal @agentrelay', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event({
    data: {
      id: 'comment-1',
      issueId: 'issue-1',
      body: '@[Agent Relay](mention-user-1) please implement this',
    },
  }), linear);

  assert.equal(runtime.harnessCalls.length, 1);
  assert.equal(runtime.harnessCalls[0].cwd, '/workspace');
  assert.match(runtime.harnessCalls[0].prompt, /Fix the failing Linear implementer/);
  assert.deepEqual(linear.comments, [{
    issueId: 'issue-1',
    body: ':rocket: Opened a PR: https://github.com/AgentWorkforce/cloud/pull/123',
  }]);
});

test('Linear comment.create without a mention logs a skip and does not run harness', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event({
    data: {
      id: 'comment-1',
      issueId: 'issue-1',
      body: 'Checking in on this issue without asking the agent to implement it.',
    },
  }), linear);

  assert.equal(runtime.harnessCalls.length, 0);
  assert.equal(linear.comments.length, 0);
  assert.ok(runtime.logs.some((log) =>
    log.message === 'linear comment skipped' &&
    log.attrs?.reason === 'comment did not mention agent'
  ));
});

test('Linear own PR comment short-circuits before triggering another run', async () => {
  const runtime = ctx();
  const linear = linearClient();

  await handleLinearEvent(runtime, event({
    data: {
      id: 'comment-1',
      issueId: 'issue-1',
      body: ':rocket: Opened a PR: https://github.com/AgentWorkforce/cloud/pull/123',
    },
  }), linear);

  assert.equal(runtime.harnessCalls.length, 0);
  assert.equal(linear.comments.length, 0);
  assert.ok(runtime.logs.some((log) =>
    log.message === 'linear comment skipped' &&
    log.attrs?.reason === 'own comment'
  ));
});
