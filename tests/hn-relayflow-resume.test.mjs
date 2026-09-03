import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { JsonFileWorkflowDb, workflow } from '@relayflows/core';
import { reactivateSkippedV1Steps } from '../.test-build/workflows/hn-monitor-scheduled-digest-v1-source.js';

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
