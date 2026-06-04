/**
 * cloud-team-reviewer handler — deliberately event-free.
 *
 * Team members are launched by the cloud team dispatcher when the LEAD
 * persona's trigger fires: the dispatcher reads the bound roster, provisions
 * a sandbox per member, and runs the member workflow with this persona's
 * harness/model/systemPrompt. Subscribing to events here would make every
 * roster member fire independently alongside the lead — duplicate sandboxes
 * and duplicate reviews for the same issue — so this handler declares no
 * triggers and only logs if cloud ever routes an event to it directly.
 */
import { defineAgent, type WorkforceCtx, type WorkforceEvent } from '@agentworkforce/runtime';

export async function handleUnexpectedEvent(ctx: WorkforceCtx, event: WorkforceEvent): Promise<void> {
  ctx.log('warn', 'cloud-team-reviewer received a direct event; members are launched by the team dispatcher, not by subscriptions', {
    eventId: event.id,
    source: event.source,
    type: 'type' in event ? event.type : undefined
  });
}

export default defineAgent({
  launchedBy: 'team-dispatcher',
  handler: handleUnexpectedEvent
});
