#!/usr/bin/env node
/**
 * deploy-agents — deploy an agent from this repo to YOUR Agent Workforce
 * workspace, headlessly. No interactive login, no TTY pickers, no per-agent
 * script: fork the repo, set two secrets, dispatch the workflow.
 *
 * Auth is the deploy CLI's documented "explicit env vars" path:
 * `WORKFORCE_WORKSPACE_ID` + `WORKFORCE_WORKSPACE_TOKEN`. See docs/SELF-DEPLOY.md
 * for where to get them. Nothing here ever prints a secret.
 *
 * The agent set lives in scripts/deploy/agents.json — name + persona path only.
 * Per-agent inputs are NOT duplicated there: every persona already declares its
 * own `inputs` (with `env`, `default`, `optional`), so this script reads the
 * compiled persona.json and resolves each declared input itself. Adding an
 * input to a persona needs no change here, and no channel/org id ever has to be
 * committed to this public repo.
 *
 * Deploys are idempotent (`--on-exists update`) and reuse already-connected
 * integrations (`--no-connect`), which fails loudly rather than prompting when
 * a persona needs an integration the workspace has not connected yet.
 *
 * Usage:
 *   node scripts/deploy/deploy-agents.mjs --list
 *   node scripts/deploy/deploy-agents.mjs --agent hn-monitor
 *   node scripts/deploy/deploy-agents.mjs --agent hn-monitor --input SLACK_CHANNEL=C0123ABCD
 *   node scripts/deploy/deploy-agents.mjs --all --dry-run
 *   node scripts/deploy/deploy-agents.mjs --agent review --skip-compile
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAgentworkforceInvocation, repoRoot } from '../agentworkforce-cli.mjs';

export const ROOT = repoRoot;
export const MANIFEST = path.join(ROOT, 'scripts', 'deploy', 'agents.json');

/**
 * CI transport for persona inputs. GitHub Actions cannot hand a whole `vars`
 * or `secrets` map to a step as env, so the workflow funnels newline-separated
 * `KEY=VALUE` pairs through this single variable instead. Secrets routed this
 * way stay masked in the run log.
 */
export const INPUT_BUNDLE_ENV = 'AGENT_INPUTS';

export const WORKSPACE_ENV = ['WORKFORCE_WORKSPACE_ID', 'WORKFORCE_WORKSPACE_TOKEN'];

export function parseArgs(argv) {
  const args = {
    agents: [],
    all: false,
    dryRun: false,
    failFast: false,
    skipCompile: false,
    list: false,
    inputs: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--all') args.all = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--fail-fast') args.failFast = true;
    else if (flag === '--skip-compile') args.skipCompile = true;
    else if (flag === '--list') args.list = true;
    else if (flag === '--agent') args.agents.push(requireValue(argv, ++i, flag));
    else if (flag === '--input') assignInput(args.inputs, requireValue(argv, ++i, flag), flag);
    else if (flag === '-h' || flag === '--help') args.help = true;
    else throw new UsageError(`unknown arg: ${flag}`);
  }
  return args;
}

export class UsageError extends Error {}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function assignInput(target, raw, flag) {
  const eq = raw.indexOf('=');
  if (eq < 1) throw new UsageError(`${flag}: expected <key>=<value>; got "${raw}"`);
  target[raw.slice(0, eq)] = raw.slice(eq + 1);
}

/**
 * Parse the newline-separated `KEY=VALUE` bundle the workflow passes through
 * AGENT_INPUTS. Blank lines and `#` comments are ignored so a dispatch textarea
 * can be commented. Later lines win, which is what lets the workflow stack
 * repository variables, then secrets, then the per-run dispatch box.
 */
export function parseInputBundle(raw) {
  const out = {};
  if (!raw) return out;
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    // Report the line NUMBER, never the line. This bundle carries persona
    // inputs, which may be secrets, and this error lands in the workflow log.
    if (eq < 1) {
      throw new UsageError(
        `${INPUT_BUNDLE_ENV}: line ${index + 1} is not <key>=<value> (content withheld: it may be a secret)`,
      );
    }
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

export function loadRegistry(manifestPath = MANIFEST) {
  const registry = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(registry.agents)) throw new Error(`${manifestPath}: "agents" must be an array`);
  return registry;
}

