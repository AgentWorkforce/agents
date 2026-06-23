import assert from 'node:assert/strict';
import test from 'node:test';

async function importWithTelegramFlag(relativePath, enabled) {
  const oldValue = process.env.HN_MONITOR_ENABLE_TELEGRAM;
  if (enabled) {
    process.env.HN_MONITOR_ENABLE_TELEGRAM = '1';
  } else {
    delete process.env.HN_MONITOR_ENABLE_TELEGRAM;
  }
  try {
    const url = new URL(`../.test-build/hn-monitor/${relativePath}`, import.meta.url);
    url.searchParams.set('telegram', enabled ? 'on' : 'off');
    url.searchParams.set('t', String(Date.now() + Math.random()));
    return await import(url.href);
  } finally {
    if (oldValue === undefined) {
      delete process.env.HN_MONITOR_ENABLE_TELEGRAM;
    } else {
      process.env.HN_MONITOR_ENABLE_TELEGRAM = oldValue;
    }
  }
}

test('hn-monitor deploys Slack-only by default', async () => {
  const { default: persona } = await importWithTelegramFlag('persona.js', false);
  const { default: agent } = await importWithTelegramFlag('agent.js', false);

  assert.deepEqual(Object.keys(persona.integrations), ['slack']);
  assert.equal('TELEGRAM_CHAT' in persona.inputs, false);
  assert.equal(agent.triggers, undefined);
});

test('hn-monitor can opt into Telegram integration and trigger', async () => {
  const { default: persona } = await importWithTelegramFlag('persona.js', true);
  const { default: agent } = await importWithTelegramFlag('agent.js', true);

  assert.deepEqual(Object.keys(persona.integrations).sort(), ['slack', 'telegram']);
  assert.equal(persona.inputs.TELEGRAM_CHAT.env, 'TELEGRAM_CHAT');
  assert.deepEqual(agent.triggers, { telegram: [{ on: 'message' }] });
});
