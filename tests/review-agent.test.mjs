import assert from 'node:assert/strict';
import test from 'node:test';

import {
  labelNames,
  readPr,
  resolveAuthorLogin,
  reviewAuthorAllowlistDecisionForPr,
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

test('reviewAuthorAllowlistDecisionForPr falls back to GitHub API when mounted PR author is not ready', async () => {
  const calls = [];
  const decision = await reviewAuthorAllowlistDecisionForPr(
    ctxWithGithubToken('ghp_test'),
    new Set(['khaliqgant']),
    {},
    prWithUnknownAuthor(),
    async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { user: { login: 'KhaliqGant' } };
        },
      };
    },
  );

  assert.equal(decision, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/AgentWorkforce/cloud/pulls/1803');
  assert.equal(calls[0].init.headers.authorization, 'Bearer ghp_test');
});

test('reviewAuthorAllowlistDecisionForPr recognizes cloud pull-request workspace token env', async () => {
  const calls = [];
  const decision = await reviewAuthorAllowlistDecisionForPr(
    {
      persona: {
        inputs: { GITHUB_PR_WORKSPACE_TOKEN: 'ghs_installation_test' },
        inputSpecs: {},
      },
    },
    new Set(['khaliqgant']),
    {},
    prWithUnknownAuthor(),
    async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return { user: { login: 'khaliqgant' } };
        },
      };
    },
  );

  assert.equal(decision, null);
  assert.equal(calls[0].init.headers.authorization, 'Bearer ghs_installation_test');
});

test('reviewAuthorAllowlistDecisionForPr remains fail-closed when GitHub API author lookup fails', async () => {
  const decision = await reviewAuthorAllowlistDecisionForPr(
    ctxWithGithubToken('ghp_test'),
    new Set(['khaliqgant']),
    {},
    prWithUnknownAuthor(),
    async () => ({ ok: false, async json() { return {}; } }),
  );

  assert.deepEqual(decision, {
    reason: 'REVIEW_AUTHORS is set but the PR author could not be resolved',
    notify: true,
  });
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

function ctxWithGithubToken(token) {
  return {
    persona: {
      inputs: { GITHUB_TOKEN: token },
      inputSpecs: {},
    },
  };
}

function prWithUnknownAuthor() {
  return {
    owner: 'AgentWorkforce',
    repo: 'cloud',
    number: 1803,
    url: 'https://github.com/AgentWorkforce/cloud/pull/1803',
    author: 'unknown',
  };
}
