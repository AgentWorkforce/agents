import assert from 'node:assert/strict';
import test from 'node:test';

import { parseIntegrations } from '@agentworkforce/persona-kit';

import {
  announceReadyOnce,
  commentBody,
  commenterLogin,
  attributeCiFailure,
  ciObservationFor,
  conflictResolveHarnessPrompt,
  failingCheckGuidance,
  readFailingCheck,
  deriveReviewDecision,
  evaluateMergeOnGreenState,
  HARNESS_RESOURCE_ENV,
  handleSlackMergeRequest,
  harnessExitCode,
  harnessOutputTail,
  isInfraKillExitCode,
  logHarnessFailureDiagnostics,
  isAuthorizedConflictCommander,
  labelNames,
  matchesConflictDirective,
  parseSlackMergeRequest,
  postSlackPrUpdate,
  prReadyStateAllowsHumanReview,
  readPr,
  resolveAuthorLogin,
  reviewHarnessPrompt,
  runReviewHarnessWithRetry,
  reviewAuthorAllowlistDecision,
  rollupFromCheckSummary,
} from '../.test-build/review/agent.js';

function conflictCtx({ approvers, reviewAuthors } = {}) {
  return {
    persona: {
      inputSpecs: {
        APPROVERS: { env: '__TEST_APPROVERS__' },
        REVIEW_AUTHORS: { env: '__TEST_REVIEW_AUTHORS__' },
      },
      inputs: {
        ...(approvers ? { APPROVERS: approvers } : {}),
        ...(reviewAuthors ? { REVIEW_AUTHORS: reviewAuthors } : {}),
      },
    },
  };
}

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

test('matchesConflictDirective fires only on an explicit fix/resolve-conflicts ask', () => {
  assert.equal(matchesConflictDirective('@relay fix conflicts'), true);
  assert.equal(matchesConflictDirective('hey @relay-bot RESOLVE conflict now'), true);
  assert.equal(matchesConflictDirective('@relay resolve conflicts please'), true);
  // The directive words must be adjacent — filler between them does not fire,
  // so a force-update is never triggered by a loose mention.
  assert.equal(matchesConflictDirective('@relay-bot please RESOLVE the conflict'), false);
  // A passing mention or a plain observation must NOT trigger a force-update.
  assert.equal(matchesConflictDirective('@relay this PR has a conflict'), false);
  assert.equal(matchesConflictDirective('there is a merge conflict here'), false);
  assert.equal(matchesConflictDirective(''), false);
});

test('commentBody / commenterLogin read the issue_comment payload defensively', () => {
  const payload = { comment: { body: '@relay fix conflicts', user: { login: 'KhaliqGant' } } };
  assert.equal(commentBody(payload), '@relay fix conflicts');
  assert.equal(commenterLogin(payload), 'khaliqgant');
  assert.equal(commentBody({}), '');
  assert.equal(commenterLogin({}), '');
});

test('readPr reads a PR from an issue_comment payload when the issue is a pull request', () => {
  const pr = readPr({
    action: 'created',
    issue: {
      number: 77,
      html_url: 'https://github.com/AgentWorkforce/agents/pull/77',
      user: { login: 'WillWashburn' }, // the PR opener — must win as author
      state: 'open',
      pull_request: { url: 'https://api.github.com/.../pulls/77' },
    },
    comment: { body: '@relay fix conflicts', user: { login: 'KhaliqGant' } },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
    sender: { login: 'KhaliqGant' },
  });
  assert.equal(pr?.number, 77);
  assert.equal(pr?.author, 'WillWashburn');
  assert.equal(pr?.url, 'https://github.com/AgentWorkforce/agents/pull/77');
});

test('readPr ignores an issue_comment on a plain issue (no pull_request marker)', () => {
  assert.equal(readPr({
    action: 'created',
    issue: { number: 5, html_url: 'https://github.com/AgentWorkforce/agents/issues/5' },
    comment: { body: '@relay fix conflicts' },
    repository: { name: 'agents', owner: { login: 'AgentWorkforce' } },
  }), undefined);
});

