import fs from 'node:fs/promises';

const CANDIDATE_URLS = [
  process.env.MODELS_DEV_URL,
  'https://models.dev/api/models',
  'https://models.dev/models.json'
].filter(Boolean);

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function normalizeModels(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.models)) return payload.models;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function main() {
  await fs.mkdir('data', { recursive: true });

  let models = [];
  let source = null;
  for (const url of CANDIDATE_URLS) {
    try {
      const payload = await fetchJson(url);
      const normalized = normalizeModels(payload);
      if (normalized.length > 0) {
        models = normalized;
        source = url;
        break;
      }
    } catch {}
  }

  if (!models.length) {
    throw new Error('Could not fetch models from models.dev (set MODELS_DEV_URL if needed).');
  }

  await fs.writeFile(
    'data/models.json',
    JSON.stringify({ source, fetchedAt: new Date().toISOString(), models }, null, 2) + '\n',
    'utf8'
  );
  console.log(`Wrote data/models.json (${models.length} models) from ${source}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
