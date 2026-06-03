import assert from 'node:assert/strict';
import test from 'node:test';

import {
  labelNames,
  readPr,
  resolveAuthorLogin,
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
