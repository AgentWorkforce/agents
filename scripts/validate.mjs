import fs from 'node:fs/promises';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const cfg = JSON.parse(await fs.readFile('data/harness-capabilities.json', 'utf8'));
  assert(cfg && typeof cfg === 'object', 'harness-capabilities.json must be an object');
  assert(cfg.harnesses && typeof cfg.harnesses === 'object', 'harnesses is required');

  for (const [id, h] of Object.entries(cfg.harnesses)) {
    assert(typeof h.known === 'boolean', `${id}: known must be boolean`);
    assert(Array.isArray(h.models), `${id}: models must be an array`);
    if (!h.known && h.models.length > 0) {
      throw new Error(`${id}: unknown harness cannot have non-empty models`);
    }
  }

  console.log('Validation passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
