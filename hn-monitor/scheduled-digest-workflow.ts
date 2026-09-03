import type { WorkforceCtx } from '@agentworkforce/runtime';

import {
  SCHEDULED_DIGEST_WORKFLOW_NAME,
  scheduledDigestWorkflowSource,
} from '../workflows/hn-monitor-scheduled-digest-v1-source.js';

export { SCHEDULED_DIGEST_WORKFLOW_NAME };

/**
 * The current deploy artifact contains only the bundled handler. Materialize
 * the canonical, bundled source through the runtime workspace API so
 * ctx.workflow.run can upload it through the existing Cloud v1 API without
 * changing the deploy surface. Repeated writes are byte-identical.
 */
export async function materializeScheduledDigestWorkflow(
  ctx: Pick<WorkforceCtx, 'files'>,
): Promise<string> {
  const target = `workflows/${SCHEDULED_DIGEST_WORKFLOW_NAME}.ts`;
  await ctx.files.write(target, scheduledDigestWorkflowSource());
  return target;
}
