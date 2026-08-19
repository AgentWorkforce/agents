#!/usr/bin/env node
/**
 * Compile every agent's `persona.ts`, then register the results where the CLI
 * will actually look for them.
 *
 * Compiling alone is not enough. `agentworkforce persona compile` writes
 * `persona.json` beside its input, and `deploy` is handed `persona.ts` directly,
 * so both are content with a persona living in `<agent>/`. The local CLI is not:
 * it reads `<cwd>/.agentworkforce/workforce/personas/*.json` and does NOT
 * recurse, so every persona in this repo is invisible to `agentworkforce agent`.
 * The symptom is `Unknown persona "hn-monitor"` followed by a list that does not
 * contain it, which reads like a broken install rather than a layout mismatch.
 *
 * So each compiled persona is copied into the personas directory, named for its
 * `id` rather than its directory — `granola/` publishes `granola-prospect`,
 * `linear/` publishes `linear-chat-lead`, `review/` publishes `pr-reviewer`, and
 * naming by directory would register all three under the wrong name.
 *
 * The copy is not a straight `cp`. Relative paths inside a persona JSON resolve
 * against the directory the file was READ from, so `./agent.ts` would point at a
 * handler in the personas directory that does not exist. Every relative path is
 * rebased as the copy is written.
 *
 * Registrations are tracked in a manifest so a removed or renamed agent takes
 * its registration with it. Without that, `granola-prospect`'s predecessor would
 * still be sitting in the picker with no source left to rebuild it from — which
 * is how the three dead `*-telegram/persona.json` artifacts in this repo
 * outlived the agents that PR #91 deleted. Only files this script wrote are ever
 * removed; personas put there by `agentworkforce install` are left alone.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { repoRoot, runAgentworkforce } from './agentworkforce-cli.mjs';

const PERSONAS_DIR = join(repoRoot, '.agentworkforce', 'workforce', 'personas');

// Deliberately NOT inside PERSONAS_DIR: the CLI scans that directory for
// `*.json` and would report a manifest as a persona missing its `id`.
const MANIFEST = join(repoRoot, '.agentworkforce', 'workforce', 'personas.compiled.json');

/** `./x` and `../x` are filesystem paths; `@scope/pkg` and `https://…` are not. */
const RELATIVE_PATH = /^\.\.?[/\\]/u;

/** Agent directories, i.e. every top-level directory holding a `persona.ts`. */
function findPersonaSources() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => ({ dir: entry.name, source: join(repoRoot, entry.name, 'persona.ts') }))
    .filter((candidate) => existsSync(candidate.source))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function rebase(agentDir, value) {
  const rel = relative(PERSONAS_DIR, resolve(agentDir, value)).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function rebaseRelativePaths(persona, agentDir) {
  const out = { ...persona };

  for (const field of ['claudeMd', 'agentsMd', 'onEvent']) {
    if (typeof out[field] === 'string' && RELATIVE_PATH.test(out[field])) {
      out[field] = rebase(agentDir, out[field]);
    }
  }

  if (Array.isArray(out.skills)) {
    out.skills = out.skills.map((skill) => (
      typeof skill?.source === 'string' && RELATIVE_PATH.test(skill.source)
        ? { ...skill, source: rebase(agentDir, skill.source) }
        : skill
    ));
  }

  return out;
}

function readManifest() {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return Array.isArray(parsed?.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

export function compilePersonas({ log = console.log } = {}) {
  const sources = findPersonaSources();
  if (sources.length === 0) throw new Error('no */persona.ts found — nothing to compile');

  mkdirSync(PERSONAS_DIR, { recursive: true });

  const registered = new Map();
  const skipped = [];

  for (const { dir, source } of sources) {
    // Fail loudly. The shell loop this replaced kept going past a failed
    // compile, so `npm run evals` could run happily against a stale persona.json
    // whose source had stopped compiling days earlier.
    const result = runAgentworkforce(['persona', 'compile', source]);
    if (!result.ok) {
      throw new Error(`persona compile failed for ${dir}/persona.ts:\n${result.stderr || result.stdout}`);
    }

    const compiledPath = join(repoRoot, dir, 'persona.json');
    const persona = JSON.parse(readFileSync(compiledPath, 'utf8'));
    if (typeof persona.id !== 'string' || !persona.id.trim()) {
      throw new Error(`${compiledPath}: compiled persona has no id`);
    }

    // The local CLI's only use for a registered persona is `agentworkforce agent
    // <id>`, which drops into an interactive harness session. A persona that
    // declares no harness has none to drop into: persona-registry rejects it as
    // a standalone persona and prints a warning on EVERY CLI invocation, which
    // is exactly the noise this script exists to remove. Some of these are
    // harness-free by design — spotify-releases and vendor-monitor both say
    // "no model needed" and are pure fetch-and-deliver handlers. Skip them, but
    // name them, because for the rest it looks like an oversight rather than a
    // decision.
    if (typeof persona.harness !== 'string' || !persona.harness.trim()) {
      skipped.push({ dir, id: persona.id });
      continue;
    }

    const clash = registered.get(persona.id);
    if (clash) {
      // The personas directory is a flat namespace, so this would silently
      // publish whichever agent happened to compile second.
      throw new Error(`duplicate persona id "${persona.id}": ${clash} and ${dir} both claim it`);
    }
    registered.set(persona.id, dir);

    const file = `${persona.id}.json`;
    const body = rebaseRelativePaths(persona, join(repoRoot, dir));
    writeFileSync(join(PERSONAS_DIR, file), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  const files = [...registered.keys()].sort().map((id) => `${id}.json`);
  const skippedFiles = new Set(skipped.map(({ id }) => `${id}.json`));
  const stale = readManifest().filter((file) => !files.includes(file));
  for (const file of stale) {
    rmSync(join(PERSONAS_DIR, file), { force: true });
    const reason = skippedFiles.has(file) ? 'it no longer declares a harness' : 'no agent publishes it any more';
    log(`Unregistered ${file} — ${reason}`);
  }

  writeFileSync(MANIFEST, `${JSON.stringify({ files }, null, 2)}\n`, 'utf8');

  for (const { dir, id } of skipped) {
    log(`Not registered: ${id} (${dir}) declares no harness, so there is no interactive session to run`);
  }

  return { registered, skipped, files, stale };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith(`${sep}compile-personas.mjs`);
if (invokedDirectly) {
  const { registered } = compilePersonas();
  console.log(`Compiled and registered ${registered.size} persona(s) -> ${PERSONAS_DIR}`);
}

export { PERSONAS_DIR, MANIFEST, findPersonaSources, rebaseRelativePaths };
