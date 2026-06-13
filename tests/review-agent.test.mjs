import assert from 'node:assert/strict';
import test from 'node:test';

import { parseIntegrations } from '@agentworkforce/persona-kit';

import {
  announceReadyOnce,
  labelNames,
  postSlackPrUpdate,
  prReadyStateAllowsHumanReview,
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

test('readPr surfaces the draft flag so the draft gate can hold off', () => {
  // The draft flag feeds shouldSkipReview's preemptive draft gate — a held PR
  // must not be auto-reviewed/pushed. Read it off the pull_request payload.
  assert.equal(readPr({
    number: 27,
    pull_request: {
      number: 27,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/27',
      user: { login: 'WillWashburn' },
      draft: true,
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
  })?.draft, true);
  // A non-draft PR carries draft:false (not undefined) so the gate can tell
  // "explicitly ready" from "unknown".
  assert.equal(readPr({
    number: 28,
    pull_request: {
      number: 28,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/28',
      user: { login: 'WillWashburn' },
      draft: false,
    },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
  })?.draft, false);
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

test('reviewHarnessPrompt keeps fixes within the PR scope and verifies CI-deep', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 162 });
  // Scope discipline: out-of-scope reviewer suggestions become advisory notes,
  // not edits folded into this PR (the dropbox/linear scope-creep that broke an
  // unrelated build in agents#162's downstream relayfile-adapters PR).
  assert.match(prompt, /Stay within this PR's purpose/);
  assert.match(prompt, /use \.workforce\/context\.json for available PR\s+metadata/);
  assert.match(prompt, /record it as an advisory note under a "## Advisory Notes" heading in your review and leave the code unchanged/);
  // Verification must be CI-deep (full build/test), not just the touched file,
  // and must regenerate generated/committed artifacts the edit feeds.
  assert.match(prompt, /verify it the way CI does/);
  assert.match(prompt, /canonical build and test command end to end/);
  assert.match(prompt, /regenerate that file with the repo's own generator/);
  assert.match(prompt, /the working tree must pass the full command with your edits in place/);
  // Anti-hollow guard: don't make a check pass by gutting the test.
  assert.match(prompt, /Never make a check pass by weakening the test/);
  assert.match(prompt, /worse than no test/);
  assert.match(prompt, /only change a test's EXPECTATION when the test encoded the OLD/);
});

test('reviewHarnessPrompt limits auto-edits to mechanical changes', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 266 });
  assert.match(prompt, /Auto-edit only lint, formatting, spelling, typo, import-order, or other mechanical non-semantic changes/);
  assert.match(prompt, /Do not auto-edit semantic or safety-critical logic/);
  assert.match(prompt, /leave a clear suggestion or review comment instead of changing files/);
  assert.match(prompt, /PR already has a human review or approval/);
  assert.match(prompt, /suggestion\/comment-only/);
});

test('reviewHarnessPrompt forbids safety-default and lifecycle edits', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'factory-sdk', number: 264 });
  assert.match(prompt, /Never change semantic or safety defaults/);
  assert.match(prompt, /fail-closed states into fail-open states/);
  assert.match(prompt, /"timeout", "pending", throw, or undefined becoming "acked", true, \{\}/);
  assert.match(prompt, /swap truthiness checks for presence checks/);
  assert.match(prompt, /guard default values/);
  assert.match(prompt, /Never touch lifecycle, termination, reaper, in-flight, dispatch, broker ownership, or process-cleanup code/);
});

test('reviewHarnessPrompt forbids self-justifying test edits', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 243 });
  assert.match(prompt, /Never add or modify tests to make your own change pass/);
  assert.match(prompt, /If a change needs a new or updated test, that is a\s+human decision/);
  assert.match(prompt, /describe the needed test in your review and leave the working tree unchanged/);
});

test('reviewHarnessPrompt only allows READY after checks complete, pass, and the PR is mergeable', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 100 });
  assert.match(prompt, /every required CI check has completed/);
  assert.match(prompt, /none are pending\s+or in-progress/);
  assert.match(prompt, /all are passing/);
  assert.match(prompt, /GitHub reports it as mergeable/);
  assert.match(prompt, /If any check is still pending, in-progress, or failed, or if the PR\s+has merge conflicts, do NOT print READY/);
  assert.doesNotMatch(prompt, /there are no failing checks left/);
});

