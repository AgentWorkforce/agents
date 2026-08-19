import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  UsageError,
  buildDeployArgs,
  deployAgents,
  formatMissingInputs,
  loadRegistry,
  missingWorkspaceSecrets,
  parseArgs,
  parseInputBundle,
  personaPaths,
  redactDeployArgs,
  resolvePersonaInputs,
  selectAgents,
} from '../scripts/deploy/deploy-agents.mjs';

/**
 * Guards for the self-deploy path: the registry every fork dispatches against,
 * the input resolution that turns a persona's declared inputs into `--input`
 * flags, and the two things a PUBLIC repo cannot afford to get wrong — a
 * committed credential, and a workflow trigger that runs fork code with the
 * workspace token in scope.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadRegistry();

function makeLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
}

// --- registry ---------------------------------------------------------------

test('every top-level agent directory is in the deploy registry', () => {
  const onDisk = readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, entry.name, 'persona.ts')))
    .map((entry) => entry.name)
    .sort();
  const registered = registry.agents.map((agent) => agent.name).sort();
  assert.deepEqual(
    registered,
    onDisk,
    'scripts/deploy/agents.json has drifted from the agents on disk — add the new agent there so it can be deployed',
  );
});

test('every registry entry points at a persona that exists', () => {
  for (const agent of registry.agents) {
    assert.equal(agent.persona, `${agent.name}/persona.ts`, `${agent.name}: persona path should match its name`);
    assert.ok(existsSync(personaPaths(agent).personaTs), `${agent.name}: missing ${agent.persona}`);
  }
});

test('the registry commits no credentials or workspace-specific ids', () => {
  // This repo is public and the registry is the one deploy file people edit.
  // Per-agent values belong in env/secrets, never here.
  const raw = readFileSync(join(repoRoot, 'scripts', 'deploy', 'agents.json'), 'utf8');
  const forbidden = [
    [/\brk_[A-Za-z0-9]{8,}/u, 'a workspace token'],
    [/\brw_[0-9a-f]{6,}/u, 'a relay workspace id'],
    [/"[CDGU][0-9A-Z]{8,}"/u, 'a Slack channel/user id'],
    [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u, 'a UUID'],
  ];
  for (const [pattern, what] of forbidden) {
    assert.equal(pattern.test(raw), false, `agents.json appears to contain ${what}`);
  }
});

// --- argument parsing -------------------------------------------------------

test('parseArgs reads selection, mode, and repeated inputs', () => {
  const args = parseArgs([
    '--agent', 'hn-monitor',
    '--agent', 'review',
    '--input', 'SLACK_CHANNEL=C0123ABCD',
    '--input', 'TOPICS=a=b,c',
    '--dry-run',
    '--skip-compile',
    '--fail-fast',
  ]);
  assert.deepEqual(args.agents, ['hn-monitor', 'review']);
  // Only the FIRST '=' separates key from value, so values may contain '='.
  assert.deepEqual(args.inputs, { SLACK_CHANNEL: 'C0123ABCD', TOPICS: 'a=b,c' });
  assert.deepEqual(
    [args.dryRun, args.skipCompile, args.failFast, args.all],
    [true, true, true, false],
  );
});

test('parseArgs rejects unknown flags and missing values', () => {
  assert.throws(() => parseArgs(['--deploy-everything']), UsageError);
  assert.throws(() => parseArgs(['--agent']), UsageError);
  assert.throws(() => parseArgs(['--agent', '--all']), UsageError);
  assert.throws(() => parseArgs(['--input', 'NOEQUALS']), UsageError);
});

test('parseInputBundle reads KEY=VALUE lines, ignoring blanks and comments', () => {
  assert.deepEqual(
    parseInputBundle('\n# a comment\nSLACK_CHANNEL=C0123ABCD\n\n  TOPICS=agents, ai  \n'),
    { SLACK_CHANNEL: 'C0123ABCD', TOPICS: 'agents, ai' },
  );
  assert.deepEqual(parseInputBundle(''), {});
  assert.deepEqual(parseInputBundle(undefined), {});
  assert.throws(() => parseInputBundle('JUST_A_NAME'), UsageError);
});

test('a malformed AGENT_INPUTS line is reported by number, never by content', () => {
  // The bundle carries persona inputs, which may be secrets, and this error is
  // printed into the workflow log.
  const sentinel = 'sk-live-do-not-log-this';
  assert.throws(
    () => parseInputBundle(`SLACK_CHANNEL=C0123ABCD\n${sentinel}`),
    (err) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.message.includes(sentinel), false, 'the error must not quote the line');
      assert.match(err.message, /line 2 is not <key>=<value>/u);
      return true;
    },
  );
});

test('parseInputBundle lets later lines win, which is what stacks vars < secrets < dispatch', () => {
  // The workflow concatenates vars.AGENT_INPUTS, secrets.AGENT_INPUTS and the
  // dispatch box in that order, so this ordering IS the documented precedence.
  assert.deepEqual(
    parseInputBundle('SLACK_CHANNEL=C0FROMVAR\nSLACK_CHANNEL=C0FROMDISPATCH'),
    { SLACK_CHANNEL: 'C0FROMDISPATCH' },
  );
});

test('selectAgents resolves names, honours --all, and refuses unknown ones', () => {
  const agents = [{ name: 'a', persona: 'a/persona.ts' }, { name: 'b', persona: 'b/persona.ts' }];
  assert.deepEqual(selectAgents(parseArgs(['--agent', 'b']), agents), [agents[1]]);
  assert.deepEqual(selectAgents(parseArgs(['--all']), agents), agents);
  assert.throws(() => selectAgents(parseArgs(['--agent', 'nope']), agents), /unknown agent\(s\): nope/u);
  assert.throws(() => selectAgents(parseArgs([]), agents), /nothing selected/u);
});

// --- input resolution -------------------------------------------------------

const SPECS = {
  SLACK_CHANNEL: { env: 'SLACK_CHANNEL', description: 'Channel to post to.' },
  TOPICS: { env: 'TOPICS', default: 'agents' },
  TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', optional: true },
  RENAMED: { env: 'A_DIFFERENT_ENV_NAME' },
};

test('resolvePersonaInputs applies override > bundle > env > default', () => {
  const { resolved, missing } = resolvePersonaInputs(SPECS, {
    overrides: { SLACK_CHANNEL: 'C0FROMFLAG' },
    bundle: { SLACK_CHANNEL: 'C0FROMBUNDLE', TOPICS: 'from-bundle' },
    env: { SLACK_CHANNEL: 'C0FROMENV', TOPICS: 'from-env', A_DIFFERENT_ENV_NAME: 'renamed-value' },
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(resolved, {
    SLACK_CHANNEL: 'C0FROMFLAG',
    TOPICS: 'from-bundle',
    RENAMED: 'renamed-value',
  });
  assert.equal('TELEGRAM_CHAT' in resolved, false, 'an unset optional input must not be passed at all');
});

test('resolvePersonaInputs falls back to the env name, then the persona default', () => {
  const { resolved } = resolvePersonaInputs(SPECS, {
    env: { SLACK_CHANNEL: 'C0FROMENV', A_DIFFERENT_ENV_NAME: 'x' },
  });
  assert.equal(resolved.SLACK_CHANNEL, 'C0FROMENV');
  assert.equal(resolved.TOPICS, 'agents');
});

test('resolvePersonaInputs reports required inputs that resolve to nothing', () => {
  // Empty and whitespace-only are "unset": an empty GitHub secret must fail
  // loudly rather than deploy an agent configured with "".
  const { missing } = resolvePersonaInputs(SPECS, { env: { SLACK_CHANNEL: '   ' } });
  assert.deepEqual(
    missing.map((entry) => entry.name).sort(),
    ['RENAMED', 'SLACK_CHANNEL'],
  );
  const message = formatMissingInputs('hn-monitor', missing);
  assert.match(message, /hn-monitor: 2 required input\(s\) unresolved/u);
  assert.match(message, /set env A_DIFFERENT_ENV_NAME=<value>/u, 'names the env var the persona declared');
  assert.match(message, /Channel to post to\./u, "quotes the persona's own description");
});

test('resolvePersonaInputs on a persona with no declared inputs is a no-op', () => {
  assert.deepEqual(resolvePersonaInputs({}, { env: {} }), { resolved: {}, sources: {}, missing: [] });
});

// --- inherited tenant identifiers -------------------------------------------

const TENANT_SPECS = { GCP_PROJECT_ID: { env: 'GCP_PROJECT_ID', default: 'someone-elses-project' } };

test('resolvePersonaInputs refuses to inherit a persona default listed in requireExplicit', () => {
  // Without this, a fork deploying gcp-watcher silently monitors the ORIGINAL
  // owner's project, because the persona ships that project id as its default.
  const { resolved, missing } = resolvePersonaInputs(TENANT_SPECS, {
    env: {},
    requireExplicit: ['GCP_PROJECT_ID'],
  });
  assert.deepEqual(resolved, {}, 'the persona default must not be inherited');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].explicitOnly, true);
  const message = formatMissingInputs('gcp-watcher', missing);
  assert.match(message, /identifies YOUR account or project/u);
});

test('requireExplicit still accepts a value the deployer actually supplied', () => {
  for (const [label, options] of [
    ['--input', { overrides: { GCP_PROJECT_ID: 'my-project' }, env: {} }],
    ['bundle', { bundle: { GCP_PROJECT_ID: 'my-project' }, env: {} }],
    ['env', { env: { GCP_PROJECT_ID: 'my-project' } }],
  ]) {
    const { resolved, missing } = resolvePersonaInputs(TENANT_SPECS, {
      ...options,
      requireExplicit: ['GCP_PROJECT_ID'],
    });
    assert.deepEqual(missing, [], `${label} should satisfy requireExplicit`);
    assert.equal(resolved.GCP_PROJECT_ID, 'my-project');
  }
});

test('requireExplicit overrides `optional`, so an unset tenant id is never skipped', () => {
  const { missing } = resolvePersonaInputs(
    { ORG: { env: 'ORG', optional: true, default: 'theirs' } },
    { env: {}, requireExplicit: ['ORG'] },
  );
  assert.deepEqual(missing.map((entry) => entry.name), ['ORG']);
});

test('resolvePersonaInputs reports where each value came from', () => {
  const { sources } = resolvePersonaInputs(SPECS, {
    overrides: { SLACK_CHANNEL: 'C0FROMFLAG' },
    env: { A_DIFFERENT_ENV_NAME: 'x' },
  });
  assert.deepEqual(sources, {
    SLACK_CHANNEL: '--input',
    TOPICS: 'persona default',
    RENAMED: 'env A_DIFFERENT_ENV_NAME',
  });
});

/**
 * The `inputs: { ... }` block of a persona, as name -> default. Scoped to that
 * block (so unrelated fields called `default` elsewhere are ignored) and
 * anchored on a property position (so `description: '... (default: Foo)'` is not
 * mistaken for one).
 */