test('isAuthorizedConflictCommander never takes the order from a bot', () => {
  const pr = { owner: 'AgentWorkforce', repo: 'agents', number: 1, author: 'someone' };
  assert.equal(isAuthorizedConflictCommander(conflictCtx(), 'relay-conflict-autofix[bot]', pr), false);
  assert.equal(isAuthorizedConflictCommander(conflictCtx(), '', pr), false);
});

test('isAuthorizedConflictCommander is open when no trust lists are configured', () => {
  const pr = { owner: 'AgentWorkforce', repo: 'agents', number: 1, author: 'willwashburn' };
  assert.equal(isAuthorizedConflictCommander(conflictCtx(), 'anyone', pr), true);
});

test('isAuthorizedConflictCommander gates on APPROVERS/REVIEW_AUTHORS and the PR author', () => {
  const pr = { owner: 'AgentWorkforce', repo: 'agents', number: 1, author: 'WillWashburn' };
  // PR author may always fix their own PR's conflicts even if not on a list.
  assert.equal(isAuthorizedConflictCommander(conflictCtx({ approvers: 'khaliqgant' }), 'willwashburn', pr), true);
  // A listed approver qualifies.
  assert.equal(isAuthorizedConflictCommander(conflictCtx({ approvers: 'khaliqgant' }), 'khaliqgant', pr), true);
  // A REVIEW_AUTHORS member qualifies too.
  assert.equal(isAuthorizedConflictCommander(conflictCtx({ reviewAuthors: 'octocat' }), 'octocat', pr), true);
  // A stranger, with a list configured, does not.
  assert.equal(isAuthorizedConflictCommander(conflictCtx({ approvers: 'khaliqgant' }), 'randuser', pr), false);
});