test('prReadyStateAllowsHumanReview downgrades READY while a check is pending', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'deploy-preview', state: 'PENDING' },
    ],
  }), false);
});

test('prReadyStateAllowsHumanReview requires mergeable PRs with only completed passing checks', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'lint', state: 'NEUTRAL' },
    ],
  }), true);

  assert.equal(prReadyStateAllowsHumanReview({
    mergeable: 'CONFLICTING',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  }), false);
});

test('prReadyStateAllowsHumanReview never reports a merged or closed PR ready', () => {
  const passingChecks = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'MERGED', mergeable: 'MERGEABLE', statusCheckRollup: passingChecks,
  }), false);
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'CLOSED', mergeable: 'MERGEABLE', statusCheckRollup: passingChecks,
  }), false);
  // An explicit OPEN state still passes when everything else is green.
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: passingChecks,
  }), true);
});

test('prReadyStateAllowsHumanReview treats an empty (not-yet-registered) check rollup as not ready', () => {
  // Empty rollup + not CLEAN = checks queued but not yet registered → pending.
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', statusCheckRollup: [],
  }), false);
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN',
  }), false);
  // No mergeStateStatus at all is also not-ready (can't confirm nothing's pending).
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [],
  }), false);
});

test('prReadyStateAllowsHumanReview allows a no-CI repo (empty rollup) only when GitHub reports CLEAN', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
  }), true);
});

test('prReadyStateAllowsHumanReview treats skipped checks as non-blocking', () => {
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'e2e-conditional', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'optional-gate', state: 'SKIPPED' },
    ],
  }), true);
});

test('prReadyStateAllowsHumanReview holds back drafts and changes-requested PRs', () => {
  const passingChecks = [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT', statusCheckRollup: passingChecks,
  }), false);
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: passingChecks,
  }), false);
});

test('reviewHarnessPrompt requires accounting for each bot/reviewer comment with a location', () => {
  const prompt = reviewHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 7 });
  assert.match(prompt, /## Addressed comments/);
  assert.match(prompt, /file:line where you/);
  assert.match(prompt, /do not say a comment\s+was addressed without pointing to the fix/);
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

test('does not save thread ts to memory when Slack post returns no ts', async () => {
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
        memory.push({ id: `memory-${memory.length + 1}`, content, tags: opts.tags, scope: opts.scope });
      },
    },
    log() {},
  };
  const slack = {
    async post(channel, text) {
      return { channel, ts: '' }; // simulates VFS writeback timeout — no receipt
    },
    async reply() { throw new Error('should not reply when no thread was saved'); },
  };
  const pr = {
    owner: 'AgentWorkforce',
    repo: 'agents',
    number: 93,
    url: 'https://github.com/AgentWorkforce/agents/pull/93',
    author: 'kjgbot',
  };

  await postSlackPrUpdate(ctx, pr, 'ready', slack);

  assert.equal(memory.length, 0, 'no thread ts must be saved when post returns empty ts');
});

test('posts new top-level messages on every call when Slack post never returns ts', async () => {
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
        memory.push({ id: `memory-${memory.length + 1}`, content, tags: opts.tags, scope: opts.scope });
      },
    },
    log() {},
  };
  const calls = [];
  const slack = {
    async post(channel, text) {
      calls.push({ kind: 'post', channel, text });
      return { channel, ts: '' }; // every post times out — no receipt
    },
    async reply() { throw new Error('should not reply when no thread was saved'); },
  };
  const pr = {
    owner: 'AgentWorkforce',
    repo: 'agents',
    number: 93,
    url: 'https://github.com/AgentWorkforce/agents/pull/93',
    author: 'kjgbot',
  };

  // Both calls should post a new top-level message; the second must NOT reply
  // (no thread ts was saved from the first). This is the double-post symptom
  // caused by the pre-fix 3s writeback timeout racing against the 5s VFS cycle.
  await postSlackPrUpdate(ctx, pr, 'ready', slack);
  await postSlackPrUpdate(ctx, pr, 'merged', slack);

  assert.deepEqual(calls, [
    { kind: 'post', channel: 'C123', text: 'ready' },
    { kind: 'post', channel: 'C123', text: 'merged' },
  ]);
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

