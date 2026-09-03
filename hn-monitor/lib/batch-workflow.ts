import { createHash } from 'node:crypto';

export const HN_BATCH_WORKFLOW_NAME = 'hn-monitor-scheduled-batch-v1';
export const HN_BATCH_WORKFLOW_VERSION = 'v1' as const;
export const HN_BATCH_RESULT_MARKER = 'HN_BATCH_RESULT_JSON:';
export const HN_BATCH_STEP_IDS = [
  'analyze-batch',
  'review-batch',
  'repair-batch',
  'validate-batch',
] as const;

export interface HnBatchStoryInput {
  id: number;
  title: string;
  url: string;
  points: number;
  comments?: number;
  feeds?: readonly string[];
  hnUrl?: string;
  category?: string;
}

export interface NormalizedHnBatchStory {
  id: number;
  title: string;
  url: string;
  points: number;
  comments: number;
  feeds: string[];
  hnUrl?: string;
  category?: string;
}

export interface HnBatchWorkflowInput {
  relayflowVersion: typeof HN_BATCH_WORKFLOW_VERSION;
  idempotencyKey: string;
  storyIds: number[];
  stories: NormalizedHnBatchStory[];
}

/** Stable across feed ordering and runtime retries; story ids are the durable batch identity. */
export function createHnBatchIdempotencyKey(storyIds: readonly number[]): string {
  const sortedIds = normalizeStoryIds(storyIds);
  if (sortedIds.length === 0) throw new Error('HN batch requires at least one story id');
  const digest = createHash('sha256').update(sortedIds.join(',')).digest('hex').slice(0, 24);
  return `hn-monitor:v1:${digest}`;
}

/**
 * Build the exact JSON-safe argument contract sent to `ctx.workflow.run`.
 * Both the ids and story records are canonicalized so a feed-order change does
 * not create a different durable batch.
 */
export function createHnBatchWorkflowInput(
  stories: readonly HnBatchStoryInput[]
): HnBatchWorkflowInput {
  if (stories.length === 0) throw new Error('HN batch requires at least one story');
  const ids = stories.map((story) => story.id);
  const sortedIds = normalizeStoryIds(ids);
  if (sortedIds.length !== stories.length) throw new Error('HN batch contains duplicate story ids');

  const normalizedStories = stories
    .map((story): NormalizedHnBatchStory => ({
      id: story.id,
      title: story.title,
      url: story.url,
      points: story.points,
      comments: story.comments ?? 0,
      feeds: [...new Set(story.feeds ?? [])].sort(),
      ...(story.hnUrl ? { hnUrl: story.hnUrl } : {}),
      ...(story.category ? { category: story.category } : {}),
    }))
    .sort((a, b) => a.id - b.id);

  return {
    relayflowVersion: HN_BATCH_WORKFLOW_VERSION,
    idempotencyKey: createHnBatchIdempotencyKey(sortedIds),
    storyIds: sortedIds,
    stories: normalizedStories,
  };
}

function normalizeStoryIds(storyIds: readonly number[]): number[] {
  for (const id of storyIds) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid HN story id: ${String(id)}`);
  }
  return [...new Set(storyIds)].sort((a, b) => a - b);
}
