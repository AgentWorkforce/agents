import { defineAgent } from '@agentworkforce/runtime';

export default defineAgent({
  handler: async (ctx, event) => {
    ctx.log('info', 'acceptance.replay.event', {
      type: event.type,
      resource: event.resource?.kind,
      workspace: event.workspace,
    });
    const saved = await ctx.memory.save(`replay bundle event ${event.type}`, {
      scope: 'workspace',
      tags: ['acceptance-replay'],
    });
    ctx.log('info', 'acceptance.replay.memory', { id: saved?.id });
  },
});