test('conflictResolveHarnessPrompt keeps the no-git boundary and the safety/escape-hatch rules', () => {
  const prompt = conflictResolveHarnessPrompt({ owner: 'AgentWorkforce', repo: 'agents', number: 99 });
  // Reads cloud's merged tree + conflicted-file manifest.
  assert.match(prompt, /\.workforce\/conflicted-files\.txt/);
  assert.match(prompt, /cloud has already merged the base branch into the working tree/);
  // No git in the harness; cloud finalizes + pushes the merge.
  assert.match(prompt, /Do NOT use git or the gh CLI/);
  assert.match(prompt, /Cloud finalizes the merge commit and pushes/);
  // Combine both sides; strip every marker.
  assert.match(prompt, /preserves BOTH sides' intent/);
  assert.match(prompt, /leave no <<<<<<<, =======, or >>>>>>> behind/);
  // Same safety guardrails as review.
  assert.match(prompt, /fail-closed state into a\s+fail-open one/);
  assert.match(prompt, /Never weaken or delete a test/);
  assert.match(prompt, /Never touch lifecycle, termination, reaper/);
  // Human-judgment escape hatch → cloud aborts the merge.
  assert.match(prompt, /## Unresolved conflicts/);
  assert.match(prompt, /Cloud aborts the\s+merge/);
  // CI-deep verification of the merged tree.
  assert.match(prompt, /verify the merged tree the way CI does/);
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

test('readPr resolves issue labeled payloads for pull requests in any AgentWorkforce repo', () => {
  assert.deepEqual(readPr({
    action: 'labeled',
    label: { name: 'merge-on-green' },
    issue: {
      number: 158,
      html_url: 'https://github.com/AgentWorkforce/relayfile-adapters/issues/158',
      pull_request: {},
      labels: [{ name: 'merge-on-green' }],
    },
    repository: { name: 'relayfile-adapters', owner: { login: 'AgentWorkforce' } },
  }), {
    owner: 'AgentWorkforce',
    repo: 'relayfile-adapters',
    number: 158,
    url: 'https://github.com/AgentWorkforce/relayfile-adapters/issues/158',
    author: 'unknown',
    labels: [{ name: 'merge-on-green' }],
  });
});

test('evaluateMergeOnGreenState requires label, green checks, and requested bot approvals', () => {
  const base = {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [{ name: 'merge-on-green' }],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    reviewRequests: [
      { requestedReviewer: { login: 'coderabbitai[bot]', type: 'Bot' } },
    ],
    latestReviews: [
      { author: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'APPROVED', submittedAt: '2026-06-10T00:00:00Z' },
    ],
  };

  assert.deepEqual(evaluateMergeOnGreenState(base), { outcome: 'ready', reasons: [] });

  assert.equal(evaluateMergeOnGreenState({
    ...base,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'unit', status: 'IN_PROGRESS', conclusion: null },
    ],
  }).outcome, 'pending');

  assert.deepEqual(evaluateMergeOnGreenState({
    ...base,
    latestReviews: [],
  }), {
    outcome: 'pending',
    reasons: ['bot @coderabbitai[bot] has not approved yet'],
  });

  assert.equal(evaluateMergeOnGreenState({
    ...base,
    latestReviews: [
      { author: { login: 'gemini-code-assist[bot]', type: 'Bot' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-10T00:00:00Z' },
    ],
  }).outcome, 'blocked');
});

test('rollupFromCheckSummary maps the adapter check summary to gate-ready rollups', () => {
  // No checks ingested yet (missing / total 0) → empty rollup. The gates then
  // fall through to mergeStateStatus (which the VFS path never reports CLEAN),
  // so the PR HOLDS instead of going green on absent CI.
  assert.deepEqual(rollupFromCheckSummary(undefined), []);
  assert.deepEqual(rollupFromCheckSummary({ total: 0, passed: 0, failed: 0, pending: 0 }), []);

  // All complete and passing → one SUCCESS entry the evaluators read as green.
  const green = rollupFromCheckSummary({ total: 3, passed: 3, failed: 0, pending: 0 });
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    labels: [{ name: 'merge-on-green' }], statusCheckRollup: green,
  }).outcome, 'ready');

  // A pending check → IN_PROGRESS → the merge-on-green gate stays pending.
  const pending = rollupFromCheckSummary({ total: 2, passed: 1, failed: 0, pending: 1 });
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    labels: [{ name: 'merge-on-green' }], statusCheckRollup: pending,
  }).outcome, 'pending');

  // A failing check → FAILURE → blocked.
  const failing = rollupFromCheckSummary({ total: 2, passed: 1, failed: 1, pending: 0 });
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    labels: [{ name: 'merge-on-green' }], statusCheckRollup: failing,
  }).outcome, 'blocked');

  // Green checks also satisfy the human-review ready gate.
  assert.equal(prReadyStateAllowsHumanReview({
    state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: green,
  }), true);

  // `total` missing but component counts present → derive total from the counts
  // so a failing check still blocks (not treated as "no checks reported").
  assert.equal(evaluateMergeOnGreenState({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [{ name: 'merge-on-green' }],
    statusCheckRollup: rollupFromCheckSummary({ failed: 1, pending: 0, passed: 2 }),
  }).outcome, 'blocked');
});