export function selectAgents(args, agents) {
  if (args.agents.length) {
    const known = new Set(agents.map((a) => a.name));
    const missing = args.agents.filter((name) => !known.has(name));
    if (missing.length) {
      throw new UsageError(
        `unknown agent(s): ${missing.join(', ')}\nknown agents: ${[...known].sort().join(', ')}`,
      );
    }
    return agents.filter((a) => args.agents.includes(a.name));
  }
  if (args.all) return agents;
  throw new UsageError('nothing selected: pass --agent <name> (repeatable), --all, or --list');
}

export function personaPaths(agent, root = ROOT) {
  const personaTs = path.join(root, agent.persona);
  return { personaTs, personaJson: personaTs.replace(/persona\.ts$/u, 'persona.json') };
}

/**
 * Provider names this persona declares. Used to turn a bare "deploy failed"
 * into an actionable next step, since an unconnected provider is the most
 * common first-run failure and the CLI error does not name one.
 */
export function readPersonaIntegrationNames(personaJsonPath, resolvedInputs = {}) {
  if (!existsSync(personaJsonPath)) return [];
  try {
    const persona = JSON.parse(readFileSync(personaJsonPath, 'utf8'));
    const integrations = persona?.integrations;
    // `typeof [] === 'object'`, and Object.entries on an array yields "0" —
    // which would tell someone to connect a provider named `0`.
    if (!integrations || typeof integrations !== 'object' || Array.isArray(integrations)) {
      return [];
    }
    return Object.entries(integrations)
      .filter(([, config]) => {
        if (!config || typeof config !== 'object' || config.optional !== true) return true;
        // An optional provider gated behind an input becomes required the
        // moment that input is supplied — deploying askable-gtm WITH
        // SLACK_CHANNEL really does need Slack connected. Only drop the ones
        // still dormant.
        const gate = config.enabledByInput;
        return typeof gate === 'string' && Boolean(resolvedInputs[gate]);
      })
      .map(([name]) => name)
      .sort();
  } catch {
    // A malformed persona.json is the compile step's problem to report, not
    // this hint's — never let a diagnostic mask the real error.
    return [];
  }
}

export function readPersonaInputSpecs(personaJsonPath) {
  if (!existsSync(personaJsonPath)) {
    throw new Error(
      `persona is not compiled: ${personaJsonPath}\n`
        + 'Run without --skip-compile, or compile it first with `agentworkforce persona compile <persona.ts>`.',
    );
  }
  const persona = JSON.parse(readFileSync(personaJsonPath, 'utf8'));
  return persona.inputs ?? {};
}

/**
 * Resolve every input a persona declares to a concrete value.
 *
 * Precedence, highest first: an explicit `--input KEY=VALUE`; the AGENT_INPUTS
 * bundle; the process environment under the persona's declared `env` name (or
 * the input name); the persona's own `default`.
 *
 * A declared input with no value is fatal unless the persona marked it
 * `optional` — an optional input left unset is simply not passed, which is how
 * personas gate a transport off (no SLACK_CHANNEL, no Slack delivery).
 *
 * `requireExplicit` names inputs whose persona `default` must NOT be inherited
 * (see `requireExplicit` in scripts/deploy/agents.json). Those resolve from the
 * first three sources only, so a fork that does not set one is told to, instead
 * of silently deploying against whoever's id the default happens to hold.
 */
export function resolvePersonaInputs(
  specs,
  { overrides = {}, bundle = {}, env = process.env, requireExplicit = [] } = {},
) {
  const mustBeExplicit = new Set(requireExplicit);
  const resolved = {};
  const sources = {};
  const missing = [];
  for (const [name, spec = {}] of Object.entries(specs)) {
    const envName = spec.env ?? name;
    const explicitOnly = mustBeExplicit.has(name);
    const candidates = [
      ['--input', overrides[name]],
      [INPUT_BUNDLE_ENV, bundle[name]],
      [`env ${envName}`, env[envName]],
      ...(explicitOnly ? [] : [['persona default', spec.default]]),
    ];
    const hit = candidates.find(([, value]) => typeof value === 'string' && value.trim() !== '');
    if (!hit) {
      if (!spec.optional || explicitOnly) {
        missing.push({ name, envName, description: spec.description, explicitOnly });
      }
      continue;
    }
    [sources[name]] = hit;
    resolved[name] = hit[1];
  }
  return { resolved, sources, missing };
}

