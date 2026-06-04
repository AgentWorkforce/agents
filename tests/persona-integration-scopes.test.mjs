import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseIntegrations } from '@agentworkforce/persona-kit';
import { WRITEBACK_PATH_CATALOG } from '@relayfile/adapter-core/writeback-paths';

/**
 * Class guard for the agents#40 trap, generalized: cloud mounts an
 * integration's relayfile subtree ONLY from the agent's triggers or the
 * integration's `scope`. A provider that the handler touches through a
 * relay-helpers client but that has neither is mounted nowhere — every
 * read fails and every write is a silent no-op (the draft lands on
 * unmounted local disk and the writeback worker never sees it). That is
 * how the pr-reviewer's Slack pings (agents#40), hn-monitor's posts,
 * spotify-releases' DMs, vendor-monitor's posts, repo-hygiene's
 * slack/notion legs, and granola's Linear issue pipeline all shipped dead.
 *
 * Invariant: every provider referenced via `<provider>Client(` in a
 * persona's agent.ts must appear in the agent's `triggers` OR carry a
 * non-empty `scope` that survives persona-kit parsing (empty `scope: {}`
 * objects are DISCARDED client-side, so they don't count).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Provider names come from the writeback catalog itself, so a persona using
// a newly-catalogued provider is guarded automatically (no hand-kept list).
const PROVIDERS = Object.keys(WRITEBACK_PATH_CATALOG)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
// Three usage shapes, all of which require the provider's subtree mounted:
//   slackClient().post(...)                      — named factory client
//   relayClient('linear') / providerClient(...)  — generic factory client
//   writeJsonFile(c, 'notion', op, `/notion/…`)  — raw VFS helper w/ path literal
//
// Deliberate static-analysis trade-offs:
//   - Dynamic provider args (`relayClient(someVar)`) are invisible — the
//     guard can false-negative there; reviewers still check those by hand.
//   - Matching raw source means comments/strings can false-positive — the
//     safe direction for a guard (it forces a look, never hides a gap).
const CLIENT_RE = new RegExp(`\\b(${PROVIDERS})Client\\s*\\(`, 'g');
const GENERIC_CLIENT_RE = new RegExp(`\\b(?:relayClient|providerClient)\\s*\\(\\s*['"\`](${PROVIDERS})['"\`]`, 'g');
const PATH_LITERAL_RE = new RegExp(`['"\`]/(${PROVIDERS})/`, 'g');

function personaDirs() {
  return readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      existsSync(join(repoRoot, name, 'persona.ts')) &&
      existsSync(join(repoRoot, name, 'agent.ts')) &&
      existsSync(join(repoRoot, '.test-build', name, 'persona.js')) &&
      existsSync(join(repoRoot, '.test-build', name, 'agent.js')),
    );
}

function clientProviders(agentSource) {
  const providers = new Set();
  for (const re of [CLIENT_RE, GENERIC_CLIENT_RE, PATH_LITERAL_RE]) {
    for (const match of agentSource.matchAll(re)) {
      providers.add(match[1]);
    }
  }
  return providers;
}

test('every relay-helpers provider a persona uses is mounted via trigger or non-empty scope', async () => {
  const dirs = personaDirs();
  assert.ok(dirs.length >= 5, `expected to discover the persona set, found: ${dirs.join(', ')}`);

  const violations = [];
  for (const dir of dirs) {
    const agentSource = readFileSync(join(repoRoot, dir, 'agent.ts'), 'utf8');
    const used = clientProviders(agentSource);
    if (used.size === 0) continue;

    const { default: persona } = await import(`../.test-build/${dir}/persona.js`);
    const { default: agent } = await import(`../.test-build/${dir}/agent.js`);
    const parsed = parseIntegrations(persona.integrations ?? {}, `${dir}.integrations`) ?? {};
    const triggerProviders = new Set(Object.keys(agent?.triggers ?? {}));

    for (const provider of used) {
      const scope = parsed[provider]?.scope;
      const hasScope = Boolean(scope && Object.keys(scope).length > 0);
      if (!triggerProviders.has(provider) && !hasScope) {
        violations.push(`${dir}: touches "${provider}" via relay-helpers/VFS but it has no trigger and no scope — nothing mounts /${provider}, so its reads fail and its writes are silent no-ops`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `personas with unmounted relay-helpers providers:\n  ${violations.join('\n  ')}\n` +
      'Fix: add a scope to the integration (e.g. slack posts → { scope: { paths: "/slack/channels/**" } }, ' +
      'slack DMs → "/slack/users/**", linear issues/comments → "/linear/issues/**") or declare a trigger. ' +
      'See the writing-agent-personas skill §1.',
  );
});
