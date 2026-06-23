import assert from 'node:assert/strict';
import test from 'node:test';

async function importCompiled(dir, relativePath) {
  const url = new URL(`../.test-build/${dir}/${relativePath}`, import.meta.url);
  url.searchParams.set('t', String(Date.now() + Math.random()));
  return await import(url.href);
}

test('hn-monitor is the Slack deploy target', async () => {
  const { default: persona } = await importCompiled('hn-monitor', 'persona.js');
  const { default: agent } = await importCompiled('hn-monitor', 'agent.js');

  assert.deepEqual(Object.keys(persona.integrations), ['slack']);
  assert.equal('TELEGRAM_CHAT' in persona.inputs, false);
  assert.equal(agent.triggers, undefined);
});

test('hn-monitor-telegram is the Telegram deploy target', async () => {
  const { default: persona } = await importCompiled('hn-monitor-telegram', 'persona.js');
  const { default: agent } = await importCompiled('hn-monitor-telegram', 'agent.js');

  assert.deepEqual(Object.keys(persona.integrations), ['telegram']);
  assert.equal('SLACK_CHANNEL' in persona.inputs, false);
  assert.equal(persona.inputs.TELEGRAM_CHAT.env, 'TELEGRAM_CHAT');
  assert.deepEqual(agent.triggers, { telegram: [{ on: 'message' }] });
});
