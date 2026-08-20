import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MANIFEST,
  PERSONAS_DIR,
  assertOwnedRegistrationFile,
  findPersonaSources,
  parseManifestData,
  registrationCollisionKey,
  rebaseRelativePaths,
  registrationFile,
} from '../scripts/compile-personas.mjs';

/**
 * Guards `npm run compile`'s registration step.
 *
 * Compiling a persona is not enough to make it runnable: the CLI reads
 * `<cwd>/.agentworkforce/workforce/personas/*.json` and does NOT recurse, so a
 * persona living in `<agent>/` is invisible to `agentworkforce agent` and the
 * symptom is `Unknown persona "hn-monitor"` next to a list that omits it. The
 * compile step copies each persona into that directory; these tests pin the
 * three things about the copy that fail silently rather than loudly.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function builtPersonaDirs() {
  return findPersonaSources()
    .map(({ dir }) => dir)
    .filter((dir) => existsSync(join(repoRoot, '.test-build', dir, 'persona.js')));
}

test('every directory holding a persona.ts is discovered, and nothing else is', () => {
  const discovered = findPersonaSources().map(({ dir }) => dir);
  const expected = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(repoRoot, name, 'persona.ts')))
    .sort();

  assert.deepEqual(discovered, expected);
  assert.ok(discovered.length >= 15, `expected the persona set, found ${discovered.length}`);
});

test('a directory with a stale persona.json but no persona.ts is not discovered', () => {
  // PR #91 folded the standalone Telegram agents into dual-transport ones. Their
  // tracked files went with it, but `*/persona.json` is gitignored, so the built
  // artifact survived the delete on every machine that had compiled before. The
  // source file is the only honest signal that an agent still exists.
  const discovered = new Set(findPersonaSources().map(({ dir }) => dir));
  const orphans = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(repoRoot, name, 'persona.json')) && !existsSync(join(repoRoot, name, 'persona.ts')));

  for (const orphan of orphans) {
    assert.equal(discovered.has(orphan), false, `${orphan} has no persona.ts and must not be registered`);
  }
});

test('persona ids are unique — the personas directory is a flat namespace', async () => {
  const seen = new Map();
  for (const dir of builtPersonaDirs()) {
    const { default: persona } = await import(`../.test-build/${dir}/persona.js`);
    const clash = seen.get(persona.id);
    assert.equal(clash, undefined, `duplicate persona id "${persona.id}": ${clash} and ${dir}`);
    seen.set(persona.id, dir);
  }
  assert.ok(seen.size >= 15, `expected the persona set, found ${seen.size}`);
});

test('registration is keyed on the persona id, which is not always the directory name', async () => {
  // granola/ publishes granola-prospect, linear/ publishes linear-chat-lead, and
  // review/ publishes pr-reviewer. Naming the registered file after the
  // directory would publish all three under a name `agentworkforce agent` then
  // cannot resolve.
  const renamed = [];
  for (const dir of builtPersonaDirs()) {
    const { default: persona } = await import(`../.test-build/${dir}/persona.js`);
    if (persona.id !== dir) renamed.push(`${dir} -> ${persona.id}`);
  }
  assert.ok(renamed.length > 0, 'expected at least one persona whose id differs from its directory');
});

test('a persona that declares a harness declares everything needed to launch it', async () => {
  // persona-registry rejects a standalone persona missing any of these and warns
  // on EVERY CLI invocation. A persona with no harness at all is a different
  // thing — a pure fetch-and-deliver handler — and the compile step skips it.
  const incomplete = [];
  for (const dir of builtPersonaDirs()) {
    const { default: persona } = await import(`../.test-build/${dir}/persona.js`);
    if (typeof persona.harness !== 'string' || !persona.harness.trim()) continue;

    for (const field of ['intent', 'description', 'model', 'systemPrompt', 'harnessSettings']) {
      if (persona[field] === undefined) incomplete.push(`${dir}: harness "${persona.harness}" but no ${field}`);
    }
  }
  assert.deepEqual(incomplete, [], `personas the local CLI would refuse to launch:\n${incomplete.join('\n')}`);
});

test('relative paths are rebased so they still resolve from the personas directory', () => {
  const agentDir = join(repoRoot, 'hn-monitor');
  const rebased = rebaseRelativePaths(
    { onEvent: './agent.ts', skills: [{ id: 'local', source: '../shared/voice.md' }] },
    agentDir,
  );

  assert.equal(resolve(PERSONAS_DIR, rebased.onEvent), join(agentDir, 'agent.ts'));
  assert.equal(resolve(PERSONAS_DIR, rebased.skills[0].source), join(repoRoot, 'shared', 'voice.md'));
  assert.notEqual(rebased.onEvent, './agent.ts', 'a straight copy would point at a handler that is not there');
});

test('Windows-style relative paths are normalized before rebasing', () => {
  const agentDir = join(repoRoot, 'hn-monitor');
  const rebased = rebaseRelativePaths(
    { onEvent: '.\\agent.ts', skills: [{ id: 'local', source: '..\\shared\\voice.md' }] },
    agentDir,
  );

  assert.equal(resolve(PERSONAS_DIR, rebased.onEvent), join(agentDir, 'agent.ts'));
  assert.equal(resolve(PERSONAS_DIR, rebased.skills[0].source), join(repoRoot, 'shared', 'voice.md'));
});

test('package specs and URLs are left alone by the rebase', () => {
  const skills = [
    { id: 'a', source: '@agent-relay/gtm-context' },
    { id: 'b', source: 'https://example.com/skill.md' },
  ];
  const rebased = rebaseRelativePaths({ skills }, join(repoRoot, 'hn-monitor'));
  assert.deepEqual(rebased.skills, skills);
});

test('the manifest lives outside the personas directory', () => {
  // The CLI scans that directory for `*.json` and reports anything without an
  // `id` as a broken persona — which is the warning this whole change removes.
  const inside = relative(PERSONAS_DIR, MANIFEST);
  assert.ok(inside.startsWith('..') || isAbsolute(inside), `${MANIFEST} would be scanned as a persona`);
});

test('registration filenames are constrained to the flat personas directory', () => {
  assert.equal(registrationFile('hn-monitor'), 'hn-monitor.json');
  assert.throws(() => registrationFile('team/foo'), /invalid persona id/);
  assert.throws(() => registrationFile('..'), /invalid persona id/);
  assert.throws(() => registrationFile('persona*name'), /invalid persona id/);
  assert.equal(assertOwnedRegistrationFile('hn-monitor.json'), 'hn-monitor.json');
  assert.throws(() => assertOwnedRegistrationFile('../hn-monitor.json'), /invalid compiled-persona manifest entry/);
  assert.equal(registrationCollisionKey('Foo.json'), registrationCollisionKey('foo.json'));
});

test('manifest parsing rejects malformed or escaping entries', () => {
  assert.deepEqual(parseManifestData({ files: ['hn-monitor.json'] }), [{ file: 'hn-monitor.json' }]);
  assert.deepEqual(parseManifestData({
    entries: [{ file: 'hn-monitor.json', sha256: 'a'.repeat(64) }],
  }), [{ file: 'hn-monitor.json', sha256: 'a'.repeat(64) }]);
  assert.throws(() => parseManifestData({ files: ['../hn-monitor.json'] }), /invalid compiled-persona manifest entry/);
  assert.throws(() => parseManifestData({ entries: [{ file: 'hn-monitor.json', sha256: 'not-a-digest' }] }), /invalid compiled-persona manifest digest/);
  assert.throws(() => parseManifestData({ nope: [] }), /compiled-persona manifest must contain an entries\[\] or files\[\] array/);
});
