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
 *
 * Tightened sub-invariant (linear-slack, 2026-06): a trigger mounts a READ
 * mirror of the watched subtree. For providers whose mirror path is
 * DISPLAY-LABELLED (`/slack/channels/{id}__{name}/…`) the mirror never covers
 * the canonical bare-id WRITEBACK path (`/slack/channels/{id}/messages`), so a
 * trigger cannot carry a write there. For those providers (`WRITEBACK_NEEDS_SCOPE`)
 * a WRITE requires a non-empty `scope` even when a trigger exists — otherwise
 * the post lands on unmounted disk and is a silent no-op despite `handler.ok`.
 * github/linear are immune (trigger and writeback share one bare id form).
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

// Providers where a trigger does NOT satisfy a write (mirror path is
// display-labelled, writeback path is bare-id — they never coincide). See the
// tightened sub-invariant above.
const WRITEBACK_NEEDS_SCOPE = new Set(['slack']);
// Relay-helpers write surfaces: named-client write methods and the generic
// `.write(`. Coarse on purpose — a false positive just forces a look, it never
// hides a write.
const WRITE_METHOD_RE = /\.(?:post|reply|dm|react|comment|respond|acknowledge|agentActivity|write)\s*\(/;

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

// Which of `used` providers the handler WRITES to: a named `<p>Client(` paired
// with any write method, a `relayClient('p')`/`providerClient('p')` paired with
// `.write(`, or a raw `writeJsonFile(c, 'p', …)`. Method↔provider pairing is
// coarse (a multi-client file flags both as writers) — fine for a guard that
// errs toward forcing a look.
function writeProviders(agentSource, used) {
  const hasWriteMethod = WRITE_METHOD_RE.test(agentSource);
  const writes = new Set();
  for (const provider of used) {
    const usesNamedClient = new RegExp(`\\b${provider}Client\\s*\\(`).test(agentSource);
    const rawVfsWrite =
      new RegExp(`writeJsonFile\\s*\\(\\s*[^,]+,\\s*['"\`]${provider}['"\`]`).test(agentSource) ||
      (new RegExp(`\\b(?:relayClient|providerClient)\\s*\\(\\s*['"\`]${provider}['"\`]`).test(agentSource) &&
        /\.write\s*\(/.test(agentSource));
    if ((usesNamedClient && hasWriteMethod) || rawVfsWrite) writes.add(provider);
  }
  return writes;
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
    const writes = writeProviders(agentSource, used);

    for (const provider of used) {
      const scope = parsed[provider]?.scope;
      const hasScope = Boolean(scope && Object.keys(scope).length > 0);
      const hasTrigger = triggerProviders.has(provider);

      // Stricter rule first: a write to a display-labelled provider needs a
      // scope even with a trigger present (the trigger mirror never covers the
      // bare-id writeback path).
      if (writes.has(provider) && WRITEBACK_NEEDS_SCOPE.has(provider) && !hasScope) {
        violations.push(`${dir}: WRITES to "${provider}" with no scope — a ${provider} trigger only mirrors the display-labelled path (/${provider}/channels/{id}__{name}/…) read-only and never covers the bare-id writeback path, so the write lands on unmounted disk and is a silent no-op. A trigger does NOT satisfy a ${provider} write; add a scope (e.g. { scope: { paths: "/${provider}/channels/**" } }).`);
        continue;
      }

      if (!hasTrigger && !hasScope) {
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
