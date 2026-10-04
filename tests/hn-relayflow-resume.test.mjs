import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { JsonFileWorkflowDb, workflow } from '@relayflows/core';
import { SCHEDULED_DIGEST_COMPLETION_TIMEOUT_MS } from '../.test-build/hn-monitor/agent.js';
import {
  buildPersistedAgentJsonCommand,
  reactivateInvalidArtifactV1Steps,
  reactivateSkippedV1Steps,
  runScheduledDigestWorkflow,
  scheduledDigestJournalWorkflowName,
  scheduledDigestWorkflowSource,
  SCHEDULED_DIGEST_WORKFLOW_NAME,
  SCHEDULED_DIGEST_WORKFLOW_TIMEOUT_MS,
} from '../.test-build/hn-monitor/workflows/scheduled-digest.js';

const execFileAsync = promisify(execFile);

function resumeFixture() {
  return workflow('hn-monitor-v1-resume-fixture')
    .pattern('pipeline')
    .step('prepare-input', {
      type: 'deterministic',
      command: [
        'set -eu',
        'if test -f prepare-once; then touch prepare-replayed; exit 91; fi',
        'touch prepare-once',
        "printf 'prepared\\n'",
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('analyze-stories', {
      type: 'deterministic',
      dependsOn: ['prepare-input'],
      command: [
        'set -eu',
        'if test ! -f resume-ready; then touch resume-ready; exit 2; fi',
        "printf 'resumed analysis\\n'",
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
    })
    .step('validate-digest', {
      type: 'deterministic',
      dependsOn: ['analyze-stories'],
      command: "printf 'HN_DIGEST_NOTES_JSON:{\"theme\":\"fixture\",\"stories\":[]}\\n'",
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'HN_DIGEST_NOTES_JSON:' },
    })
    .onError('fail-fast', { maxRetries: 0 });
}

function invalidArtifactRecoveryFixture() {
  const batchKey = 'hn-monitor:v1:20';
  const candidateValidator = buildPersistedAgentJsonCommand({
    sourceStep: 'analyze-stories',
    sourceMarker: 'HN_CANDIDATE_JSON:',
    batchKey,
    expectedIds: [20],
    successMarker: 'HN_CANDIDATE_VALIDATED',
  });
  const digestValidator = buildPersistedAgentJsonCommand({
    sourceStep: 'review-digest',
    sourceMarker: 'HN_REVIEWED_DIGEST_JSON:',
    batchKey,
    expectedIds: [20],
    successMarker: 'HN_DIGEST_NOTES_JSON:',
    emitDigest: true,
  });
  return workflow('hn-monitor-v1-artifact-recovery-fixture')
    .pattern('pipeline')
    .step('prepare-input', {
      type: 'deterministic',
      command: 'if test -f prepare-once; then touch prepare-replayed; exit 91; fi\ntouch prepare-once',
      captureOutput: true,
      failOnError: true,
    })
    .step('analyze-stories', {
      type: 'deterministic',
      dependsOn: ['prepare-input'],
      command: [
        'if test ! -f analyze-attempted; then',
        '  touch analyze-attempted',
        `  printf '%s\\n' 'HN_CANDIDATE_JSON:{"batchKey":"${batchKey}",'`,
        'else',
        `  printf '%s\\n' 'HN_CANDIDATE_JSON:{"batchKey":"${batchKey}","theme":"recovered","stories":[{"id":20,"why":"valid retry"}]}'`,
        'fi',
      ].join('\n'),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'HN_CANDIDATE_JSON:' },
    })
    .step('validate-candidate', {
      type: 'deterministic',
      dependsOn: ['analyze-stories'],
      command: candidateValidator,
      captureOutput: true,
      failOnError: true,
    })
    .step('review-digest', {
      type: 'deterministic',
      dependsOn: ['validate-candidate'],
      command: `printf '%s\\n' 'HN_REVIEWED_DIGEST_JSON:{"batchKey":"${batchKey}","theme":"reviewed","stories":[{"id":20,"why":"validated"}]}'`,
      captureOutput: true,
      failOnError: true,
    })
    .step('validate-digest', {
      type: 'deterministic',
      dependsOn: ['review-digest'],
      command: digestValidator,
      captureOutput: true,
      failOnError: true,
    })
    .onError('fail-fast', { maxRetries: 0 });
}

test('production resume guard uses the exact workflow name journaled by pinned Relayflow v1', () => {
  const config = workflow(SCHEDULED_DIGEST_WORKFLOW_NAME)
    .step('name-contract', { type: 'deterministic', command: 'true' })
    .toConfig();
  const actualJournalName = config.workflows?.[0]?.name;

  assert.equal(actualJournalName, scheduledDigestJournalWorkflowName(SCHEDULED_DIGEST_WORKFLOW_NAME));
});

test('production Relayflow budget covers core v1 transient replays and caller overhead', async () => {
  const source = scheduledDigestWorkflowSource();
  assert.equal(SCHEDULED_DIGEST_WORKFLOW_TIMEOUT_MS, 480_000);
  assert.equal(SCHEDULED_DIGEST_COMPLETION_TIMEOUT_MS, 510_000);
  // Focused tests use esbuild (`48e4`); the repository suite uses tsc
  // (`480_000`). Pin the emitted program as well as its exported constants so
  // materialization cannot silently drop the workflow-level timeout.
  assert.match(source, /const WORKFLOW_TIMEOUT_MS = (?:48e4|480_000);/u);
  assert.match(source, /\.timeout\(WORKFLOW_TIMEOUT_MS\)/u);
});

test('production Relayflow hands non-interactive agent output to deterministic artifact validators', () => {
  const source = scheduledDigestWorkflowSource();

  assert.match(source, /HN_CANDIDATE_JSON:/u);
  assert.match(source, /HN_REVIEWED_DIGEST_JSON:/u);
  assert.match(source, /\.step\(["']validate-candidate["']/u);
  assert.match(source, /sourceName = sourceStep \+ ["']\.md["']/u);
  assert.match(source, /AGENT_RELAY_RUN_ID_FILE/u);
  assert.match(source, /step-outputs["'], runId, sourceName/u);
  assert.match(source, /expected exactly one/u);
  assert.doesNotMatch(source, /verification:\s*\{ type: ["']file_exists["'], value: (?:candidatePath|digestPath) \}/u);
  assert.match(source, /\{\{steps\.validate-candidate\.output\}\}/u,
    'the validated candidate may be passed as prompt data to the reviewer');
  assert.doesNotMatch(buildPersistedAgentJsonCommand({
    sourceStep: 'analyze-stories',
    sourceMarker: 'HN_CANDIDATE_JSON:',
    batchKey: 'hn-monitor:v1:20',
    expectedIds: [20],
    successMarker: 'HN_CANDIDATE_VALIDATED',
  }), /\{\{steps\./u, 'untrusted model output must never be shell-interpolated');
});

test('persisted stdout materialization validates JSON without shell-interpolating model output', async () => {
  const runtimeDir = await mkdtemp(path.resolve('.hn-relayflow-handoff-'));
  const runId = '111111111111111111111111';
  const outputDir = path.join(runtimeDir, '.agent-relay', 'step-outputs', runId);
  const runIdFile = path.join(runtimeDir, 'current-run-id');
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, 'analyze-stories.md'),
      [
        'curator preface',
        `HN_CANDIDATE_JSON:${JSON.stringify({
          batchKey: 'hn-monitor:v1:20',
          theme: 'Safe persisted handoff',
          stories: [{ id: 20, why: 'Literal $(touch should-not-exist) stays data.' }],
        })}`,
        'OWNER_DECISION: COMPLETE',
      ].join('\n'),
    );
    const decoyDir = path.join(runtimeDir, '.agent-relay', 'step-outputs', '222222222222222222222222');
    await mkdir(decoyDir, { recursive: true });
    await writeFile(path.join(decoyDir, 'analyze-stories.md'), 'HN_CANDIDATE_JSON:{"batchKey":"wrong"}\n');
    await writeFile(runIdFile, `${runId}\n`);

    const command = buildPersistedAgentJsonCommand({
      sourceStep: 'analyze-stories',
      sourceMarker: 'HN_CANDIDATE_JSON:',
      batchKey: 'hn-monitor:v1:20',
      expectedIds: [20],
      successMarker: 'HN_CANDIDATE_VALIDATED',
    });
    const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
      cwd: runtimeDir,
      env: { ...process.env, AGENT_RELAY_RUN_ID_FILE: runIdFile },
    });

    assert.equal(
      stdout,
      'HN_CANDIDATE_VALIDATED{"batchKey":"hn-monitor:v1:20","theme":"Safe persisted handoff","stories":[{"id":20,"why":"Literal $(touch should-not-exist) stays data."}]}\n',
    );
    assert.equal(existsSync(path.join(runtimeDir, 'should-not-exist')), false);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('production Relayflow runner uses sandbox-local Agent Relay without a hosted workflow allocation', async () => {
  const writes = [];
  const execs = [];
  const args = {
    relayflowVersion: 'v1',
    batchKey: 'hn-monitor:v1:20',
    stories: [{
      id: 20,
      title: 'Local RelayFlow in one sandbox',
      category: 'agent infrastructure',
      points: 100,
      comments: 20,
      feeds: ['show_hn'],
      url: 'https://example.com/20',
      hnUrl: 'https://news.ycombinator.com/item?id=20',
    }],
  };
  const ctx = {
    sandbox: {
      cwd: '/workspace',
      async writeFile(filePath, contents) { writes.push({ filePath, contents }); },
      async exec(command, options) {
        execs.push({ command, options });
        return {
          exitCode: 0,
          output: 'HN_DIGEST_NOTES_JSON:{"theme":"local","stories":[{"id":20,"why":"same sandbox"}]}\nHN_RELAYFLOW_RUN_ID:run-local-20\n',
        };
      },
    },
  };

  const result = await runScheduledDigestWorkflow(ctx, args);
  assert.equal(result.runId, 'run-local-20');
  assert.equal(writes.length, 1);
  assert.match(writes[0].filePath, /\.agentworkforce\/hn-monitor\/workflows\/hn-monitor-scheduled-digest-v1\.ts$/u);
  assert.match(writes[0].contents, /from '@relayflows\/core'/u);
  assert.equal(execs.length, 1);
  assert.match(execs[0].command, /command -v agent-relay/u);
  assert.match(execs[0].command, /createRequire\(anchor\)/u);
  assert.match(execs[0].command, /node --experimental-strip-types/u);
  assert.doesNotMatch(execs[0].command, /ctx\.workflow|daytona\s+(?:create|run)|e2b\s+(?:create|run)/u);
  const syntax = spawnSync('/bin/sh', ['-n'], { input: execs[0].command, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.equal(execs[0].options.cwd, '/workspace');
  assert.deepEqual(JSON.parse(execs[0].options.env.invocationArgs), args);
});

test('materialized production Relayflow source validates its five-step least-privilege plan locally', async () => {
  const runtimeDir = await mkdtemp(path.resolve('.hn-relayflow-local-'));
  try {
    await writeFile(path.join(runtimeDir, 'unrelated-cloud-credential.txt'), 'must-not-be-readable');
    const invocationArgs = {
      relayflowVersion: 'v1',
      batchKey: 'hn-monitor:v1:20',
      stories: [{
        id: 20,
        title: 'Local RelayFlow in one sandbox',
        category: 'agent infrastructure',
        points: 100,
        comments: 20,
        feeds: ['show_hn'],
        url: 'https://example.com/20',
        hnUrl: 'https://news.ycombinator.com/item?id=20',
      }],
    };
    const workflowPath = path.join(runtimeDir, 'scheduled-digest.ts');
    await writeFile(workflowPath, scheduledDigestWorkflowSource());
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', workflowPath],
      {
        cwd: runtimeDir,
        env: { ...process.env, invocationArgs: JSON.stringify(invocationArgs), DRY_RUN: 'true' },
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    assert.match(stdout, /HN_RELAYFLOW_RUN_ID:dry-run/u);
    const dryRunLine = stdout.split('\n').find((line) => line.startsWith('HN_RELAYFLOW_DRY_RUN:'));
    assert.ok(dryRunLine);
    const report = JSON.parse(dryRunLine.slice('HN_RELAYFLOW_DRY_RUN:'.length));
    assert.equal(report.name, 'hn-monitor-scheduled-digest-v1-workflow');
    assert.equal(report.stepCount, 5);
    assert.deepEqual(
      report.permissions.map(({ agent, access, readPaths, writePaths }) => ({ agent, access, readPaths, writePaths })),
      [
        { agent: 'curator', access: 'restricted', readPaths: 1, writePaths: 0 },
        { agent: 'reviewer', access: 'restricted', readPaths: 1, writePaths: 0 },
      ],
    );
    assert.ok(report.permissions.every((permission) => permission.denyPaths > 0));
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('pinned Relayflow v1 resumes a failed run without replaying completed HN step identities', async () => {
  const runtimeDir = await mkdtemp(path.resolve('.hn-relayflow-resume-'));
  const previousResumeRunId = process.env.RESUME_RUN_ID;
  try {
    delete process.env.RESUME_RUN_ID;
    const first = await resumeFixture().run({ cwd: runtimeDir, renderer: false });
    assert.equal(first.status, 'failed');
    assert.ok(existsSync(path.join(runtimeDir, 'prepare-once')));
    assert.ok(existsSync(path.join(runtimeDir, 'resume-ready')));

    process.env.RESUME_RUN_ID = first.id;
    assert.equal(
      await reactivateSkippedV1Steps(
        first.id,
        'hn-monitor-v1-resume-fixture-workflow',
        path.join(runtimeDir, '.agent-relay', 'workflow-runs.jsonl'),
        (filePath) => new JsonFileWorkflowDb(filePath),
        ['validate-digest'],
      ),
      1,
      'the v1 compatibility seam must reactivate the skipped validator',
    );
    const resumed = await resumeFixture().run({ cwd: runtimeDir, renderer: false });

    assert.equal(resumed.id, first.id, 'resume must continue the journaled run id');
    assert.equal(resumed.status, 'completed');
    assert.equal(existsSync(path.join(runtimeDir, 'prepare-replayed')), false,
      'completed prepare-input must not execute again on resume');
    assert.match(
      await readFile(path.join(runtimeDir, '.agent-relay', 'step-outputs', first.id, 'prepare-input.md'), 'utf8'),
      /prepared/u,
    );
    assert.match(
      await readFile(path.join(runtimeDir, '.agent-relay', 'step-outputs', first.id, 'validate-digest.md'), 'utf8'),
      /HN_DIGEST_NOTES_JSON:/u,
    );
  } finally {
    if (previousResumeRunId === undefined) delete process.env.RESUME_RUN_ID;
    else process.env.RESUME_RUN_ID = previousResumeRunId;
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('five-step v1 flow regenerates malformed model JSON in the same run without replaying input', async () => {
  const runtimeDir = await mkdtemp(path.resolve('.hn-relayflow-artifact-retry-'));
  const previousResumeRunId = process.env.RESUME_RUN_ID;
  const previousRunIdFile = process.env.AGENT_RELAY_RUN_ID_FILE;
  try {
    delete process.env.RESUME_RUN_ID;
    process.env.AGENT_RELAY_RUN_ID_FILE = path.join(runtimeDir, 'current-run-id');
    const first = await invalidArtifactRecoveryFixture().run({ cwd: runtimeDir, renderer: false });
    assert.equal(first.status, 'failed');

    assert.deepEqual(
      await reactivateInvalidArtifactV1Steps(
        first.id,
        'hn-monitor-v1-artifact-recovery-fixture-workflow',
        path.join(runtimeDir, '.agent-relay', 'workflow-runs.jsonl'),
        (filePath) => new JsonFileWorkflowDb(filePath),
      ),
      { producerStep: 'analyze-stories', reactivated: 4 },
    );
    process.env.RESUME_RUN_ID = first.id;
    const resumed = await invalidArtifactRecoveryFixture().run({ cwd: runtimeDir, renderer: false });

    assert.equal(resumed.id, first.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(existsSync(path.join(runtimeDir, 'prepare-replayed')), false);
    assert.match(
      await readFile(path.join(runtimeDir, '.agent-relay', 'step-outputs', first.id, 'validate-digest.md'), 'utf8'),
      /HN_DIGEST_NOTES_JSON:\{"theme":"reviewed","stories":\[\{"id":20,"why":"validated"\}\]\}/u,
    );
  } finally {
    if (previousResumeRunId === undefined) delete process.env.RESUME_RUN_ID;
    else process.env.RESUME_RUN_ID = previousResumeRunId;
    if (previousRunIdFile === undefined) delete process.env.AGENT_RELAY_RUN_ID_FILE;
    else process.env.AGENT_RELAY_RUN_ID_FILE = previousRunIdFile;
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('v1 resume reactivation rejects non-failed runs and touches only named descendants', async () => {
  const steps = [
    { id: 'prepare-row', stepName: 'prepare-input', status: 'skipped' },
    { id: 'validate-row', stepName: 'validate-digest', status: 'skipped' },
  ];
  const updates = [];
  const journal = (status, workflowName = 'hn-monitor-scheduled-digest-v1-workflow') => ({
    async getRun() { return { status, workflowName }; },
    async getStepsByRunId() { return steps; },
    async updateStep(id, patch) { updates.push({ id, patch }); },
  });

  for (const status of ['running', 'completed']) {
    await assert.rejects(
      () => reactivateSkippedV1Steps('run-1', 'hn-monitor-scheduled-digest-v1-workflow', 'journal', () => journal(status), ['validate-digest']),
      new RegExp(`non-resumable status ${status}`, 'u'),
    );
  }
  await assert.rejects(
    () => reactivateSkippedV1Steps('run-1', 'hn-monitor-scheduled-digest-v1-workflow', 'journal', () => journal('failed', 'other-workflow'), ['validate-digest']),
    /belongs to other-workflow/u,
  );

  assert.equal(
    await reactivateSkippedV1Steps('run-1', 'hn-monitor-scheduled-digest-v1-workflow', 'journal', () => journal('failed'), ['validate-digest']),
    1,
  );
  assert.deepEqual(updates.map((update) => update.id), ['validate-row']);
});

test('v1 invalid-artifact recovery replays only the producer validation chain once', async () => {
  const steps = [
    { id: 'prepare-row', stepName: 'prepare-input', status: 'completed' },
    { id: 'analyze-row', stepName: 'analyze-stories', status: 'completed' },
    { id: 'candidate-row', stepName: 'validate-candidate', status: 'failed' },
    { id: 'review-row', stepName: 'review-digest', status: 'skipped' },
    { id: 'digest-row', stepName: 'validate-digest', status: 'skipped' },
  ];
  const updates = [];
  const journal = {
    async getRun() { return { status: 'failed', workflowName: 'hn-monitor-scheduled-digest-v1-workflow' }; },
    async getStepsByRunId() { return steps; },
    async updateStep(id, patch) { updates.push({ id, patch }); },
  };

  assert.deepEqual(
    await reactivateInvalidArtifactV1Steps(
      'run-1',
      'hn-monitor-scheduled-digest-v1-workflow',
      'journal',
      () => journal,
    ),
    { producerStep: 'analyze-stories', reactivated: 4 },
  );
  assert.deepEqual(updates.map((update) => update.id), ['analyze-row', 'candidate-row', 'review-row', 'digest-row']);
  assert.ok(updates.every((update) => update.patch.status === 'pending'));
  assert.deepEqual(
    await reactivateInvalidArtifactV1Steps(
      'run-1',
      'hn-monitor-scheduled-digest-v1-workflow',
      'journal',
      () => journal,
      ['analyze-stories'],
    ),
    { producerStep: 'analyze-stories', reactivated: 0 },
    'the same malformed producer must not be retried forever',
  );
});

test('v1 invalid final digest recovery keeps the valid curator chain immutable', async () => {
  const steps = [
    { id: 'prepare-row', stepName: 'prepare-input', status: 'completed' },
    { id: 'analyze-row', stepName: 'analyze-stories', status: 'completed' },
    { id: 'candidate-row', stepName: 'validate-candidate', status: 'completed' },
    { id: 'review-row', stepName: 'review-digest', status: 'completed' },
    { id: 'digest-row', stepName: 'validate-digest', status: 'failed' },
  ];
  const updates = [];
  const journal = {
    async getRun() { return { status: 'failed', workflowName: 'hn-monitor-scheduled-digest-v1-workflow' }; },
    async getStepsByRunId() { return steps; },
    async updateStep(id, patch) { updates.push({ id, patch }); },
  };

  assert.deepEqual(
    await reactivateInvalidArtifactV1Steps(
      'run-1',
      'hn-monitor-scheduled-digest-v1-workflow',
      'journal',
      () => journal,
    ),
    { producerStep: 'review-digest', reactivated: 2 },
  );
  assert.deepEqual(updates.map((update) => update.id), ['review-row', 'digest-row']);
});