function personaInputDefaults(source) {
  const marker = source.indexOf('inputs:');
  if (marker === -1) return {};
  const open = source.indexOf('{', marker);
  if (open === -1) return {};
  let depth = 0;
  let close = open;
  for (; close < source.length; close++) {
    if (source[close] === '{') depth++;
    else if (source[close] === '}' && --depth === 0) break;
  }
  const block = source.slice(open + 1, close);

  const defaults = {};
  const entry = /(\w+)\s*:\s*\{/gu;
  for (let match = entry.exec(block); match; match = entry.exec(block)) {
    let inner = 1;
    let i = match.index + match[0].length;
    for (; i < block.length && inner > 0; i++) {
      if (block[i] === '{') inner++;
      else if (block[i] === '}') inner--;
    }
    const body = block.slice(match.index + match[0].length, i - 1);
    const value = /(?:^|[{,])\s*default\s*:\s*'([^']*)'/u.exec(body);
    if (value) defaults[match[1]] = value[1];
    entry.lastIndex = i;
  }
  return defaults;
}

test('personaInputDefaults reads only real input defaults', () => {
  // Guards the guard: an earlier version of this scan matched `default:` inside
  // a description string, and fields named `default` outside the inputs block.
  const defaults = personaInputDefaults(`definePersona({
  sandbox: { materialization: 'lazy' },
  inputs: {
    ORG: {
      description: 'GitHub org to watch (default: TheirOrg).',
      env: 'ORG',
      default: 'RealValue'
    },
    CHANNEL: { env: 'CHANNEL', optional: true, picker: { provider: 'slack', resource: 'channels' } }
  },
});`);
  assert.deepEqual(defaults, { ORG: 'RealValue' });
});

