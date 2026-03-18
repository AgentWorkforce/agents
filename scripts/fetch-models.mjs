import fs from 'node:fs/promises';

// NOTE: endpoint may change; keep configurable.
const url = process.env.MODELS_DEV_URL || 'https://models.dev/api/models';

async function main() {
  const res = await fetch(url, { headers: { 'accept': 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch models from ${url}: ${res.status} ${res.statusText}`);
  }

  const payload = await res.json();
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/models.json', JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Wrote data/models.json from ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
