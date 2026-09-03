import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  workflow,
  type AgentDefinition,
  type RunnerStepExecutor,
  type WorkflowEventListener,
  type WorkflowStep,
} from '@relayflows/core';

export const HN_BATCH_WORKFLOW_NAME = 'hn-monitor-scheduled-batch-v1';
export const HN_BATCH_STEP_IDS = [
  'analyze-batch',
  'review-batch',
  'repair-batch',
  'validate-batch',
] as const;

export interface HnBatchStory {
  id: number;
}

export interface HnBatchDraft<TStory extends HnBatchStory> {
  header: string;
  body: string;
  stories: TStory[];
}

export interface HnBatchWorkflowInput {
  idempotencyKey: string;
  storyIds: number[];
}

export interface HnBatchWorkflowHooks<TStory extends HnBatchStory> {
  analyze: () => Promise<HnBatchDraft<TStory>>;
  repair: (draft: HnBatchDraft<TStory>, findings: string[]) => Promise<HnBatchDraft<TStory>>;
}

export interface HnBatchWorkflowResult<TStory extends HnBatchStory> {
  batch: HnBatchDraft<TStory>;
  input: HnBatchWorkflowInput;
  runId: string;
  status: 'completed';
}

interface HnBatchWorkflowOptions {
  cwd?: string;
  onEvent?: WorkflowEventListener;
}

/** Stable across feed ordering and runtime retries; story ids are the durable batch identity. */
export function createHnBatchIdempotencyKey(storyIds: readonly number[]): string {
  const sortedIds = normalizeStoryIds(storyIds);
  if (sortedIds.length === 0) throw new Error('HN batch requires at least one story id');
  const digest = createHash('sha256').update(sortedIds.join(',')).digest('hex').slice(0, 24);
  return `hn-monitor:v1:${digest}`;
}

export function createHnBatchWorkflowInput(storyIds: readonly number[]): HnBatchWorkflowInput {
  const sortedIds = normalizeStoryIds(storyIds);
  return {
    idempotencyKey: createHnBatchIdempotencyKey(sortedIds),
    storyIds: sortedIds,
  };
}

/**
 * Run the scheduled analysis lifecycle through the real Relayflow v1 DAG.
 * Network/model/provider/memory operations remain hooks owned by the persona;
 * Relayflow owns durable ordering, retries, step outputs, and completion state.
 */
export async function runHnBatchWorkflow<TStory extends HnBatchStory>(
  storyIds: readonly number[],
  hooks: HnBatchWorkflowHooks<TStory>,
  options: HnBatchWorkflowOptions = {},
): Promise<HnBatchWorkflowResult<TStory>> {
  const input = createHnBatchWorkflowInput(storyIds);
  let analyzed: HnBatchDraft<TStory> | undefined;
  let findings: string[] = [];
  let repaired: HnBatchDraft<TStory> | undefined;
  let validated: HnBatchDraft<TStory> | undefined;

  const executor: RunnerStepExecutor = {
    async executeAgentStep(_step: WorkflowStep, _agent: AgentDefinition): Promise<string> {
      throw new Error('HN scheduled batch workflow has no agent subprocess steps');
    },
    async executeDeterministicStep(step: WorkflowStep): Promise<{ output: string; exitCode: number }> {
      switch (step.name) {
        case HN_BATCH_STEP_IDS[0]: {
          analyzed = await hooks.analyze();
          return completedOutput(input, step.name, { storyCount: analyzed.stories.length });
        }
        case HN_BATCH_STEP_IDS[1]: {
          if (!analyzed) throw new Error('analyze-batch completed without a draft');
          findings = reviewDraft(analyzed, storyIds);
          return completedOutput(input, step.name, { findings });
        }
        case HN_BATCH_STEP_IDS[2]: {
          if (!analyzed) throw new Error('repair-batch requires analyzed draft');
          repaired = findings.length > 0 ? await hooks.repair(analyzed, findings) : analyzed;
          return completedOutput(input, step.name, {
            repaired: findings.length > 0,
            storyCount: repaired.stories.length,
          });
        }
        case HN_BATCH_STEP_IDS[3]: {
          if (!repaired) throw new Error('validate-batch requires repaired draft');
          const remaining = reviewDraft(repaired, storyIds);
          if (remaining.length > 0) {
            return {
              output: JSON.stringify({ ...input, stepId: step.name, findings: remaining }),
              exitCode: 1,
            };
          }
          validated = repaired;
          return completedOutput(input, step.name, { storyCount: validated.stories.length });
        }
        default:
          throw new Error(`Unknown HN batch workflow step: ${step.name}`);
      }
    },
  };

  const safeKey = input.idempotencyKey.replace(/[^a-zA-Z0-9.-]/gu, '-');
  const cwd = options.cwd ?? join(tmpdir(), 'agentworkforce-hn-monitor-relayflow-v1', safeKey);
  const run = await workflow(HN_BATCH_WORKFLOW_NAME)
    .description('Analyze, review, repair, and validate one fresh HN story batch')
    .pattern('dag')
    .maxConcurrency(1)
    .timeout(300_000)
    .trajectories(false)
    .step(HN_BATCH_STEP_IDS[0], {
      type: 'deterministic',
      command: 'hn-monitor:analyze-batch',
      captureOutput: true,
      failOnError: true,
    })
    .step(HN_BATCH_STEP_IDS[1], {
      type: 'deterministic',
      command: 'hn-monitor:review-batch',
      dependsOn: [HN_BATCH_STEP_IDS[0]],
      captureOutput: true,
      failOnError: true,
    })
    .step(HN_BATCH_STEP_IDS[2], {
      type: 'deterministic',
      command: 'hn-monitor:repair-batch',
      dependsOn: [HN_BATCH_STEP_IDS[1]],
      captureOutput: true,
      failOnError: true,
    })
    .step(HN_BATCH_STEP_IDS[3], {
      type: 'deterministic',
      command: 'hn-monitor:validate-batch',
      dependsOn: [HN_BATCH_STEP_IDS[2]],
      captureOutput: true,
      failOnError: true,
    })
    .onError('retry', { maxRetries: 1, retryDelayMs: 0 })
    .run({ cwd, executor, renderer: false, onEvent: options.onEvent });

  if (run.status !== 'completed' || !validated) {
    const detail = run.error ? `: ${run.error}` : '';
    throw new Error(`HN batch workflow did not complete (${run.status})${detail}`);
  }
  return { batch: validated, input, runId: run.id, status: 'completed' };
}

function normalizeStoryIds(storyIds: readonly number[]): number[] {
  for (const id of storyIds) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid HN story id: ${String(id)}`);
  }
  return [...new Set(storyIds)].sort((a, b) => a - b);
}

function reviewDraft<TStory extends HnBatchStory>(
  draft: HnBatchDraft<TStory>,
  expectedStoryIds: readonly number[],
): string[] {
  const findings: string[] = [];
  if (!draft.header.trim()) findings.push('header is empty');
  if (!draft.body.trim()) findings.push('body is empty');
  const expected = [...expectedStoryIds];
  const actual = draft.stories.map((story) => story.id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    findings.push(`story ids changed or reordered: expected ${expected.join(',')} got ${actual.join(',')}`);
  }
  return findings;
}

function completedOutput(
  input: HnBatchWorkflowInput,
  stepId: string,
  details: Record<string, unknown>,
): { output: string; exitCode: number } {
  return { output: JSON.stringify({ ...input, stepId, ...details }), exitCode: 0 };
}
