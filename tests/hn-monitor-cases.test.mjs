import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

const casesDir = resolve('hn-monitor/cases');
const fixtureDir = resolve('hn-monitor/fixtures');
const legacyFixtureDir = resolve('evals/seeds');

const caseFiles = readdirSync(casesDir)
  .filter((name) => name.endsWith('.case.yaml'))
  .sort();
const cases = new Map(
  caseFiles.map((name) => {
    const path = join(casesDir, name);
    return [name, { path, value: parse(readFileSync(path, 'utf8')) }];
  }),
);

test('HN platform cases are one case per file with unique ids and safe writes', () => {
  assert.ok(caseFiles.length >= 6, 'expected the reference, parity, and provider-trigger cases');
  const ids = new Set();

  for (const [name, { path, value: caseSpec }] of cases) {
    assert.equal(caseSpec.schemaVersion, 1, `${name} schemaVersion`);
    assert.equal(caseSpec.agent, '../agent.ts', `${name} agent`);
    assert.equal(typeof caseSpec.id, 'string', `${name} id`);
    assert.ok(!ids.has(caseSpec.id), `duplicate case id ${caseSpec.id}`);
    ids.add(caseSpec.id);
    assert.equal(caseSpec.expect?.status, 'succeeded', `${name} expected status`);
    if (caseSpec.policy?.writes !== undefined) {
      assert.equal(caseSpec.policy.writes, 'preview', `${name} cannot enable live writes`);
    }

    for (const fixture of caseSpec.http ?? []) {
      assert.equal(fixture.method, 'GET', `${name} HTTP fixtures remain read-only`);
      const fixturePath = resolve(dirname(path), fixture.file);
      assert.ok(existsSync(fixturePath), `${name} references missing ${fixture.file}`);
      assert.doesNotThrow(() => JSON.parse(readFileSync(fixturePath, 'utf8')));
    }
  }
});

test('scheduled scan case keeps the reference policy and Slack thread assertion', () => {
  const scan = cases.get('scheduled-scan.case.yaml').value;
  assert.deepEqual(scan.event, { schedule: 'scan' });
  assert.deepEqual(scan.policy, {
    reads: 'fixtures',
    writes: 'preview',
    model: 'stub',
    shell: 'simulate',
    compose: 'preview',
  });
  assert.ok(scan.expect.logsContain.includes('hn-monitor.feed-scan'));
  assert.ok(scan.expect.effectsContain.includes('model.complete'));
  assert.ok(scan.expect.effectsContain.includes('provider.write'));
  assert.deepEqual(scan.expect.providerActions[0], {
    provider: 'slack',
    resource: 'messages',
    channel: 'C123',
    threaded: true,
    textContains: ['Agent'],
  });
});

test('deterministic feed case preserves story-selection and memory coverage', () => {
  const deterministic = cases.get('agentic-feeds.case.yaml').value;
  assert.deepEqual(
    deterministic.http.map((fixture) => fixture.match),
    ['tags=front_page', 'tags=show_hn', 'tags=story'],
  );
  assert.ok(
    deterministic.expect.logsContain.includes(
      'hn-monitor.feed-scan front_page=1 show_hn=1 new=2',
    ),
  );
  assert.ok(deterministic.expect.logsContain.includes('hn-monitor.matched-agentic matched=3'));
  assert.ok(deterministic.expect.logsContain.includes('hn-monitor.posted'));
  assert.ok(deterministic.expect.effectsContain.includes('memory.save'));
});

test('Slack provider-trigger case is multi-turn and shares the HN detail fixture', () => {
  const followUp = cases.get('slack-follow-up.case.yaml').value;
  assert.equal(followUp.turns.length, 2);
  assert.equal(followUp.turns[0].type, 'cron.tick');
  assert.equal(followUp.turns[1].type, 'slack.app_mention');
  assert.equal(followUp.turns[1].thread_ts, '200.1');
  assert.ok(followUp.http.some((fixture) => fixture.file === '../fixtures/hn-item-1001.json'));
  assert.ok(followUp.expect.logsContain.includes('hn-monitor.qa.hydrated'));
  assert.ok(followUp.expect.logsContain.includes('hn-monitor.qa.slack-replied'));
});

test('agent-local HTTP fixtures preserve the legacy eval inputs byte-for-byte', () => {
  const fixtureNames = [
    'hn-european-title-search.json',
    'hn-front-page.json',
    'hn-item-1001.json',
    'hn-item-4242.json',
    'hn-new.json',
    'hn-show-hn.json',
  ];

  for (const name of fixtureNames) {
    assert.equal(
      readFileSync(join(fixtureDir, name), 'utf8'),
      readFileSync(join(legacyFixtureDir, name), 'utf8'),
      `${name} drifted from the retained eval fixture`,
    );
  }
});

test('legacy HN eval and preview scripts remain available until platform parity', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  assert.match(pkg.scripts['evals:hn'], /run-evals/u);
  assert.match(pkg.scripts['preview:hn'], /preview-hn-monitor/u);
});