test('no persona default that looks like this repo owner is inheritable', () => {
  // A HEURISTIC net, not a proof: it catches identifiers shaped like an org,
  // project, or account, plus anything naming this repo's own org. Review is
  // still what catches a default this cannot recognise — a bare account name in
  // an unfamiliar shape will slip through. What it does guarantee is that the
  // four known cases stay listed and that an obvious new one fails CI.
  const ownerish = [
    [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, 'a UUID'],
    [/^org-[a-z0-9-]+$/u, 'an org id'],
    [/^[a-z0-9-]+-(?:production|prod|staging)$/u, 'an environment-specific project id'],
    [/agentworkforce/iu, "this repo's own GitHub org"],
  ];
  const found = [];
  for (const agent of registry.agents) {
    const defaults = personaInputDefaults(readFileSync(personaPaths(agent).personaTs, 'utf8'));
    const declared = new Set(agent.requireExplicit ?? []);
    for (const [name, value] of Object.entries(defaults)) {
      const hit = ownerish.find(([pattern]) => pattern.test(value));
      if (!hit) continue;
      found.push(`${agent.name}.${name}`);
      assert.ok(
        declared.has(name),
        `${agent.name}: persona default ${name}='${value}' looks like ${hit[1]} belonging to this `
          + "repo's owner — add it to requireExplicit in scripts/deploy/agents.json so a fork "
          + 'cannot inherit it',
      );
    }
  }
  // Non-vacuity: if this stops finding the known cases, the scan broke.
  assert.deepEqual(
    found.sort(),
    ['daytona-monitor.DAYTONA_ORG_ID', 'gcp-watcher.GCP_PROJECT_ID', 'neon-monitor.NEON_ORG_ID', 'pr-shepherd.ORG'],
  );
});