test('deriveReviewDecision flags CHANGES_REQUESTED from the latest review per author', () => {
  // No reviews → undefined (not blocking).
  assert.equal(deriveReviewDecision([]), undefined);

  // A later APPROVED supersedes an earlier CHANGES_REQUESTED from the same author.
  assert.equal(deriveReviewDecision([
    { author: { login: 'coderabbitai[bot]' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-10T00:00:00Z' },
    { author: { login: 'coderabbitai[bot]' }, state: 'APPROVED', submitted_at: '2026-06-11T00:00:00Z' },
  ]), undefined);

  // An outstanding CHANGES_REQUESTED (the author's latest) blocks.
  assert.equal(deriveReviewDecision([
    { author: { login: 'willwashburn' }, state: 'APPROVED', submitted_at: '2026-06-10T00:00:00Z' },
    { author: { login: 'coderabbitai[bot]' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-06-11T00:00:00Z' },
  ]), 'CHANGES_REQUESTED');
});

test('parseSlackMergeRequest extracts a GitHub PR URL from merge requests', () => {
  assert.deepEqual(parseSlackMergeRequest('<@Ubot> please merge https://github.com/AgentWorkforce/relayfile-adapters/pull/158'), {
    pr: {
      owner: 'AgentWorkforce',
      repo: 'relayfile-adapters',
      number: 158,
      url: 'https://github.com/AgentWorkforce/relayfile-adapters/pull/158',
      author: 'unknown',
    },
  });
  assert.equal(parseSlackMergeRequest('can you review https://github.com/AgentWorkforce/agents/pull/1'), null);
  assert.equal(parseSlackMergeRequest('please merge https://github.com/AgentWorkforce/agents/pull/1'), null);
});

test('handleSlackMergeRequest replies with blockers when Slack asks to merge a red PR', async () => {
  const replies = [];
  const ctx = {
    persona: {
      inputSpecs: { SLACK_CHANNEL: { env: '__TEST_SLACK_CHANNEL__' } },
      inputs: { SLACK_CHANNEL: 'C123' },
    },
    sandbox: { cwd: '/tmp' },
    log() {},
  };
  const slack = {
    async post() { throw new Error('should reply in thread'); },
    async reply(channel, threadTs, text) {
      replies.push({ channel, threadTs, text });
      return { channel, ts: 'reply-ts' };
    },
  };

  await handleSlackMergeRequest(
    ctx,
    {
      channel: 'C123',
      ts: '1000.0001',
      text: '<@Ubot> please merge https://github.com/AgentWorkforce/cloud/pull/2060',
      is_bot: false,
    },
    slack,
    async (_ctx, pr) => ({
      outcome: 'blocked',
      pr,
      reasons: ['check "unit" is not passing (COMPLETED/FAILURE)', 'bot @coderabbitai[bot] has not approved yet'],
    }),
  );

  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], {
    channel: 'C123',
    threadTs: '1000.0001',
    text: 'I cannot merge AgentWorkforce/cloud#2060 yet: check "unit" is not passing (COMPLETED/FAILURE); bot @coderabbitai[bot] has not approved yet.',
  });
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
  // Verification moved to the repo's own CI, so the guarantee is no longer
  // "the build passed here" but "the agent did not edit what it cannot see".
  // Generated artifacts and cross-package importers are the blast radius that
  // used to be caught by the full build, so they must now be named explicitly
  // as suggest-don't-edit territory.
  assert.match(prompt, /Verification is delegated to the repo's own/);
  assert.doesNotMatch(prompt, /canonical build and test command end to end/);
  assert.match(prompt, /generated\/committed artifact/);
  assert.match(prompt, /raise them as suggestions rather than editing blind/);
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

// Slack writebacks use bare channel ids while trigger paths can include
// display-labelled channel records. Keep an explicit scope covering the
// `/slack/channels/{channelId}/messages` writeback path. This pins both halves.
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

// Exit 137 (128+SIGKILL) is the sandbox OOM-killing the harness on a large
// checkout; 143 is SIGTERM. Neither is a review verdict, and both wasted the
// whole run, so one retry is worth it. A real non-zero harness exit must NOT
// retry: the first pass may already have pushed mechanical fix commits.
test('runReviewHarnessWithRetry: retries once on an infra kill and succeeds', async () => {
  const codes = [137, 0];
  let calls = 0;
  const retried = [];
  const outcome = await runReviewHarnessWithRetry(
    async () => ({ exitCode: codes[calls++], output: 'review body' }),
    { onRetry: (code) => retried.push(code) },
  );
  assert.equal(calls, 2);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.infraKill, false);
  assert.deepEqual(retried, [137]);
  assert.equal(outcome.run.output, 'review body');
});

test('runReviewHarnessWithRetry: reports an infra kill when the retry is killed too', async () => {
  let calls = 0;
  const outcome = await runReviewHarnessWithRetry(async () => {
    calls += 1;
    return { exitCode: 143 };
  });
  assert.equal(calls, 2);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.infraKill, true);
  assert.equal(outcome.exitCode, 143);
});

test('runReviewHarnessWithRetry: does NOT retry a genuine harness failure', async () => {
  let calls = 0;
  const outcome = await runReviewHarnessWithRetry(async () => {
    calls += 1;
    return { exitCode: 1 };
  });
  assert.equal(calls, 1, 'a real failure must not re-run work that may have pushed commits');
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.infraKill, false);
});

test('runReviewHarnessWithRetry: does not retry a clean run', async () => {
  let calls = 0;
  const outcome = await runReviewHarnessWithRetry(async () => {
    calls += 1;
    return { exitCode: 0 };
  });
  assert.equal(calls, 1);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.infraKill, false);
});

test('harnessExitCode / isInfraKillExitCode classify exit codes', () => {
  assert.equal(harnessExitCode({ exitCode: 137 }), 137);
  assert.equal(harnessExitCode({}), null, 'a missing exit code is unknown, not zero');
  assert.equal(harnessExitCode({ exitCode: 'nope' }), null);
  assert.equal(isInfraKillExitCode(137), true);
  assert.equal(isInfraKillExitCode(143), true);
  assert.equal(isInfraKillExitCode(1), false);
  assert.equal(isInfraKillExitCode(0), false);
  assert.equal(isInfraKillExitCode(null), false);
});

// Verification is delegated to the repo's own CI. Nothing is installed, built
// or tested in the sandbox — that work is what exhausted an 8 GiB box on a
// large repo, and the repo's CI is sized for the repo in a way ours cannot be.
test('reviewHarnessPrompt delegates verification to CI and narrows what may be edited', () => {
  const prompt = reviewHarnessPrompt({ owner: 'wepost-no', repo: 'wepost-saga', number: 5020 });
  // No install/build/test in the sandbox: that was the OOM, and the repo's own
  // CI is sized for the repo in a way our box can never be.
  assert.match(prompt, /Do NOT install dependencies, build the repo, or run its test suite/);
  assert.doesNotMatch(prompt, /Run the repo's canonical build and test command end to end/);

  // Delegating verification must NARROW what the agent edits, not widen it —
  // otherwise this is just unverified pushing, which broke three PRs in a day
  // the last time it happened.
  assert.match(prompt, /justify it\s+by READING the code/);
  assert.match(prompt, /would require a build or test run.*do NOT make it/s);
  assert.match(prompt, /a\s+guess pushed to someone's PR is worse than a comment/);
});

test('harnessOutputTail keeps the END of the output and drops empties', () => {
  // An OOM stack is the LAST thing written, so a head-truncation would discard
  // exactly the evidence this exists to capture.
  assert.equal(harnessOutputTail('abcdef', 3), 'def');
  assert.equal(harnessOutputTail('short'), 'short');
  assert.equal(harnessOutputTail('   '), undefined);
  assert.equal(harnessOutputTail(undefined), undefined);
  assert.equal(harnessOutputTail(12345), undefined);
});

test('logHarnessFailureDiagnostics records stderr, output and duration on a kill', () => {
  const logged = [];
  const ctx = { log: (level, message, fields) => logged.push({ level, message, fields }) };
  const pr = { owner: 'wepost-no', repo: 'wepost-saga', number: 5020 };

  logHarnessFailureDiagnostics(ctx, pr, {
    output: 'FATAL ERROR: JavaScript heap out of memory',
    stderr: 'Aborted (core dumped)',
    durationMs: 366_000,
  }, 137);

  assert.equal(logged.length, 1);
  const { level, fields } = logged[0];
  assert.equal(level, 'error');
  assert.equal(fields.exitCode, 137);
  assert.equal(fields.infraKill, true, '137 must be classified as an infra kill');
  assert.equal(fields.durationMs, 366_000);
  assert.match(fields.outputTail, /heap out of memory/);
  assert.match(fields.stderrTail, /Aborted/);
  assert.equal(fields.number, 5020);
});

test('logHarnessFailureDiagnostics survives a harness result with nothing in it', () => {
  const logged = [];
  const ctx = { log: (level, message, fields) => logged.push({ level, message, fields }) };
  // A SIGKILLed process often flushes nothing at all; the diagnostics call must
  // still record the exit code and classification rather than throwing.
  logHarnessFailureDiagnostics(ctx, { owner: 'o', repo: 'r', number: 1 }, {}, 1);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].fields.exitCode, 1);
  assert.equal(logged[0].fields.infraKill, false);
  assert.equal(logged[0].fields.outputTail, undefined);
});

test('the harness heap cap stays BELOW the sandbox memory ceiling', () => {
  // Daytona's hard per-sandbox maximum is 8 GiB and the snapshot already bakes
  // it; a bake above it is rejected. The V8 cap only converts a SIGKILL into a
  // readable heap error while it sits under the cgroup limit — raise it above
  // and the kernel wins the race again, which is the bug this guards.
  const SANDBOX_MEMORY_MIB = 8 * 1024;
  const heap = /--max-old-space-size=(\d+)/.exec(HARNESS_RESOURCE_ENV.NODE_OPTIONS);
  assert.ok(heap, 'NODE_OPTIONS must pin a V8 heap cap');
  const heapMib = Number(heap[1]);
  assert.ok(heapMib < SANDBOX_MEMORY_MIB, `heap cap ${heapMib}MiB must stay under the ${SANDBOX_MEMORY_MIB}MiB box`);
  // Room for the harness, the mount sidecar and the OS alongside it.
  assert.ok(heapMib <= SANDBOX_MEMORY_MIB - 2048, 'leave at least 2 GiB for the harness, mount sidecar and OS');

  // One worker per runner: 4 CPUs would otherwise multiply the peak by four.
  for (const key of ['VITEST_MAX_THREADS', 'TURBO_CONCURRENCY', 'JEST_MAX_WORKERS']) {
    assert.equal(HARNESS_RESOURCE_ENV[key], '1', `${key} must pin serial execution`);
  }
});

test('runReviewHarnessWithRetry: reports the FINAL failed attempt for diagnostics', async () => {
  // Guards the wiring, not just the helper: without this, the diagnostics call
  // can be deleted from the failure path and every other test still passes —
  // which is exactly how the original run reached us with no captured cause.
  const failures = [];
  await runReviewHarnessWithRetry(
    async () => ({ exitCode: 137, output: 'FATAL ERROR: JavaScript heap out of memory' }),
    { onFailure: (run, code) => failures.push({ code, output: run.output }) },
  );
  assert.equal(failures.length, 1, 'one report for the final attempt, not one per attempt');
  assert.equal(failures[0].code, 137);
  assert.match(failures[0].output, /heap out of memory/);

  const clean = [];
  await runReviewHarnessWithRetry(
    async () => ({ exitCode: 0 }),
    { onFailure: (run, code) => clean.push(code) },
  );
  assert.deepEqual(clean, [], 'a clean run reports no failure');
});

// Verification now happens in the repo's CI, so the agent learns about its own
// breakage from a red check. That is only actionable if it can tell its own
// regression from a failure that was already there.
test('attributeCiFailure: no edits from us means it cannot be ours', () => {
  assert.equal(attributeCiFailure({
    priorCiFailing: false, priorHeadSha: 'a', currentHeadSha: 'b', leftEdits: false,
  }), 'pre-existing');
});

test('attributeCiFailure: already red before we touched it is pre-existing', () => {
  assert.equal(attributeCiFailure({
    priorCiFailing: true, priorHeadSha: 'a', currentHeadSha: 'b', leftEdits: true,
  }), 'pre-existing');
});

test('attributeCiFailure: green before, head moved after our edits, is ours', () => {
  assert.equal(attributeCiFailure({
    priorCiFailing: false, priorHeadSha: 'a', currentHeadSha: 'b', leftEdits: true,
  }), 'ours');
});

test('attributeCiFailure: unknown when we never observed CI, or the head never moved', () => {
  // Never observed: claiming either way would be a guess.
  assert.equal(attributeCiFailure({
    priorCiFailing: null, priorHeadSha: null, currentHeadSha: 'b', leftEdits: true,
  }), 'unknown');
  // Head unchanged: our edits were never pushed, so this red is not from them.
  assert.equal(attributeCiFailure({
    priorCiFailing: false, priorHeadSha: 'a', currentHeadSha: 'a', leftEdits: true,
  }), 'unknown');
});

test('reviewHarnessPrompt steers differently on our regression vs a pre-existing one', () => {
  const pr = { owner: 'wepost-no', repo: 'wepost-saga', number: 5020 };

  const ours = reviewHarnessPrompt(pr, { failing: true, attribution: 'ours' });
  assert.match(ours, /treat it as YOUR regression/);

  // A pre-existing red must NOT become the agent's job — silently fixing
  // unrelated CI is the scope creep the rest of this prompt forbids.
  const pre = reviewHarnessPrompt(pr, { failing: true, attribution: 'pre-existing' });
  assert.match(pre, /it is NOT your regression/);
  assert.doesNotMatch(pre, /treat it as YOUR regression/);

  const unknown = reviewHarnessPrompt(pr, { failing: true, attribution: 'unknown' });
  assert.match(unknown, /cannot tell whether its own edits caused it/);

  // Green CI adds no attribution noise at all.
  assert.doesNotMatch(reviewHarnessPrompt(pr, { failing: false, attribution: 'unknown' }), /CI is RED/);
  assert.doesNotMatch(reviewHarnessPrompt(pr), /CI is RED/);
});

// readPr previously read only check_run.pull_requests[0].head_sha. Real GitHub
// check_run payloads nest it as head.sha (PullRequestMinimal) and also carry
// check_run.head_sha, so headSha came back undefined for every production
// check_run event — and attribution can never say "ours" without a head to
// compare, which silently disabled the whole CI-ownership path.
test('readPr reads the head sha GitHub actually sends on check_run', () => {
  const base = { repository: { name: 'wepost-saga', owner: { login: 'wepost-no' } } };

  const nested = readPr({
    ...base,
    check_run: { head_sha: 'sha-from-check', pull_requests: [{ number: 5020, head: { sha: 'sha-from-pr' } }] },
  });
  assert.equal(nested?.headSha, 'sha-from-pr', 'the PR entry is more specific than the check');

  // check_run.head_sha alone still resolves.
  const runOnly = readPr({ ...base, check_run: { head_sha: 'sha-from-check', pull_requests: [{ number: 5020 }] } });
  assert.equal(runOnly?.headSha, 'sha-from-check');

  // The legacy flat shape keeps working.
  const flat = readPr({ ...base, check_run: { pull_requests: [{ number: 5020, head_sha: 'sha-flat' }] } });
  assert.equal(flat?.headSha, 'sha-flat');
});

// The prompt asks the harness to read the failing check's output, but the
// harness has no gh, no build and no tests — so the output has to be handed to
// it or the instruction is unfollowable.
test('readFailingCheck extracts the diagnostic from the payload', () => {
  const check = readFailingCheck({
    check_run: {
      name: 'typecheck', conclusion: 'failure', details_url: 'https://ci.example/1',
      output: { summary: 'tsc failed', text: 'src/a.ts(3,1): error TS2322' },
    },
  });
  assert.equal(check?.name, 'typecheck');
  assert.equal(check?.conclusion, 'failure');
  assert.match(check?.text, /TS2322/);
  assert.equal(readFailingCheck({}), undefined);
  assert.equal(readFailingCheck({ check_run: { name: '   ' } }), undefined, 'blank fields are not a diagnostic');
});

test('failingCheckGuidance surfaces the output and bounds it', () => {
  const lines = failingCheckGuidance({ name: 'build', conclusion: 'failure', summary: 'boom', detailsUrl: 'https://ci/x' }).join('\n');
  assert.match(lines, /The failing check is build \(failure\)/);
  assert.match(lines, /boom/);
  assert.match(lines, /you cannot open it/);

  // A huge log must not crowd the instructions out of the prompt.
  const big = failingCheckGuidance({ name: 'test', summary: 'x'.repeat(9000) }, 100).join('\n');
  assert.match(big, /truncated/);
  assert.ok(big.length < 1000);

  // No output at all must be stated, not invented around.
  assert.match(failingCheckGuidance({ name: 'lint' }).join('\n'), /reported no output/);
  assert.deepEqual(failingCheckGuidance(undefined), []);
});

// One unsuccessful fix-forward must not hand our own regression back to the
// author: the repair pass records ciFailing:true, so without sticky ownership
// the next failure reads as pre-existing.
test('attributeCiFailure: ownership survives a failed repair pass', () => {
  assert.equal(attributeCiFailure({
    priorCiFailing: true, priorHeadSha: 'b', currentHeadSha: 'c',
    leftEdits: true, priorOwnedRegression: true,
  }), 'ours');

  // Sticky even when nothing new was pushed.
  assert.equal(attributeCiFailure({
    priorCiFailing: true, priorHeadSha: 'b', currentHeadSha: 'b',
    leftEdits: false, priorOwnedRegression: true,
  }), 'ours');

  // Without ownership the same inputs are correctly pre-existing.
  assert.equal(attributeCiFailure({
    priorCiFailing: true, priorHeadSha: 'b', currentHeadSha: 'c',
    leftEdits: true, priorOwnedRegression: false,
  }), 'pre-existing');
});

test('reviewHarnessPrompt includes the failing check output when CI is red', () => {
  const pr = { owner: 'wepost-no', repo: 'wepost-saga', number: 5020 };
  const withCheck = reviewHarnessPrompt(pr, {
    failing: true, attribution: 'ours',
    check: { name: 'typecheck', summary: 'src/a.ts(3,1): error TS2322' },
  });
  assert.match(withCheck, /TS2322/);
  assert.match(withCheck, /FAILING_CHECK_OUTPUT/);

  // Green CI carries no check block at all.
  assert.doesNotMatch(reviewHarnessPrompt(pr), /FAILING_CHECK_OUTPUT/);
});

test('ciObservationFor records ownership only while CI is red and ours', () => {
  const pr = { owner: 'wepost-no', repo: 'wepost-saga', number: 5020, headSha: 'abc' };

  // Our regression: remembered, so a failed repair does not lose provenance.
  assert.equal(ciObservationFor(pr, { failing: true, attribution: 'ours' }).ownedRegression, true);

  // Someone else's red is never adopted.
  assert.equal(ciObservationFor(pr, { failing: true, attribution: 'pre-existing' }).ownedRegression, false);
  assert.equal(ciObservationFor(pr, { failing: true, attribution: 'unknown' }).ownedRegression, false);

  // Green clears ownership — this is the only thing that does.
  assert.equal(ciObservationFor(pr, { failing: false, attribution: 'ours' }).ownedRegression, false);

  const obs = ciObservationFor(pr, { failing: true, attribution: 'ours' });
  assert.equal(obs.headSha, 'abc');
  assert.equal(obs.ciFailing, true);
  assert.equal(obs.leftEdits, true, 'upper bound: the agent cannot see the push outcome');
  assert.equal(ciObservationFor({ ...pr, headSha: undefined }, { failing: false, attribution: 'unknown' }).headSha, null);
});
