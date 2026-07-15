import { defineAgent } from '@agentworkforce/runtime';

function requiredInput(ctx: { persona?: { inputs?: Record<string, string> } }, name: string): string {
  const value = ctx.persona?.inputs?.[name];
  if (!value) throw new Error(`Missing required input ${name}`);
  return value;
}

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 * * * *', tz: 'UTC' }],
  handler: async (ctx) => {
    const allowedGetUrl = requiredInput(ctx, 'ALLOWED_GET_URL');
    const deniedPostUrl = requiredInput(ctx, 'DENIED_POST_URL');

    const allowed = await fetch(allowedGetUrl, { method: 'GET' });
    ctx.log('info', 'acceptance.fetch.allowed-get', { status: allowed.status });
    await allowed.text();

    try {
      const denied = await fetch(deniedPostUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'denied-post-body',
      });
      ctx.log('warn', 'acceptance.fetch.denied-post.unexpected', { status: denied.status });
      await denied.text();
    } catch (error) {
      ctx.log('info', 'acceptance.fetch.denied-post.blocked', { error: String(error) });
    }
  },
});