test('every requireExplicit entry names an input the persona actually declares', () => {
  for (const agent of registry.agents) {
    const defaults = personaInputDefaults(readFileSync(personaPaths(agent).personaTs, 'utf8'));
    for (const name of agent.requireExplicit ?? []) {
      assert.ok(
        name in defaults,
        `${agent.name}: requireExplicit lists ${name}, but its persona declares no default for it — `
          + 'the entry is stale or misspelled',
      );
    }
  }
});

// --- deploy invocation ------------------------------------------------------

test('buildDeployArgs produces a headless, idempotent deploy', () => {
  const args = buildDeployArgs('hn-monitor/persona.json', 'cloud', { SLACK_CHANNEL: 'C0123ABCD' });
  assert.deepEqual(args, [
    'deploy', 'hn-monitor/persona.json',
    '--mode', 'cloud',
    '--no-prompt', '--no-connect',
    '--on-exists', 'update',
    '--input', 'SLACK_CHANNEL=C0123ABCD',
  ]);
});

test('redactDeployArgs keeps input names and drops input values', () => {
  const printed = redactDeployArgs(buildDeployArgs('a/persona.json', 'cloud', { SPOTIFY_TOKEN: 'secret-value' }));
  assert.deepEqual(printed.slice(-2), ['--input', 'SPOTIFY_TOKEN=<set>']);
  assert.equal(printed.join(' ').includes('secret-value'), false);
});

test('missingWorkspaceSecrets names only what is absent, never a value', () => {
  assert.deepEqual(missingWorkspaceSecrets({}), ['WORKFORCE_WORKSPACE_ID', 'WORKFORCE_WORKSPACE_TOKEN']);
  assert.deepEqual(
    missingWorkspaceSecrets({ WORKFORCE_WORKSPACE_ID: 'ws', WORKFORCE_WORKSPACE_TOKEN: '  ' }),
    ['WORKFORCE_WORKSPACE_TOKEN'],
    'a whitespace-only secret counts as missing',
  );
  assert.deepEqual(missingWorkspaceSecrets({ WORKFORCE_WORKSPACE_ID: 'ws', WORKFORCE_WORKSPACE_TOKEN: 'rk_x' }), []);
});

