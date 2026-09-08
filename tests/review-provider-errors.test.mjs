import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import agent from '../.test-build/review/agent.js';
import { describeHarnessFailure } from '../.test-build/review/lib/harness-failure.js';

async function answerDraft(root, relative = 'github/repos/example/project/issues/42/comments') {
  const dir = path.join(root, relative);
  for (let attempt = 0; attempt < 300; attempt++) {
    const files = await readdir(dir).catch(() => []);
    const draft = files.find((file) => file.endsWith('.json'));
    if (draft) {
      const file = path.join(dir, draft);
      const payload = JSON.parse(await readFile(file, 'utf8'));
      await writeFile(file, JSON.stringify({ created: '1700000000.000001' }));
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected a failure notice draft in ${relative}`);
}

for (const conflict of [false, true]) {
  test(`${conflict ? 'conflict resolution' : 'review'} surfaces quota/reset safely without retrying or posting partial output`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-provider-error-'));
    const names = ['RELAYFILE_MOUNT_PATH', 'RELAYFILE_MOUNT_ROOT', 'WORKSPACE_ROOT', 'SLACK_CHANNEL'];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let calls = 0;
    const logs = [];
    try {
      process.env.RELAYFILE_MOUNT_PATH = root;
      process.env.RELAYFILE_MOUNT_ROOT = root;
      delete process.env.WORKSPACE_ROOT;
      process.env.SLACK_CHANNEL = 'C-test-alerts';
      const ctx = {
        sandbox: { cwd: root },
        persona: { inputs: { SLACK_CHANNEL: 'C-test-alerts' }, inputSpecs: { SLACK_CHANNEL: { env: 'SLACK_CHANNEL' } } },
        memory: { save: async () => ({}), recall: async () => [] },
        log: (level, message, fields) => logs.push({ level, message, fields }),
        harness: { run: async () => {
          calls++;
          return {
            exitCode: 1,
            output: "You've hit your limit · resets 3:40pm (UTC)",
            stderr: 'sensitive-stack secret-fixture-value partial-review-fixture',
            durationMs: 1900,
          };
        } },
      };
      const pr = { number: 42, state: 'open', user: { login: 'author' }, html_url: 'https://github.com/example/project/pull/42' };
      const event = {
        type: conflict ? 'github.issue_comment.created' : 'github.pull_request.opened',
        expand: async () => ({ data: {
          repository: { name: 'project', owner: { login: 'example' } },
          pull_request: pr,
          ...(conflict ? { issue: { ...pr, pull_request: {} }, comment: { body: '@relay fix conflicts', user: { login: 'author' } } } : {}),
        } }),
      };
      const [result, receipt, slack] = await Promise.allSettled([
        agent.handler(ctx, event), answerDraft(root), answerDraft(root, 'slack/channels/C-test-alerts/messages'),
      ]);
      assert.equal(receipt.status, 'fulfilled', receipt.reason?.message);
      assert.equal(result.status, 'rejected');
      const body = receipt.value.body;
      assert.match(body, /Claude account.*usage limit/);
      assert.match(body, /3:40pm \(UTC\)/);
      assert.match(body, /Wait for.*reset/);
      assert.doesNotMatch(body, /secret-fixture|sensitive-stack|partial-review-fixture|exited with code 1/);
      assert.match(result.reason.message, /Claude account.*usage limit/);
      assert.equal(slack.status, 'fulfilled', slack.reason?.message);
      assert.match(slack.value.text, /Claude account.*usage limit/);
      assert.match(slack.value.text, /3:40pm \(UTC\)/);
      assert.doesNotMatch(slack.value.text, /secret-fixture|sensitive-stack|partial-review-fixture/);
      assert.equal(calls, 1);
      const files = await readdir(path.join(root, 'github/repos/example/project/issues/42/comments'));
      assert.equal(files.length, 1, 'only the failure notice is posted');
      assert.ok(logs.some((entry) => entry.fields?.failureKind === 'usage_limit'));
    } finally {
      for (const name of names) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('provider error classification uses safe templates and distinguishes causes', () => {
  const cases = [
    ['API Error: 429 request throttled', 'rate_limit', /rate-limited/],
    ['{"error":{"type":"rate_limit_error","message":"private detail"}}', 'rate_limit', /available capacity/],
    ['{"error":{"code":"insufficient_quota"}}', 'usage_limit', /quota or credits/],
    ['Your credit balance is too low to access the Anthropic API.', 'usage_limit', /billing/],
    ['API Error: 401 private detail', 'authentication', /reconnect the AI account/],
    ['{"error":{"type":"authentication_error"}}', 'authentication', /credentials/],
    ['OAuth token has expired.', 'authentication', /reconnect/],
    ['Invalid API key · Please run /login', 'authentication', /reconnect/],
    ['Prompt is too long: private detail', 'context_limit', /context limit/],
    ['{"error":{"code":"context_length_exceeded"}}', 'context_limit', /smaller review scope/],
    ['API Error: 400 {"error":{"type":"invalid_request_error","message":"prompt is too long: private detail"}}', 'context_limit', /context limit/],
    ['API Error: Request timed out.', 'timeout', /timed out/],
    ['API Error: 529 private detail', 'provider_unavailable', /provider recovers/],
    ['{"error":{"type":"overloaded_error"}}', 'provider_unavailable', /could not serve/],
  ];
  for (const [stderr, kind, message] of cases) {
    const failure = describeHarnessFailure({ stderr, output: 'unfinished-review-fixture secret-fixture' }, 1);
    assert.equal(failure.kind, kind, stderr);
    assert.match(failure.message, message);
    assert.doesNotMatch(failure.message, /private detail|unfinished-review-fixture|secret-fixture/);
  }
});

test('quota reset hints preserve explicit timezone and reject arbitrary text', () => {
  const failure = describeHarnessFailure({ output: "\x1b[31mYou’ve hit your limit · resets 3:40pm (UTC)\x1b[0m\nprivate detail" }, 1);
  assert.equal(failure.kind, 'usage_limit');
  assert.equal(failure.resetHint, '3:40pm (UTC)');
  for (const suffix of ['resets soon secret-fixture', 'resets 3:40pm', 'resets 99:99pm (UTC)', 'resets 3:40pm (secret-fixture)', 'resets 3:40pm (UTC)[secret-fixture]']) {
    const result = describeHarnessFailure({ output: `You've hit your limit · ${suffix}` }, 1);
    assert.equal(result.kind, 'usage_limit');
    assert.equal(result.resetHint, undefined, suffix);
    assert.doesNotMatch(result.message, /secret-fixture|99:99|3:40/);
  }
});

test('unknown harness and GitHub failures are not guessed to be AI quota failures', () => {
  for (const run of [null, {}, { stderr: 429 }, { stderr: 'gh: HTTP 429 Too Many Requests' }, { output: 'a test failed with exit 1' }, { stderr: 'ECONNRESET secret-fixture' }]) {
    const failure = describeHarnessFailure(run, 1);
    assert.equal(failure.kind, 'unknown');
    assert.match(failure.message, /captured harness diagnostics/);
    assert.doesNotMatch(failure.message, /secret-fixture|usage limit|AI provider/);
  }
});
