import http from 'node:http';

import { defineAgent } from '@agentworkforce/runtime';

function requiredInput(ctx: { persona?: { inputs?: Record<string, string> } }, name: string): string {
  const value = ctx.persona?.inputs?.[name];
  if (!value) throw new Error(`Missing required input ${name}`);
  return value;
}

async function attempt(
  ctx: { log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>) => void },
  label: string,
  fn: () => Promise<void>,
) {
  try {
    await fn();
    ctx.log('info', `acceptance.safety.${label}.ok`);
  } catch (error) {
    ctx.log('warn', `acceptance.safety.${label}.error`, { error: String(error) });
  }
}

function rawHttpRequest(urlText: string, method: 'GET' | 'POST') {
  return new Promise<void>((resolve, reject) => {
    const url = new URL(urlText);
    const req = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    if (method === 'POST') req.write('raw-http-body');
    req.end();
  });
}

export default defineAgent({
  schedules: [{ name: 'scan', cron: '0 * * * *', tz: 'UTC' }],
  handler: async (ctx) => {
    const allowedGetUrl = requiredInput(ctx, 'ALLOWED_GET_URL');
    const deniedPostUrl = requiredInput(ctx, 'DENIED_POST_URL');

    await attempt(ctx, 'memory', async () => {
      const saved = await ctx.memory.save('acceptance safety memory', {
        scope: 'workspace',
        tags: ['acceptance-safety'],
      });
      const recalled = await ctx.memory.recall('acceptance safety memory', {
        scope: 'workspace',
        tags: ['acceptance-safety'],
      });
      ctx.log('info', 'acceptance.safety.memory.state', {
        saveId: saved?.id,
        recalled: recalled.length,
      });
    });

    await attempt(ctx, 'allowed-get', async () => {
      const response = await fetch(allowedGetUrl, { method: 'GET' });
      await response.text();
      ctx.log('info', 'acceptance.safety.allowed-get.status', { status: response.status });
    });

    await attempt(ctx, 'denied-post', async () => {
      const response = await fetch(deniedPostUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'denied-post-body',
      });
      await response.text();
      ctx.log('info', 'acceptance.safety.denied-post.status', { status: response.status });
    });

    await attempt(ctx, 'undeclared-get', async () => {
      const undeclaredGetUrl = requiredInput(ctx, 'UNDECLARED_GET_URL');
      const response = await fetch(undeclaredGetUrl, { method: 'GET' });
      await response.text();
      ctx.log('info', 'acceptance.safety.undeclared-get.status', { status: response.status });
    });

    await attempt(ctx, 'raw-http', async () => {
      await rawHttpRequest(deniedPostUrl, 'POST');
    });

    await attempt(ctx, 'relay-post', async () => {
      const result = await ctx.relay.post('general', 'acceptance safety relay post');
      ctx.log('info', 'acceptance.safety.relay-post.result', result);
    });

    await attempt(ctx, 'workflow-run', async () => {
      const handle = await ctx.workflow.run('acceptance-safety-probe', { probe: true });
      ctx.log('info', 'acceptance.safety.workflow-run.result', { runId: handle.runId });
    });

    await attempt(ctx, 'sandbox-exec', async () => {
      const result = await ctx.sandbox.exec('echo acceptance-safety');
      ctx.log('info', 'acceptance.safety.sandbox-exec.result', { exitCode: result.exitCode });
    });
  },
});