/** A throwaway repo root holding one persona, for end-to-end runs. */
function fixtureRoot(inputs, { compiled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-agents-'));
  mkdirSync(join(root, 'demo'));
  writeFileSync(join(root, 'demo', 'persona.ts'), 'export default {};\n');
  if (compiled) writeFileSync(join(root, 'demo', 'persona.json'), JSON.stringify({ id: 'demo', inputs }));
  return root;
}

test('deployAgents spawns the compile and deploy commands with the resolved inputs', () => {
  const root = fixtureRoot({ SLACK_CHANNEL: { env: 'SLACK_CHANNEL' } });
  const selected = [{ name: 'demo', persona: 'demo/persona.ts' }];
  const calls = [];
  const failures = deployAgents({
    args: parseArgs([]),
    registry: { mode: 'cloud', agents: selected },
    selected,
    root,
    env: { SLACK_CHANNEL: 'C0123ABCD' },
    spawn: (command, argv) => {
      calls.push(argv);
      return { status: 0 };
    },
    log: makeLog(),
  });
  assert.deepEqual(failures, []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(-3), ['persona', 'compile', join('demo', 'persona.ts')]);
  assert.deepEqual(calls[1].slice(-2), ['--input', 'SLACK_CHANNEL=C0123ABCD']);
  assert.ok(calls[1].includes('--no-prompt') && calls[1].includes('--no-connect'));
});

test('deployAgents fails an agent whose required input is unresolved, without deploying it', () => {
  const root = fixtureRoot({ SLACK_CHANNEL: { env: 'SLACK_CHANNEL' } });
  const selected = [{ name: 'demo', persona: 'demo/persona.ts' }];
  const calls = [];
  const log = makeLog();
  const failures = deployAgents({
    args: parseArgs(['--skip-compile']),
    registry: { mode: 'cloud', agents: selected },
    selected,
    root,
    env: {},
    spawn: (command, argv) => {
      calls.push(argv);
      return { status: 0 };
    },
    log,
  });
  assert.deepEqual(failures, ['demo']);
  assert.deepEqual(calls, [], 'nothing may be deployed when an input is missing');
  assert.match(log.lines.join('\n'), /set env SLACK_CHANNEL=<value>/u);
});

test('deployAgents --dry-run compiles but never deploys, and prints no input values', () => {
  const root = fixtureRoot({ SPOTIFY_TOKEN: { env: 'SPOTIFY_TOKEN' } });
  const selected = [{ name: 'demo', persona: 'demo/persona.ts' }];
  const log = makeLog();
  const calls = [];
  const failures = deployAgents({
    args: parseArgs(['--dry-run']),
    registry: { mode: 'cloud', agents: selected },
    selected,
    root,
    env: { SPOTIFY_TOKEN: 'super-secret' },
    spawn: (command, argv) => {
      // Compiling is allowed (it only writes gitignored build artifacts);
      // deploying is not.
      assert.deepEqual(argv.slice(-3), ['persona', 'compile', join('demo', 'persona.ts')]);
      calls.push(argv);
      return { status: 0 };
    },
    log,
  });
  assert.equal(calls.length, 1, 'a dry run compiles exactly once and deploys nothing');
  assert.deepEqual(failures, []);
  const output = log.lines.join('\n');
  assert.match(output, /\[dry-run\] demo/u);
  assert.match(output, /SPOTIFY_TOKEN=<set>/u);
  assert.equal(output.includes('super-secret'), false, 'a dry run must never print an input value');
});

test('deployAgents --dry-run --skip-compile tolerates an uncompiled persona', () => {
  // persona.json is a build artifact and is gitignored, so a fresh clone has
  // none. Told not to compile, a rehearsal must still report rather than fail.
  const root = fixtureRoot({}, { compiled: false });
  const selected = [{ name: 'demo', persona: 'demo/persona.ts' }];
  const log = makeLog();
  const failures = deployAgents({
    args: parseArgs(['--dry-run', '--skip-compile']),
    registry: { mode: 'cloud', agents: selected },
    selected,
    root,
    env: {},
    spawn: () => assert.fail('a dry run must not spawn anything'),
    log,
  });
  assert.deepEqual(failures, []);
  assert.match(log.lines.join('\n'), /persona not compiled/u);
});

// --- public-repo safety -----------------------------------------------------

const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy-agent.yml'), 'utf8');
const action = readFileSync(join(repoRoot, '.github', 'actions', 'deploy-agent', 'action.yml'), 'utf8');

test('the deploy workflow is never triggerable by a pull request', () => {
  // A fork PR that could run with these secrets in scope could edit any file
  // this job executes and exfiltrate WORKFORCE_WORKSPACE_TOKEN.
  for (const trigger of ['pull_request_target', 'pull_request']) {
    assert.equal(
      new RegExp(`^\\s*${trigger}:`, 'mu').test(workflow),
      false,
      `deploy-agent.yml must not be triggered by ${trigger} — this repo is public`,
    );
  }
  assert.match(workflow, /^\s*workflow_dispatch:/mu);
});

test('the deploy job declares the environment that resolves its secrets', () => {
  // A composite action runs inside this job, so `environment:` here is what
  // makes secrets.WORKFORCE_* non-empty. A reusable workflow would not.
  assert.match(workflow, /^\s*environment: workforce$/mu);
  assert.match(action, /^\s*using: composite$/mu);
  assert.equal(/workflow_call:/u.test(action), false, 'the deploy steps must stay a composite action');
});

test('no workflow interpolates user-controlled input directly into a shell script', () => {
  // `${{ inputs.x }}` inside `run:` is shell injection; these values must reach
  // the script through `env:` instead.
  for (const [name, source] of [['deploy-agent.yml', workflow], ['action.yml', action]]) {
    const runBlocks = source.split(/^\s*run: \|?/mu).slice(1);
    for (const block of runBlocks) {
      assert.equal(
        /\$\{\{\s*(inputs|github\.event)\./u.test(block.split(/^\s{0,6}- /mu)[0]),
        false,
        `${name}: a run: block interpolates user-controlled input`,
      );
    }
  }
});
