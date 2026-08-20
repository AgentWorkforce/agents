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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

import { repoRoot, runAgentworkforce } from './agentworkforce-cli.mjs';

const PERSONAS_DIR = join(repoRoot, '.agentworkforce', 'workforce', 'personas');

// Deliberately NOT inside PERSONAS_DIR: the CLI scans that directory for
// `*.json` and would report a manifest as a persona missing its `id`.
const MANIFEST = join(repoRoot, '.agentworkforce', 'workforce', 'personas.compiled.json');
const MANIFEST_OWNER = 'compile-personas.mjs';

/** `./x` and `../x` are filesystem paths; `@scope/pkg` and `https://…` are not. */
const RELATIVE_PATH = /^\.\.?[/\\]/u;
const SAFE_PERSONA_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/** Agent directories, i.e. every top-level directory holding a `persona.ts`. */
function findPersonaSources() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => ({ dir: entry.name, source: join(repoRoot, entry.name, 'persona.ts') }))
    .filter((candidate) => existsSync(candidate.source))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function rebase(agentDir, value) {
  const nativePath = value.split(/[\\/]/u).join(sep);
  const rel = relative(PERSONAS_DIR, resolve(agentDir, nativePath)).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function registrationFile(id) {
  const normalized = typeof id === 'string' ? id.trim() : '';
  if (!SAFE_PERSONA_ID.test(normalized)) {
    throw new Error(`invalid persona id for flat registration: ${String(id)}`);
  }
  return `${normalized}.json`;
}

function assertOwnedRegistrationFile(file) {
  const normalized = typeof file === 'string' ? file.trim() : '';
  if (normalized !== basename(normalized) || !normalized.endsWith('.json')) {
    throw new Error(`invalid compiled-persona manifest entry: ${String(file)}`);
  }
  registrationFile(normalized.slice(0, -'.json'.length));
  return normalized;
}

function normalizeManifestEntry(entry) {
  if (typeof entry === 'string') {
    return { file: assertOwnedRegistrationFile(entry) };
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error(`invalid compiled-persona manifest entry: ${String(entry)}`);
  }
  const file = assertOwnedRegistrationFile(entry.file);
  const sha256 = entry.sha256;
  if (sha256 === undefined) {
    return { file };
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new Error(`invalid compiled-persona manifest digest for ${file}`);
  }
  return { file, sha256 };
}

function parseManifestData(raw) {
  if (Array.isArray(raw?.entries)) {
    return raw.entries.map(normalizeManifestEntry);
  }
  if (Array.isArray(raw?.files)) {
    return raw.files.map(normalizeManifestEntry);
  }
  throw new Error('compiled-persona manifest must contain an entries[] or files[] array');
}

function digestText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function manifestEntryFor(file, body) {
  return { file, sha256: digestText(body) };
}

function writeManifest(entries) {
  const sorted = [...entries]
    .map(normalizeManifestEntry)
    .sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(MANIFEST, `${JSON.stringify({
    managedBy: MANIFEST_OWNER,
    entries: sorted,
    files: sorted.map((entry) => entry.file),
  }, null, 2)}\n`, 'utf8');
}

function currentDigest(file) {
  return digestText(readFileSync(join(PERSONAS_DIR, file), 'utf8'));
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
  if (!existsSync(MANIFEST)) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (error) {
    throw new Error(
      `malformed compiled-persona manifest at ${MANIFEST}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseManifestData(parsed);
}

export function compilePersonas({ log = console.log } = {}) {
  const sources = findPersonaSources();
  if (sources.length === 0) throw new Error('no */persona.ts found — nothing to compile');

  mkdirSync(PERSONAS_DIR, { recursive: true });

  const previousEntries = new Map(readManifest().map((entry) => [entry.file, entry]));
  const currentEntries = new Map(previousEntries);
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
    const personaId = persona.id.trim();
    const file = registrationFile(personaId);

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
      skipped.push({ dir, id: personaId, file });
      continue;
    }

    const clash = registered.get(personaId);
    if (clash) {
      // The personas directory is a flat namespace, so this would silently
      // publish whichever agent happened to compile second.
      throw new Error(`duplicate persona id "${personaId}": ${clash} and ${dir} both claim it`);
    }
    registered.set(personaId, dir);

    const target = join(PERSONAS_DIR, file);
    const previous = previousEntries.get(file);
    if (existsSync(target) && !previous) {
      throw new Error(`refusing to overwrite unmanaged persona registration ${file}`);
    }

    const body = `${JSON.stringify(rebaseRelativePaths(persona, join(repoRoot, dir)), null, 2)}\n`;
    writeFileSync(target, body, 'utf8');
    currentEntries.set(file, manifestEntryFor(file, body));
    writeManifest(currentEntries.values());
  }

  const files = [...registered.keys()].sort().map(registrationFile);
  const skippedFiles = new Set(skipped.map(({ file }) => file));
  const finalEntries = new Map(files.map((file) => [file, currentEntries.get(file)]));
  const stale = [...previousEntries.values()].filter((entry) => !finalEntries.has(entry.file));
  for (const entry of stale) {
    const file = entry.file;
    const target = join(PERSONAS_DIR, file);
    if (!existsSync(target)) {
      continue;
    }

    if (entry.sha256 && currentDigest(file) !== entry.sha256) {
      log(`Preserved ${file} — it no longer matches the registration previously written by ${MANIFEST_OWNER}`);
      continue;
    }

    if (!entry.sha256) {
      log(`Preserved ${file} — legacy manifest entry has no ownership fingerprint`);
      continue;
    }

    rmSync(target, { force: true });
    const reason = skippedFiles.has(file) ? 'it no longer declares a harness' : 'no agent publishes it any more';
    log(`Unregistered ${file} — ${reason}`);
  }

  writeManifest(finalEntries.values());

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

export {
  MANIFEST,
  PERSONAS_DIR,
  assertOwnedRegistrationFile,
  findPersonaSources,
  parseManifestData,
  rebaseRelativePaths,
  registrationFile,
};
