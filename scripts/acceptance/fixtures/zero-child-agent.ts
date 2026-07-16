import { defineAgent } from '@agentworkforce/runtime';

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 * * * *', tz: 'UTC' }],
  handler: async (ctx) => {
    const workflow = await ctx.workflow.run('acceptance-zero-child', { probe: true });
    ctx.log('info', 'acceptance.zero-child.workflow', { runId: workflow.runId });
  },
});
