import fs from 'node:fs/promises';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const cfg = JSON.parse(await fs.readFile('data/harness-models.json', 'utf8'));
  assert(cfg && typeof cfg === 'object', 'harness-models.json must be an object');
  assert(cfg.harnesses && typeof cfg.harnesses === 'object', 'harnesses is required');

  for (const [id, h] of Object.entries(cfg.harnesses)) {
    assert(Array.isArray(h.supports), `${id}: supports must be an array`);
    assert(Array.isArray(h.deny || []), `${id}: deny must be an array when provided`);
  }

  console.log('Validation passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
