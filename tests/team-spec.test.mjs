import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validateTeamSpec } from '../scripts/validate-team-spec.mjs';

/**
 * Golden guard for every checked-in team spec: each `teams/<id>/team.json`
 * must satisfy the cloud TeamSpec contract (see scripts/validate-team-spec.mjs
 * for the mirrored rules) so the file can be POSTed to the team-binding route
 * verbatim. A spec that drifts from the contract fails at bind time with a
 * 4xx in production — this test moves that failure to CI.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const teamsRoot = join(repoRoot, 'teams');

const teamDirs = existsSync(teamsRoot)
  ? readdirSync(teamsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];

test('teams/ contains at least one team spec', () => {
  assert.ok(teamDirs.length > 0, 'expected at least one directory under teams/');
});

for (const teamDir of teamDirs) {
  test(`teams/${teamDir}/team.json satisfies the cloud TeamSpec contract`, () => {
    const specPath = join(teamsRoot, teamDir, 'team.json');
    assert.ok(existsSync(specPath), `missing ${specPath}`);
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    const errors = validateTeamSpec(spec, { expectedId: teamDir });
    assert.deepEqual(errors, [], `invalid team spec teams/${teamDir}/team.json`);
  });
}

test('cloud-team-issue roster references the deployed member personas', () => {
  const specPath = join(teamsRoot, 'cloud-team-issue', 'team.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  assert.deepEqual(
    spec.members.map((member) => member.persona?.slug ?? member.persona),
    ['cloud-team-implementer', 'cloud-team-reviewer'],
  );
});

test('cloud-team-issue member persona slugs match deployable persona ids', async () => {
  const specPath = join(teamsRoot, 'cloud-team-issue', 'team.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const slugs = spec.members.map((member) => member.persona?.slug ?? member.persona);

  for (const slug of slugs) {
    const { default: persona } = await import(`../.test-build/${slug}/persona.js`);
    assert.equal(persona.id, slug, `${slug} roster ref must match its persona id`);
  }
});

test('cloud-team-issue member agents are launched by the dispatcher', async () => {
  const specPath = join(teamsRoot, 'cloud-team-issue', 'team.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const slugs = spec.members.map((member) => member.persona?.slug ?? member.persona);

  for (const slug of slugs) {
    const { default: agent } = await import(`../.test-build/${slug}/agent.js`);
    assert.equal(agent.launchedBy, 'team-dispatcher', `${slug} agent must be dispatcher-launched`);
    assert.equal(agent.triggers, undefined, `${slug} agent must not declare direct triggers`);
    assert.equal(agent.schedules, undefined, `${slug} agent must not declare direct schedules`);
    assert.equal(agent.watch, undefined, `${slug} agent must not declare direct watches`);
  }
});

// Validator self-checks: prove each contract rule actually rejects, so a
// future edit that loosens the validator cannot silently green the suite.
const validSpec = {
  id: 'example',
  lead: 'example-lead',
  members: [
    { name: 'a', persona: { slug: 'persona-a' }, role: 'implementer' },
    { name: 'b', persona: 'persona-b' },
  ],
  tokenBudget: 400000,
  timeBudgetSeconds: 1800,
};

test('validator accepts a known-good spec', () => {
  assert.deepEqual(validateTeamSpec(validSpec, { expectedId: 'example' }), []);
});

const rejectionCases = [
  {
    label: 'id/directory mismatch',
    spec: { ...validSpec, id: 'other' },
    expectedId: 'example',
    needle: 'must match team directory',
  },
  {
    label: 'empty members',
    spec: { ...validSpec, members: [] },
    needle: 'members must be a non-empty array',
  },
  {
    label: 'duplicate member names',
    spec: {
      ...validSpec,
      members: [
        { name: 'a', persona: 'persona-a' },
        { name: 'a', persona: 'persona-b' },
      ],
    },
    needle: 'duplicate member name',
  },
  {
    label: 'persona ref without slug or path',
    spec: { ...validSpec, members: [{ name: 'a', persona: {} }] },
    needle: 'must include slug or path',
  },
  {
    label: 'inline persona ref (unsupported in Phase-1 binding)',
    spec: { ...validSpec, members: [{ name: 'a', persona: { inline: {} } }] },
    needle: 'inline is not supported',
  },
  {
    label: 'owns selector claimed by two members',
    spec: {
      ...validSpec,
      members: [
        { name: 'a', persona: 'persona-a', owns: [{ provider: 'github' }] },
        { name: 'b', persona: 'persona-b', owns: [{ provider: 'github' }] },
      ],
    },
    needle: 'claimed by both',
  },
  {
    label: 'owns selector claimed by an invalid empty-name member',
    spec: {
      ...validSpec,
      members: [
        { name: '', persona: 'persona-a', owns: [{ provider: 'github' }] },
        { name: 'b', persona: 'persona-b', owns: [{ provider: 'github' }] },
      ],
    },
    needle: 'claimed by both',
  },
  {
    label: 'non-integer token budget',
    spec: { ...validSpec, tokenBudget: 1.5 },
    needle: 'tokenBudget must be a positive 32-bit integer',
  },
];

for (const { label, spec, expectedId, needle } of rejectionCases) {
  test(`validator rejects: ${label}`, () => {
    const errors = validateTeamSpec(spec, { expectedId });
    assert.ok(
      errors.some((error) => error.includes(needle)),
      `expected an error containing "${needle}", got: ${JSON.stringify(errors)}`,
    );
  });
}
