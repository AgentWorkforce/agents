#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentworkforceBin,
  checkAgentworkforceFlags,
  formatMissingFlagsMessage,
  isAgentworkforceInstalled,
  readAgentworkforceHelp,
  repoRoot,
  runAgentworkforce,
  runAgentworkforceAsync,
} from '../agentworkforce-cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const taskRoot = resolve(here, '..', '..');
const artifactRoot = resolve(taskRoot, '.workflow-artifacts/composable-runtime-closure');
const artifactFilesRoot = resolve(artifactRoot, 'artifacts');

mkdirSync(artifactFilesRoot, { recursive: true });
rmSync(resolve(artifactFilesRoot, 'tmp'), { recursive: true, force: true });

const pkg = JSON.parse(readFileSync(resolve(taskRoot, 'package.json'), 'utf8'));
const repoCommit = runShell(['git', 'rev-parse', 'HEAD']).stdout.trim();
const startedAt = new Date().toISOString();
const results = [];

function runShell(args, options = {}) {
  const [cmd, ...rest] = args;
  const result = spawnSync(cmd, rest, {
    cwd: taskRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    input: options.input,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: args.join(' '),
  };
}

function writeArtifact(name, contents) {
  const path = resolve(artifactFilesRoot, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return relative(taskRoot, path);
}

function recordGate({
  gate,
  command,
  exitCode,
  status,
  summary,
  artifactRefs = [],
  durationMs = 0,
}) {
  results.push({
    gate,
    command,
    exitCode,
    status,
    summary,
    durationMs,
    repositoryCommit: repoCommit,
    packageVersions: {
      agentworkforce: pkg.devDependencies.agentworkforce,
      compose: pkg.dependencies['@agentworkforce/compose'],
      runtime: pkg.dependencies['@agentworkforce/runtime'],
      relayHelpers: pkg.dependencies['@relayfile/relay-helpers'],
    },
    artifactRefs,
  });
}

async function runGate(name, command, fn) {
  const begin = Date.now();
  try {
    const outcome = await fn();
    recordGate({
      gate: name,
      command,
      exitCode: outcome.exitCode,
      status: outcome.exitCode === 0 ? 'passed' : 'failed',
      summary: outcome.summary,
      artifactRefs: outcome.artifactRefs ?? [],
      durationMs: Date.now() - begin,
    });
  } catch (error) {
    const artifact = writeArtifact(`${name}.error.txt`, String(error));
    recordGate({
      gate: name,
      command,
      exitCode: 1,
      status: 'failed',
      summary: String(error),
      artifactRefs: [artifact],
      durationMs: Date.now() - begin,
    });
  }
}

function runPreconditionGate(name, command, failureMessage, artifactRefs = []) {
  recordGate({
    gate: name,
    command,
    exitCode: 1,
    status: 'failed',
    summary: failureMessage,
    artifactRefs,
  });
}

await runGate('dependency-preflight', 'npm ls --depth=0 --json', () => {
  if (!isAgentworkforceInstalled()) {
    const artifact = writeArtifact('dependency-preflight.txt', `Missing ${agentworkforceBin}\n`);
    return {
      exitCode: 1,
      summary: `Missing ${agentworkforceBin}; run npm install --ignore-scripts before acceptance.`,
      artifactRefs: [artifact],
    };
  }

  const result = runShell(['npm', 'ls', '--depth=0', '--json']);
  const artifact = writeArtifact('dependency-preflight.json', `${result.stdout}\n${result.stderr}`.trim() + '\n');
  return {
    exitCode: result.status,
    summary: result.status === 0 ? 'Declared dependencies are installed.' : 'npm ls reported dependency problems.',
    artifactRefs: [artifact],
  };
});

const topHelp = readAgentworkforceHelp([]);
const invokeHelp = readAgentworkforceHelp(['invoke']);
const runsExportHelp = readAgentworkforceHelp(['runs', 'export']);
const helpArtifacts = [
  writeArtifact('cli-help.txt', `${topHelp.stdout}\n${topHelp.stderr}`.trim() + '\n'),
  writeArtifact('invoke-help.txt', `${invokeHelp.stdout}\n${invokeHelp.stderr}`.trim() + '\n'),
  writeArtifact('runs-export-help.txt', `${runsExportHelp.stdout}\n${runsExportHelp.stderr}`.trim() + '\n'),
];

await runGate('cli-help-snapshot', 'agentworkforce --help / invoke --help / runs export --help', () => ({
  exitCode: topHelp.ok && invokeHelp.ok && runsExportHelp.ok ? 0 : 1,
  summary:
    topHelp.ok && invokeHelp.ok && runsExportHelp.ok
      ? 'Captured CLI surface snapshots.'
      : 'One or more CLI help commands failed.',
  artifactRefs: helpArtifacts,
}));

await runGate('legacy-fixture-compatibility', 'agentworkforce invoke ./scripts/acceptance/fixtures/invoke-safety-persona.ts --fixture ./scripts/acceptance/fixtures/invoke-safety.fixture.json', async () => {
  const sentinel = await createSentinelServer();
  const runRecordPath = resolve(artifactFilesRoot, 'invoke-safety.run-record.json');
  const stderrPath = resolve(artifactFilesRoot, 'invoke-safety.stderr.txt');

  try {
    const result = await runAgentworkforceAsync([
      'invoke',
      './scripts/acceptance/fixtures/invoke-safety-persona.ts',
      '--fixture',
      './scripts/acceptance/fixtures/invoke-safety.fixture.json',
      '--input',
      `ALLOWED_GET_URL=${sentinel.allowedUrl}`,
      '--input',
      `DENIED_POST_URL=${sentinel.deniedUrl}`,
      '--output',
      runRecordPath,
    ]);

    writeFileSync(stderrPath, `${result.stdout}\n${result.stderr}`.trim() + '\n');
    const countsArtifact = writeArtifact('invoke-safety.sentinels.json', JSON.stringify(sentinel.counts, null, 2) + '\n');
    const stderrArtifact = relative(taskRoot, stderrPath);
    const artifacts = [countsArtifact, stderrArtifact];
    if (result.status === 0) artifacts.push(relative(taskRoot, runRecordPath));

    const counts = JSON.parse(readFileSync(resolve(taskRoot, countsArtifact), 'utf8'));
    const deniedWrites = counts.denied.post + counts.denied.raw;

    return {
      exitCode: result.status === 0 && deniedWrites === 0 ? 0 : 1,
      summary:
        result.status !== 0
          ? 'Legacy fixture invoke failed.'
          : deniedWrites === 0
            ? 'Legacy fixture invoke ran; denied sentinel endpoints observed zero writes.'
            : `Legacy fixture invoke reached denied sentinel endpoints ${deniedWrites} time(s).`,
      artifactRefs: artifacts,
    };
  } finally {
    sentinel.close();
  }
});

await runGate('team-spec-compose-parity', 'node scripts/test.mjs tests/team-spec.test.mjs', () => {
  const result = runShell(['node', 'scripts/test.mjs', 'tests/team-spec.test.mjs']);
  const artifact = writeArtifact('team-spec-compose-parity.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
  return {
    exitCode: result.status,
    summary: result.status === 0 ? 'Compose-backed TeamSpec tests passed.' : 'Compose-backed TeamSpec tests failed.',
    artifactRefs: [artifact],
  };
});

await runGate('hn-wrapper-contract', 'node scripts/test.mjs tests/hn-monitor-cases.test.mjs', () => {
  const result = runShell(['node', 'scripts/test.mjs', 'tests/hn-monitor-cases.test.mjs']);
  const artifact = writeArtifact('hn-wrapper-contract.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
  return {
    exitCode: result.status,
    summary: result.status === 0 ? 'HN wrapper contract tests passed.' : 'HN wrapper contract tests failed.',
    artifactRefs: [artifact],
  };
});

const scheduleFlags = checkAgentworkforceFlags(['invoke'], ['--schedule', '--reads', '--model']);
if (scheduleFlags.ok && scheduleFlags.missingFlags.length === 0) {
  await runGate(
    'hn-schedule-preview',
    'agentworkforce invoke ./hn-monitor/agent.ts --schedule scan --reads live --model stub --input SLACK_CHANNEL=C123',
    () => {
      const result = runAgentworkforce([
        'invoke',
        './hn-monitor/agent.ts',
        '--schedule',
        'scan',
        '--reads',
        'live',
        '--model',
        'stub',
        '--input',
        'SLACK_CHANNEL=C123',
      ]);
      const artifact = writeArtifact('hn-schedule-preview.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
      return {
        exitCode: result.status,
        summary: result.status === 0 ? 'HN schedule preview command succeeded.' : 'HN schedule preview command failed.',
        artifactRefs: [artifact],
      };
    },
  );
} else {
  runPreconditionGate(
    'hn-schedule-preview',
    'agentworkforce invoke ./hn-monitor/agent.ts --schedule scan --reads live --model stub --input SLACK_CHANNEL=C123',
    formatMissingFlagsMessage('invoke', ['--schedule', '--reads', '--model'], scheduleFlags.text),
    [helpArtifacts[1]],
  );
}

const caseFlags = checkAgentworkforceFlags(['invoke'], ['--case']);
if (caseFlags.ok && caseFlags.missingFlags.length === 0) {
  await runGate('hn-case-suite', 'node scripts/run-hn-platform-cases.mjs', () => {
    const result = runShell(['node', 'scripts/run-hn-platform-cases.mjs']);
    const artifact = writeArtifact('hn-case-suite.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
    return {
      exitCode: result.status,
      summary: result.status === 0 ? 'HN platform case suite passed.' : 'HN platform case suite failed.',
      artifactRefs: [artifact],
    };
    });
  } else {
  runPreconditionGate(
    'hn-case-suite',
    'agentworkforce invoke ./hn-monitor/agent.ts --case ./hn-monitor/cases/*.case.yaml',
    formatMissingFlagsMessage('invoke', ['--case'], caseFlags.text),
    [helpArtifacts[1]],
  );
}

const bundleFlags = checkAgentworkforceFlags(['runs', 'export'], ['--bundle']);
if (bundleFlags.ok && bundleFlags.missingFlags.length === 0) {
  const replayRunId = process.env.ACCEPTANCE_REPLAY_RUN_ID;
  if (!replayRunId) {
    runPreconditionGate(
      'replay-bundle-surface',
      'agentworkforce runs export <runId> --bundle replay-run.json',
      'Missing ACCEPTANCE_REPLAY_RUN_ID for replay export coverage.',
    );
  } else {
    await runGate('replay-bundle-surface', `agentworkforce runs export ${replayRunId} --bundle replay-run.json`, () => {
      const bundlePath = resolve(artifactFilesRoot, 'replay-run.json');
      const result = runAgentworkforce(['runs', 'export', replayRunId, '--bundle', bundlePath]);
      const artifact = writeArtifact('replay-bundle-surface.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
      const artifacts = [artifact];
      if (result.status === 0) artifacts.push(relative(taskRoot, bundlePath));
      return {
        exitCode: result.status,
        summary: result.status === 0 ? 'Replay bundle export succeeded.' : 'Replay bundle export failed.',
        artifactRefs: artifacts,
      };
    });
  }
} else {
  runPreconditionGate(
    'replay-bundle-surface',
    'agentworkforce runs export <runId> --bundle replay-run.json',
    formatMissingFlagsMessage('runs export', ['--bundle'], bundleFlags.text),
    [helpArtifacts[2]],
  );
}

await runGate('artifact-secret-scan', 'scan generated artifacts for secret-shaped values', () => {
  const serialized = JSON.stringify(results, null, 2);
  const suspectNeedles = [
    process.env.SLACK_BOT_TOKEN,
    process.env.RELAYFILE_TOKEN,
    process.env.WORKFORCE_TOKEN,
    process.env.OPENAI_API_KEY,
  ].filter(Boolean);
  const leaked = suspectNeedles.filter((value) => serialized.includes(value));
  const artifact = writeArtifact('artifact-secret-scan.json', JSON.stringify({ leaked: leaked.length }, null, 2) + '\n');
  return {
    exitCode: leaked.length === 0 ? 0 : 1,
    summary: leaked.length === 0 ? 'No configured secret values were found in recorded gate metadata.' : 'Secret-shaped value found in recorded gate metadata.',
    artifactRefs: [artifact],
  };
});

const completedAt = new Date().toISOString();
const finalResults = {
  startedAt,
  completedAt,
  repository: 'AgentWorkforce/agents',
  repositoryCommit: repoCommit,
  packageVersions: {
    agentworkforce: pkg.devDependencies.agentworkforce,
    compose: pkg.dependencies['@agentworkforce/compose'],
    runtime: pkg.dependencies['@agentworkforce/runtime'],
    relayHelpers: pkg.dependencies['@relayfile/relay-helpers'],
  },
  gates: results,
};

writeFileSync(resolve(artifactRoot, 'results.json'), JSON.stringify(finalResults, null, 2) + '\n');
writeFileSync(resolve(artifactRoot, 'FINAL_ACCEPTANCE.md'), renderMarkdown(finalResults));

const failed = results.filter((gate) => gate.exitCode !== 0);
process.exit(failed.length === 0 ? 0 : 1);

async function createSentinelServer() {
  const counts = {
    allowed: { get: 0 },
    denied: { post: 0, raw: 0 },
    requests: [],
  };

  const server = http.createServer((req, res) => {
    const body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => {
      const payload = Buffer.concat(body).toString('utf8');
      counts.requests.push({ method: req.method, url: req.url, body: payload });
      if (req.method === 'GET' && req.url === '/allowed-get') counts.allowed.get += 1;
      if (req.method === 'POST' && req.url === '/denied-post') {
        if (payload === 'raw-http-body') counts.denied.raw += 1;
        else counts.denied.post += 1;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate local sentinel server port');
  }

  return {
    allowedUrl: `http://127.0.0.1:${address.port}/allowed-get`,
    deniedUrl: `http://127.0.0.1:${address.port}/denied-post`,
    close: () => server.close(),
    counts,
  };
}

function renderMarkdown(finalResults) {
  const lines = [
    '# Composable Runtime Closure Acceptance',
    '',
    `- Started: ${finalResults.startedAt}`,
    `- Completed: ${finalResults.completedAt}`,
    `- Repository commit: ${finalResults.repositoryCommit}`,
    `- agentworkforce: ${finalResults.packageVersions.agentworkforce}`,
    `- compose: ${finalResults.packageVersions.compose}`,
    `- runtime: ${finalResults.packageVersions.runtime}`,
    `- relay-helpers: ${finalResults.packageVersions.relayHelpers}`,
    '',
    '| Gate | Status | Exit | Summary |',
    '| --- | --- | --- | --- |',
  ];

  for (const gate of finalResults.gates) {
    lines.push(`| ${gate.gate} | ${gate.status} | ${gate.exitCode} | ${gate.summary.replace(/\|/g, '\\|')} |`);
    if (gate.artifactRefs.length > 0) {
      lines.push(`|  | artifacts |  | ${gate.artifactRefs.join('<br>')} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}
