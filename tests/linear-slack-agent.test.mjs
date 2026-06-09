import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSlackEvent } from '../.test-build/linear-slack/agent.js';

function ctx(overrides = {}) {
  const logs = [];
  const memorySaves = [];
  return {
    logs,
    memorySaves,
    persona: { id: 'linear-slack', inputs: {}, inputSpecs: {} },
    sandbox: { cwd: '/home/daytona/workspace' },
    memory: {
      recall: async () => [],
      save: async (content, opts) => { memorySaves.push({ content, opts }); return { id: 'm1' }; },
    },
    harness: { run: async () => ({ output: overrides.harnessOutput ?? '' }) },
    log: (level, message, attrs) => logs.push({ level, message, attrs }),
    ...overrides,
  };
}

function slackSpy() {
  const posts = [];
  const reactions = [];
  return {
    posts,
    reactions,
    async post(channel, text) { posts.push({ channel, text }); return { channel, ts: 'ts-1' }; },
    async reply(channel, threadTs, text) { posts.push({ channel, threadTs, text }); return { channel, ts: 'ts-1' }; },
    async react(channel, messageTs, emoji) { reactions.push({ channel, messageTs, emoji }); },
  };
}

function linearSpy(overrides = {}) {
  const created = [];
  const comments = [];
  return {
    created,
    comments,
    async createIssue(args) {
      created.push(args);
      return overrides.createIssue ?? { id: 'AR-84', url: 'https://linear.app/agentrelay/issue/AR-84/remove-dashboard' };
    },
    async comment(issueId, body) {
      comments.push({ issueId, body });
      return overrides.comment ?? { id: 'c1', url: 'https://linear.app/agentrelay/issue/AR-10#comment-c1' };
    },
  };
}

function slackEvent(text) {
  return {
    source: 'slack',
    id: 'evt-1',
    type: 'message.created',
    payload: { channel: 'C0B9287EP6Y', ts: '1781004465.912899', text, user: 'U1', is_bot: false },
  };
}

const ACTION = (obj) => '```linear-actions\n' + JSON.stringify(obj) + '\n```';

test('create_issue action runs through linearClient and reports the CONFIRMED url', async () => {
  const runtime = ctx({
    harnessOutput: `Creating that issue in Launch SDK now.\n\n${ACTION([
      { action: 'create_issue', teamId: 'team-uuid', title: 'Remove the dashboard from the agent-relay up command', projectId: 'proj-uuid', description: 'desc' },
    ])}`,
  });
  const slack = slackSpy();
  const linear = linearSpy();

  await handleSlackEvent(runtime, slackEvent('make an issue to remove the dashboard'), slack, linear);

  // a fast 👀 ack lands on the teammate's message before the slow work
  assert.deepEqual(slack.reactions, [{ channel: 'C0B9287EP6Y', messageTs: '1781004465.912899', emoji: 'eyes' }]);
  // the real Linear writeback was invoked with allow-listed fields + required ids
  assert.equal(linear.created.length, 1);
  assert.deepEqual(linear.created[0], {
    teamId: 'team-uuid', title: 'Remove the dashboard from the agent-relay up command',
    description: 'desc', projectId: 'proj-uuid',
  });
  // the reply carries the prose AND the confirmed link, and the action block is gone
  const posted = slack.posts.at(-1).text;
  assert.match(posted, /Creating that issue in Launch SDK now\./);
  assert.match(posted, /✅ Created the issue: https:\/\/linear\.app\/agentrelay\/issue\/AR-84/);
  assert.doesNotMatch(posted, /linear-actions/);
  // the recorded turn is the confirmed reply, not the harness's raw output
  assert.ok(runtime.memorySaves.some((s) => /✅ Created the issue/.test(s.content)));
});

test('an unconfirmed create (no receipt → draft-path fallback) is flagged, never claimed done', async () => {
  const runtime = ctx({
    harnessOutput: `On it.\n\n${ACTION([{ action: 'create_issue', teamId: 't', title: 'x' }])}`,
  });
  const slack = slackSpy();
  // url falls back to the draft path when the writeback worker never acks
  const linear = linearSpy({ createIssue: { id: '/linear/issues/issues abc.json', url: '/linear/issues/issues abc.json' } });

  await handleSlackEvent(runtime, slackEvent('make an issue'), slack, linear);

  const posted = slack.posts.at(-1).text;
  assert.doesNotMatch(posted, /✅/);
  assert.match(posted, /appear on the board|minute or two|Submitting/i);
  assert.ok(runtime.logs.some((l) => l.message === 'linear-slack.action.unconfirmed'));
});

test('create_issue missing teamId is refused without calling Linear', async () => {
  const runtime = ctx({
    harnessOutput: `${ACTION([{ action: 'create_issue', title: 'no team' }])}`,
  });
  const slack = slackSpy();
  const linear = linearSpy();

  await handleSlackEvent(runtime, slackEvent('make an issue'), slack, linear);

  assert.equal(linear.created.length, 0);
  assert.match(slack.posts.at(-1).text, /missing `teamId`/);
});

test('comment action posts through linearClient and confirms', async () => {
  const runtime = ctx({
    harnessOutput: ACTION([{ action: 'comment', issueId: 'issue-uuid', body: 'looks good' }]),
  });
  const slack = slackSpy();
  const linear = linearSpy();

  await handleSlackEvent(runtime, slackEvent('comment on AR-10'), slack, linear);

  assert.deepEqual(linear.comments, [{ issueId: 'issue-uuid', body: 'looks good' }]);
  assert.match(slack.posts.at(-1).text, /✅ Added the comment/);
});

test('a read-only / discussion turn posts prose and triggers NO writes', async () => {
  const runtime = ctx({ harnessOutput: 'There are 3 open issues in Launch SDK: AR-10, AR-11, AR-17.' });
  const slack = slackSpy();
  const linear = linearSpy();

  await handleSlackEvent(runtime, slackEvent('what is open in launch sdk?'), slack, linear);

  assert.equal(linear.created.length, 0);
  assert.equal(linear.comments.length, 0);
  assert.equal(slack.posts.at(-1).text, 'There are 3 open issues in Launch SDK: AR-10, AR-11, AR-17.');
});

test('a malformed action block changes nothing and says so', async () => {
  const runtime = ctx({
    harnessOutput: 'Trying.\n\n```linear-actions\n{ not valid json,, }\n```',
  });
  const slack = slackSpy();
  const linear = linearSpy();

  await handleSlackEvent(runtime, slackEvent('make an issue'), slack, linear);

  assert.equal(linear.created.length, 0);
  assert.match(slack.posts.at(-1).text, /malformed/);
});