export function formatMissingInputs(agentName, missing) {
  const lines = missing.map(
    ({ name, envName, description, explicitOnly }) =>
      `  ${name}${description ? ` — ${description}` : ''}\n`
      + `    set env ${envName}=<value>, or pass --input ${name}=<value>`
      + (explicitOnly
        ? `\n    (this one identifies YOUR account or project. Its persona default points at\n`
          + `     someone else's, so this deploy will not inherit it.)`
        : ''),
  );
  return `${agentName}: ${missing.length} required input(s) unresolved:\n${lines.join('\n')}`;
}

export function buildDeployArgs(personaJsonArg, mode, inputs) {
  return [
    'deploy',
    personaJsonArg,
    '--mode',
    mode,
    // Headless: never prompt for cloud setup, never open a picker, and reuse
    // integrations that are already connected instead of starting a connect
    // flow. A persona whose integration is missing fails loudly here.
    '--no-prompt',
    '--no-connect',
    // Re-dispatching the workflow updates the existing agent rather than
    // erroring on the name it already took.
    '--on-exists',
    'update',
    ...Object.entries(inputs).flatMap(([key, value]) => ['--input', `${key}=${value}`]),
  ];
}

/** Workspace env vars that are absent or empty. Names only — never values. */
export function missingWorkspaceSecrets(env = process.env) {
  return WORKSPACE_ENV.filter((name) => !(env[name] ?? '').trim());
}

export function deployAgents({
  args,
  registry,
  selected,
  root = ROOT,
  env = process.env,
  spawn = spawnSync,
  log = console,
}) {
  const mode = registry.mode ?? 'cloud';
  const bundle = parseInputBundle(env[INPUT_BUNDLE_ENV]);
  const failures = [];

  for (const agent of selected) {
    const { personaTs, personaJson } = personaPaths(agent, root);
    const personaTsArg = path.relative(root, personaTs);
    const personaJsonArg = path.relative(root, personaJson);

    // A dry run compiles too. Compiling only writes gitignored build artifacts
    // (persona.json, agent-card.json), and without it the rehearsal could not
    // read the persona's declared inputs — so it could not tell you that a
    // required one is unset, which is the main thing a rehearsal is for.
    if (!args.skipCompile) {
      log.log(`\n=== ${agent.name}: compile ===`);
      if (runCli(spawn, ['persona', 'compile', personaTsArg], root).status !== 0) {
        log.error(`✗ ${agent.name}: compile failed`);
        failures.push(agent.name);
        if (args.failFast) break;
        continue;
      }
    }

    let inputs;
    let sources = {};
    try {
      const specs = readPersonaInputSpecs(personaJson);
      const { resolved, sources: resolvedFrom, missing } = resolvePersonaInputs(specs, {
        overrides: args.inputs,
        bundle,
        env,
        requireExplicit: agent.requireExplicit ?? [],
      });
      if (missing.length) throw new Error(formatMissingInputs(agent.name, missing));
      inputs = resolved;
      sources = resolvedFrom;
    } catch (err) {
      // `--dry-run --skip-compile` on a fresh clone has no persona.json to read
      // (it is a gitignored build artifact). Report what would happen rather
      // than failing a rehearsal that was explicitly told not to compile.
      if (args.dryRun && args.skipCompile && !existsSync(personaJson)) {
        log.log(`\n[dry-run] ${agent.name}`);
        log.log('  compile: skipped (--skip-compile)');
        log.log('  inputs:  (persona not compiled — drop --skip-compile to resolve them)');
        continue;
      }
      log.error(`✗ ${err.message}`);
      failures.push(agent.name);
      if (args.failFast) break;
      continue;
    }

    const deployArgs = buildDeployArgs(personaJsonArg, mode, inputs);

    if (args.dryRun) {
      log.log(`\n[dry-run] ${agent.name}`);
      log.log(
        args.skipCompile ? '  compile: skipped (--skip-compile)' : '  compile: ok',
      );
      // Input NAMES and where each was resolved FROM — never the value. A value
      // can be a Spotify token or a private channel id, and a dry run is the one
      // mode people paste into issues. Showing the source is what makes an
      // inherited persona default visible before it reaches a real deploy.
      const shown = Object.keys(inputs).map((name) => `${name} (${sources[name]})`);
      log.log(`  inputs:  ${shown.join(', ') || '(none declared)'}`);
      log.log(`  deploy:  agentworkforce ${redactDeployArgs(deployArgs).join(' ')}`);
      continue;
    }

    log.log(`=== ${agent.name}: deploy (${mode}) ===`);
    if (runCli(spawn, deployArgs, root).status !== 0) {
      log.error(`✗ ${agent.name}: deploy failed`);
      // The most common first-run failure is a provider the workspace has not
      // connected yet — `--no-connect` fails rather than starting a connect
      // flow, and the CLI error alone does not tell you where to go. Name the
      // providers this persona needs and where to connect them.
      // Any nonzero exit reaches here — expired credentials, a backend fault,
      // an invalid persona. So offer the providers as something to CHECK, and
      // point at the CLI's own error for the cause; asserting a missing
      // integration would send people away from the real stderr above.
      const providers = readPersonaIntegrationNames(personaJson, inputs);
      if (providers.length > 0) {
        log.error(`  See the error above. If it names an integration, verify these are`
          + ` connected for ${agent.name}: ${providers.join(', ')}.`);
        log.error(
          '  Connect them in Workspace Integrations (/integrations) — that is where you'
            + ' paste each provider\'s API key. Providers hold their own credentials;'
            + ' never pass one as an agent input.',
        );
      }
      failures.push(agent.name);
      if (args.failFast) break;
      continue;
    }
    log.log(`✓ ${agent.name} deployed`);
  }

  return failures;
}

