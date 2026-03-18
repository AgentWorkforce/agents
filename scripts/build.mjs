import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

function getModelId(model) {
  return model?.id || model?.name || model?.model || null;
}

function matchesRule(modelId, rule) {
  if (rule.endsWith('/*')) return modelId.startsWith(rule.slice(0, -1));
  return modelId === rule;
}

function resolveMatrix(models, harnessConfig) {
  const ids = models.map(getModelId).filter(Boolean);
  const matrix = {};

  for (const [harnessId, cfg] of Object.entries(harnessConfig.harnesses || {})) {
    const allow = cfg.supports || [];
    const deny = cfg.deny || [];

    const selected = ids.filter((id) => {
      const allowed = allow.some((r) => matchesRule(id, r));
      const denied = deny.some((r) => matchesRule(id, r));
      return allowed && !denied;
    });

    matrix[harnessId] = {
      name: cfg.name || harnessId,
      models: selected.sort()
    };
  }

  return matrix;
}

async function main() {
  const modelsPayload = JSON.parse(await fs.readFile('data/models.json', 'utf8'));
  const harnessConfig = JSON.parse(await fs.readFile('data/harness-models.json', 'utf8'));

  const matrix = resolveMatrix(modelsPayload.models || [], harnessConfig);

  await fs.rm('dist', { recursive: true, force: true });
  await fs.mkdir('dist', { recursive: true });

  await fs.writeFile('dist/matrix.json', JSON.stringify(matrix, null, 2) + '\n', 'utf8');
  await fs.copyFile('data/harness-models.json', 'dist/harness-models.json');

  execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });

  console.log('Built dist/ with TypeScript output + matrix.json');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