test('announceReadyOnce posts once for the same head sha', async () => {
  const memory = [];
  const ctx = readyAnnouncementTestCtx(memory);
  const calls = [];
  const slack = readyAnnouncementSlack(calls);
  const pr = readyAnnouncementPr();

  await announceReadyOnce(ctx, pr, slack);
  await announceReadyOnce(ctx, pr, slack);

  assert.equal(readyAnnouncementMarkers(memory, 'reservation').length, 1);
  assert.equal(readyAnnouncementMarkers(memory, 'announced').length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /ready for your review/);
});

test('announceReadyOnce chooses one marker when same-head runs overlap', async () => {
  const memory = [];
  let saves = 0;
  let releaseSaves;
  const bothSaved = new Promise((resolve) => {
    releaseSaves = resolve;
  });
  const ctx = readyAnnouncementTestCtx(memory, {
    async afterSave() {
      saves += 1;
      if (saves === 2) releaseSaves();
      await bothSaved;
    },
  });
  const calls = [];
  const slack = readyAnnouncementSlack(calls);
  const pr = readyAnnouncementPr();

  await Promise.all([
    announceReadyOnce(ctx, pr, slack),
    announceReadyOnce(ctx, pr, slack),
  ]);

  assert.equal(readyAnnouncementMarkers(memory, 'reservation').length, 2);
  assert.equal(readyAnnouncementMarkers(memory, 'announced').length, 1);
  assert.equal(calls.length, 1);
});

test('announceReadyOnce retries when the winning Slack post fails before announcement is saved', async () => {
  const memory = [];
  const ctx = readyAnnouncementTestCtx(memory);
  const calls = [];
  const pr = readyAnnouncementPr();
  const failingSlack = {
    async post() {
      throw new Error('slack unavailable');
    },
    async reply() {
      throw new Error('should not reply');
    },
  };

  await assert.rejects(() => announceReadyOnce(ctx, pr, failingSlack), /slack unavailable/);
  assert.equal(readyAnnouncementMarkers(memory, 'announced').length, 0);

  await announceReadyOnce(ctx, pr, readyAnnouncementSlack(calls));

  assert.equal(calls.length, 1);
  assert.equal(readyAnnouncementMarkers(memory, 'announced').length, 1);
});

function readyAnnouncementMarkers(memory, kind) {
  return memory.filter((item) => {
    if (!item.tags.includes('pr-reviewer:ready-announced')) return false;
    return JSON.parse(item.content).kind === kind;
  });
}

function readyAnnouncementTestCtx(memory, hooks = {}) {
  return {
    persona: {
      inputSpecs: { SLACK_CHANNEL: { env: '__TEST_SLACK_CHANNEL__' } },
      inputs: { SLACK_CHANNEL: 'C123' },
    },
    memory: {
      async recall(_query, opts) {
        return memory.filter((item) => opts.tags.every((tag) => item.tags.includes(tag)));
      },
      async save(content, opts) {
        const id = `memory-${memory.length + 1}`;
        memory.push({
          id,
          content,
          tags: opts.tags,
          scope: opts.scope,
          createdAt: new Date(memory.length).toISOString(),
        });
        await hooks.afterSave?.();
        return { id };
      },
    },
    log() {},
  };
}

function readyAnnouncementSlack(calls) {
  return {
    async post(channel, text) {
      calls.push({ kind: 'post', channel, text });
      return { channel, ts: '1710000000.123456' };
    },
    async reply(channel, threadTs, text) {
      calls.push({ kind: 'reply', channel, threadTs, text });
      return { channel, ts: '1710000001.123456' };
    },
  };
}

function readyAnnouncementPr() {
  return {
    owner: 'AgentWorkforce',
    repo: 'agents',
    number: 50,
    url: 'https://github.com/AgentWorkforce/agents/pull/50',
    author: 'khaliqgant',
    headSha: '9b1ecb4022bf574885b50376db65a827ddedce3b',
  };
}