/** `--input K=V` pairs with values replaced by a placeholder, for printing. */
export function redactDeployArgs(deployArgs) {
  return deployArgs.map((arg, i) =>
    deployArgs[i - 1] === '--input' ? `${arg.slice(0, arg.indexOf('=') + 1)}<set>` : arg,
  );
}

function runCli(spawn, cliArgs, cwd) {
  const invocation = getAgentworkforceInvocation(cliArgs);
  return spawn(invocation.command, invocation.argv, { cwd, stdio: 'inherit' });
}

const USAGE = `usage: node scripts/deploy/deploy-agents.mjs [flags]

Deploy an agent from this repo to your own Agent Workforce workspace.

Flags:
  --agent <name>        Agent to deploy, as named in scripts/deploy/agents.json (repeatable)
  --all                 Deploy every agent in the registry
  --list                Print the registry and exit
  --input <key>=<value> Override a declared persona input (repeatable)
  --dry-run             Compile and resolve inputs, print the deploy, then stop.
                        Deploys nothing and needs no workspace secrets.
  --skip-compile        Assume persona.json is already compiled
  --fail-fast           Stop at the first failure instead of continuing
  -h, --help            Print this message

Auth (required unless --dry-run):
  WORKFORCE_WORKSPACE_ID     your workspace id
  WORKFORCE_WORKSPACE_TOKEN  that workspace's token

See docs/SELF-DEPLOY.md for where to get both.
`;

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const registry = loadRegistry();

  if (args.list) {
    for (const agent of registry.agents) {
      console.log(`${agent.name}\t${agent.persona}`);
    }
    return;
  }

  let selected;
  try {
    selected = selectAgents(args, registry.agents);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  console.log(`agents to deploy: ${selected.map((a) => a.name).join(', ')}`);

  if (!args.dryRun) {
    const missing = missingWorkspaceSecrets();
    if (missing.length) {
      process.stderr.write(
        `missing headless auth: ${missing.join(', ')}\n`
          + 'Set both and retry. In GitHub Actions an empty value here almost always means the\n'
          + "calling job is missing `environment:`, not that the secret is absent.\n"
          + 'See docs/SELF-DEPLOY.md.\n',
      );
      process.exit(1);
    }
  }

  const failures = deployAgents({ args, registry, selected });

  if (failures.length) {
    process.stderr.write(`\nFAILED: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  console.log(args.dryRun ? '\nDry run complete.' : '\nAll deploys succeeded.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
