import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

async function main() {
  const capabilities = JSON.parse(await fs.readFile('data/harness-capabilities.json', 'utf8'));

  const matrix = {};
  for (const [harnessId, cfg] of Object.entries(capabilities.harnesses || {})) {
    matrix[harnessId] = {
      name: cfg.name || harnessId,
      source: cfg.source || 'unknown',
      known: !!cfg.known,
      models: Array.isArray(cfg.models) ? [...cfg.models].sort() : []
    };
  }

  await fs.rm('dist', { recursive: true, force: true });
  await fs.mkdir('dist', { recursive: true });

  await fs.writeFile('dist/matrix.json', JSON.stringify(matrix, null, 2) + '\n', 'utf8');
  await fs.copyFile('data/harness-capabilities.json', 'dist/harness-capabilities.json');

  execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });

  console.log('Built dist/ from explicit harness capabilities (no inference).');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
