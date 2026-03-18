import fs from 'node:fs/promises';

async function readJson(path) {
  const raw = await fs.readFile(path, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const harnesses = await readJson('data/harnesses.json');
  const compatibility = await readJson('data/compatibility.json');

  const harnessIds = new Set(harnesses.harnesses.map((h) => h.id));
  const bad = [];

  for (const row of compatibility.entries) {
    if (!harnessIds.has(row.harness_id)) bad.push(row);
  }

  if (bad.length) {
    throw new Error(`Compatibility rows reference unknown harnesses: ${bad.length}`);
  }

  console.log('Validation passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
