import path from 'node:path';

import { JsonFileWorkflowDb } from '@relayflows/core';

/**
 * Relayflow core v1.0.6 only resets failed steps when resuming. Descendants
 * journaled as skipped stay skipped, which can otherwise produce a completed
 * run without its terminal artifact. Reactivate only those descendants before
 * the v1 runner reloads the journal; completed steps remain immutable.
 */
export async function reactivateSkippedV1Steps(
  runId: string,
  workflowName: string,
  cwd = process.cwd(),
): Promise<number> {
  const db = new JsonFileWorkflowDb(path.join(cwd, '.agent-relay', 'workflow-runs.jsonl'));
  const run = await db.getRun(runId);
  if (!run) throw new Error(`Relayflow resume run ${runId} was not found`);
  if (run.workflowName !== workflowName) {
    throw new Error(`Relayflow resume run ${runId} belongs to ${run.workflowName}, not ${workflowName}`);
  }
  if (run.status !== 'failed' && run.status !== 'running') {
    throw new Error(`Relayflow resume run ${runId} has non-resumable status ${run.status}`);
  }

  let count = 0;
  for (const step of await db.getStepsByRunId(runId)) {
    if (step.status !== 'skipped') continue;
    await db.updateStep(step.id, {
      status: 'pending',
      error: undefined,
      completionReason: undefined,
      completedAt: undefined,
    });
    count += 1;
  }
  return count;
}
