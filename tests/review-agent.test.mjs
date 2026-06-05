import assert from 'node:assert/strict';
import test from 'node:test';

import { parseIntegrations } from '@agentworkforce/persona-kit';

import {
  labelNames,
  postSlackPrUpdate,
  readPr,
  resolveAuthorLogin,
  reviewHarnessPrompt,
  reviewAuthorAllowlistDecision,
} from '../.test-build/review/agent.js';

test('reviewAuthorAllowlistDecision lets configured authors through', () => {
  assert.equal(reviewAuthorAllowlistDecision(new Set(['willwashburn']), 'willwashburn'), null);
});

test('reviewAuthorAllowlistDecision skips authors not in the allowlist', () => {
  assert.deepEqual(
    reviewAuthorAllowlistDecision(new Set(['khaliqgant']), 'willwashburn'),
    { reason: 'author @willwashburn is not in REVIEW_AUTHORS' },
  );
});

test('reviewAuthorAllowlistDecision skips unresolved authors when configured', () => {
  assert.deepEqual(
    reviewAuthorAllowlistDecision(new Set(['khaliqgant']), ''),
    { reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved', notify: true },
  );
  assert.deepEqual(
    reviewAuthorAllowlistDecision(new Set(['khaliqgant']), 'unknown'),
    { reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved', notify: true },
  );
});

test('reviewAuthorAllowlistDecision leaves unset allowlists open to everyone', () => {
  assert.equal(reviewAuthorAllowlistDecision(new Set(), 'willwashburn'), null);
  assert.equal(reviewAuthorAllowlistDecision(new Set(), ''), null);
  assert.equal(reviewAuthorAllowlistDecision(new Set(), 'unknown'), null);
});

test('resolveAuthorLogin prefers normalized meta author shapes', () => {
  assert.equal(resolveAuthorLogin({ author: ' WillWashburn ' }, { author: 'fallback' }), 'willwashburn');
  assert.equal(resolveAuthorLogin({ author: { login: ' KhaliqGant ' } }, { author: 'fallback' }), 'khaliqgant');
  assert.equal(resolveAuthorLogin({}, { author: ' FallBack ' }), 'fallback');
});

test('readPr does not treat check-run sender as the PR author', () => {
  assert.deepEqual(readPr({
    check_run: {
      pull_requests: [{
        number: 27,
        html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
        head_sha: 'abc123',
      }],
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'allowed-bot' },
  }), {
    owner: 'AgentWorkforce',
    repo: 'agents',
    number: 27,
    url: 'https://github.com/AgentWorkforce/agents/pull/27',
    author: 'unknown',
    headSha: 'abc123',
  });
});

test('readPr uses the pull request opener as author when present', () => {
  assert.equal(readPr({
    number: 27,
    pull_request: {
      number: 27,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
      user: { login: 'WillWashburn' },
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'reviewer' },
  })?.author, 'WillWashburn');
});

test('readPr falls back to sender login for PR-shaped payloads when opener login is missing', () => {
  assert.equal(readPr({
    number: 27,
    pull_request: {
      number: 27,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'KhaliqGant' },
  })?.author, 'KhaliqGant');
});

test('labelNames normalizes github label arrays defensively', () => {
  assert.deepEqual(labelNames([
    { name: ' No-Agent-Relay-Review ' },
    { name: '' },
    { name: 42 },
    null,
    { other: 'ignored' },
  ]), ['no-agent-relay-review']);
  assert.deepEqual(labelNames(undefined), []);
});

test('reviewHarnessPrompt forbids git except the explicit restore-only carve-out', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 47 });
  assert.match(prompt, /Don't use git or the gh CLI/);
  // "git restore <file>" is deliberately permitted for discarding unverified
  // edits (agents#47 review): rewriting a file back from memory is error-prone,
  // a restore from HEAD is not. It must be framed as the exception...
  assert.match(prompt, /git restore <file>.*exception to the no-git rule/);
  // ...and no destructive/state-mutating git verb may creep in.
  assert.doesNotMatch(prompt, /\bgit\s+(checkout|reset|clean|commit|push|add|fetch|pull|rebase|merge|stash)\b/);
});

// Cloud only mounts an integration's relayfile subtree from its `scope` (or
// from triggers — and this persona has github triggers only). A scope-less
// `slack: {}` mounts nothing, so every slackClient() post was written to
// unmounted local disk and silently dropped. persona-kit also discards empty
// scope objects client-side, so the scope must survive parsing as a non-empty
// string map covering the `/slack/channels/{channelId}/messages` writeback
// path. This pins both halves.
test('persona declares a slack scope that survives persona-kit parsing and covers the messages writeback path', async () => {
  const { default: persona } = await import('../.test-build/review/persona.js');
  const parsed = parseIntegrations(persona.integrations, 'integrations');
  const scope = parsed?.slack?.scope;
  assert.ok(scope && Object.keys(scope).length > 0, 'slack integration must declare a non-empty scope or cloud mounts no /slack paths');
  const covers = Object.values(scope).some(
    (value) => typeof value === 'string' && value.startsWith('/slack/channels/'),
  );
  assert.ok(covers, 'slack scope must cover /slack/channels/** so slackClient() drafts reach the writeback worker');
});

test('postSlackPrUpdate starts one channel message per PR and threads later updates', async () => {
  const memory = [];
  const ctx = {
    persona: {
      inputSpecs: { SLACK_CHANNEL: { env: '__TEST_SLACK_CHANNEL__' } },
      inputs: { SLACK_CHANNEL: 'C123' },
    },
    memory: {
      async recall(_query, opts) {
        return memory.filter((item) => opts.tags.every((tag) => item.tags.includes(tag)));
      },
      async save(content, opts) {
        memory.push({
          id: `memory-${memory.length + 1}`,
          content,
          tags: opts.tags,
          scope: opts.scope,
          createdAt: new Date(0).toISOString(),
        });
      },
    },
    log() {},
  };
  const calls = [];
  const slack = {
    async post(channel, text) {
      calls.push({ kind: 'post', channel, text });
      return { channel, ts: '1710000000.123456' };
    },
    async reply(channel, threadTs, text) {
      calls.push({ kind: 'reply', channel, threadTs, text });
      return { channel, ts: '1710000001.123456' };
    },
  };
  const pr = {
    owner: 'AgentWorkforce',
    repo: 'relayfile-adapters',
    number: 158,
    url: 'https://github.com/AgentWorkforce/relayfile-adapters/pull/158',
    author: 'kjgbot',
  };

  await postSlackPrUpdate(ctx, pr, 'ready', slack);
  await postSlackPrUpdate(ctx, pr, 'merged', slack);

  assert.deepEqual(calls, [
    { kind: 'post', channel: 'C123', text: 'ready' },
    { kind: 'reply', channel: 'C123', threadTs: '1710000000.123456', text: 'merged' },
  ]);
});
