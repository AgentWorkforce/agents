import fs from 'node:fs/promises';

const CANDIDATE_URLS = [
  process.env.MODELS_DEV_URL,
  'https://models.dev/api/models',
  'https://models.dev/models.json'
].filter(Boolean);

async function fetchFromPackage() {
  try {
    const { providers } = await import('models-dev-db');
    const providerList = await providers();
    const models = [];

    for (const p of providerList) {
      const entries = Object.values(p.models || {});
      for (const m of entries) {
        const id = `${p.id}/${m.id || m.name}`;
        models.push({ id, provider: p.id, model: m.id || m.name });
      }
    }

    return {
      source: 'models-dev-db',
      fetchedAt: new Date().toISOString(),
      models
    };
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function normalizeModels(payload) {
  const arr = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload?.data)
        ? payload.data
        : [];

  return arr
    .map((m) => {
      const id = m?.id || m?.name || m?.model;
      if (!id) return null;
      return { id };
    })
    .filter(Boolean);
}

async function fetchFromHttp() {
  for (const url of CANDIDATE_URLS) {
    try {
      const payload = await fetchJson(url);
      const models = normalizeModels(payload);
      if (models.length > 0) {
        return {
          source: url,
          fetchedAt: new Date().toISOString(),
          models
        };
      }
    } catch {}
  }
  return null;
}

async function main() {
  await fs.mkdir('data', { recursive: true });

  const fromPkg = await fetchFromPackage();
  const fromHttp = fromPkg ? null : await fetchFromHttp();
  const out = fromPkg || fromHttp;

  if (!out) {
    throw new Error('Could not fetch models from models.dev sources (package or HTTP).');
  }

  await fs.writeFile('data/models.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote data/models.json (${out.models.length} models) from ${out.source}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
