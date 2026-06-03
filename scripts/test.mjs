import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, '.test-build');
const explicitTests = process.argv.slice(2);

await rm(outDir, { recursive: true, force: true });
try {
  const entryPoints = [];
  await collectTypeScriptSources(repoRoot, entryPoints);
  entryPoints.sort();
  if (entryPoints.length === 0) {
    throw new Error('no TypeScript sources found to build');
  }

  await build({
    entryPoints,
    outdir: outDir,
    outbase: repoRoot,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: false,
    logLevel: 'silent'
  });

  const testFiles = explicitTests.length > 0
    ? explicitTests.map((file) => path.resolve(repoRoot, file))
    : await discoverTests(path.join(repoRoot, 'tests'));
  if (testFiles.length === 0) {
    throw new Error('no test files found');
  }

  await runNodeTests(testFiles);
} finally {
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
}

async function collectTypeScriptSources(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTypeScriptSources(abs, out);
      continue;
    }
    if (isTypeScriptSource(entry.name)) {
      out.push(abs);
    }
  }
}

async function discoverTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function shouldSkipEntry(name) {
  return name === 'node_modules' || name === '.git' || name === '.test-build' || name === '.trajectories' || name.startsWith('.');
}

function isTypeScriptSource(name) {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

function runNodeTests(testFiles) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...testFiles], {
      cwd: repoRoot,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`node --test terminated by ${signal}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`node --test exited with code ${code ?? 1}`));
    });
  });
}
