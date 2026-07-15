#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentworkforceBin,
  agentworkforceCliOverrideEnv,
  checkAgentworkforceFlags,
  formatMissingFlagsMessage,
  getAgentworkforceInvocation,
  isAgentworkforceInstalled,
  readAgentworkforceHelp,
  runAgentworkforce,
  runAgentworkforceAsync,
} from '../agentworkforce-cli.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const taskRoot = resolve(here, '..', '..');
const workspaceRoot = resolve(taskRoot, '..');
const workforceRoot = resolve(workspaceRoot, 'workforce');
const cloudRoot = resolve(workspaceRoot, 'cloud');
const relayfileAdaptersRoot = resolve(workspaceRoot, 'relayfile-adapters');
const artifactRoot = resolve(taskRoot, '.workflow-artifacts/composable-runtime-closure');
const artifactFilesRoot = resolve(artifactRoot, 'artifacts');
const workforceConfigDir = resolve(artifactRoot, 'agentworkforce-config');
const baselineRoot = resolve(here, 'baselines');
const cliBaseline = readJson(resolve(baselineRoot, 'agentworkforce-4.1.22-top-level-commands.json'));
const invokeTimeoutMs = 30_000;

rmSync(artifactFilesRoot, { recursive: true, force: true });
rmSync(workforceConfigDir, { recursive: true, force: true });
mkdirSync(workforceConfigDir, { recursive: true });
mkdirSync(artifactFilesRoot, { recursive: true });

process.env.AGENT_WORKFORCE_CONFIG_DIR ??= workforceConfigDir;

const agentsPkg = readJson(resolve(taskRoot, 'package.json'));
const startedAt = new Date().toISOString();
const results = [];

const repoEvidence = collectRepoEvidence();
const cliIdentity = getAgentworkforceInvocation([]).identity;
const cliSource = getAgentworkforceInvocation([]).source;

await runGate(
  'cli-help-snapshot',
  [
    'agentworkforce --help',
    'agentworkforce invoke --help',
    'agentworkforce runs export --help',
  ].join('\n'),
  async () => {
    const topHelp = readAgentworkforceHelp([]);
    const invokeFlags = checkAgentworkforceFlags(['invoke'], ['--schedule', '--case', '--reads', '--model', '--watch']);
    const exportFlags = checkAgentworkforceFlags(['runs', 'export'], ['--bundle']);

    const helpArtifacts = [
      writeArtifact('cli-help.txt', `${topHelp.stdout}\n${topHelp.stderr}`.trim() + '\n'),
      writeArtifact('invoke-help.txt', `${invokeFlags.stdout}\n${invokeFlags.stderr}`.trim() + '\n'),
      writeArtifact('runs-export-help.txt', `${exportFlags.stdout}\n${exportFlags.stderr}`.trim() + '\n'),
    ];

    const missing = [
      ...invokeFlags.missingFlags.map((flag) => `invoke:${flag}`),
      ...exportFlags.missingFlags.map((flag) => `runs export:${flag}`),
    ];
    const topCommands = extractTopLevelCommands(`${topHelp.stdout}\n${topHelp.stderr}`);
    const unexpectedTopLevel = topCommands.filter((command) => !cliBaseline.commands.includes(command));
    const missingTopLevel = cliBaseline.commands.filter((command) => !topCommands.includes(command));
    const topLevelDrift = [...missingTopLevel.map((value) => `missing:${value}`), ...unexpectedTopLevel.map((value) => `unexpected:${value}`)];

    return {
      exitCode: topHelp.ok && invokeFlags.ok && exportFlags.ok && missing.length === 0 && topLevelDrift.length === 0 ? 0 : 1,
      summary:
        missing.length === 0 && topLevelDrift.length === 0
          ? `Captured CLI surface for ${cliSource} artifact ${cliIdentity}.`
          : `CLI surface mismatch: ${[...missing, ...topLevelDrift].join(', ')}`,
      artifactRefs: helpArtifacts,
    };
  },
);

await runGate(
  'legacy-fixture-compatibility',
  `${formatCommand([
    'invoke',
    './scripts/acceptance/fixtures/zero-child-persona.ts',
    '--fixture',
    './scripts/acceptance/fixtures/invoke-safety.fixture.json',
    '--output',
    '<run-record>',
  ])}`,
  async () => {
    const runRecordPath = resolve(artifactFilesRoot, 'legacy-fixture.run-record.json');
    const result = await runAgentworkforceAsync(
      [
        'invoke',
        './scripts/acceptance/fixtures/zero-child-persona.ts',
        '--fixture',
        './scripts/acceptance/fixtures/invoke-safety.fixture.json',
        '--output',
        runRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );

    const stdoutArtifact = writeArtifact('legacy-fixture.stdout.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
    const artifacts = [stdoutArtifact];
    if (result.status === 0) artifacts.push(relative(taskRoot, runRecordPath));
    return {
      exitCode: result.status,
      summary: result.status === 0 ? 'Legacy invoke --fixture path succeeded against the closure CLI artifact.' : 'Legacy invoke --fixture path failed.',
      artifactRefs: artifacts,
    };
  },
);

await runGate(
  'hn-schedule-preview',
  `${formatCommand([
    'invoke',
    './hn-monitor/agent.ts',
    '--schedule',
    'scan',
    '--reads',
    'fixtures',
    '--model',
    'stub',
    '--input',
    'SLACK_CHANNEL=C123',
    '--output',
    '<run-record>',
  ])}`,
  async () => {
    const runRecordPath = resolve(artifactFilesRoot, 'hn-schedule.run-record.json');
    const result = runAgentworkforce(
      [
        'invoke',
        './hn-monitor/agent.ts',
        '--schedule',
        'scan',
        '--reads',
        'fixtures',
        '--model',
        'stub',
        '--input',
        'SLACK_CHANNEL=C123',
        '--output',
        runRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );
    const stdoutArtifact = writeArtifact('hn-schedule-preview.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
    const artifacts = [stdoutArtifact];
    if (result.status === 0) artifacts.push(relative(taskRoot, runRecordPath));
    return {
      exitCode: result.status === 0 && readJson(runRecordPath).eventContract === 'cron.tick@1' ? 0 : 1,
      summary:
        result.status === 0
          ? 'Direct HN --schedule selector succeeded deterministically with fixture reads, stub model, and a cron RunRecord.'
          : 'Direct --schedule selector failed.',
      artifactRefs: artifacts,
    };
  },
);

await runGate('hn-case-suite', 'node scripts/run-hn-platform-cases.mjs', async () => {
  const result = runShell(['node', 'scripts/run-hn-platform-cases.mjs'], {
    cwd: taskRoot,
    env: baseAgentworkforceEnv(),
  });
  const artifact = writeArtifact('hn-case-suite.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
  const parity = assertLegacyHnParity();
  const parityArtifact = writeArtifact('hn-case-parity.json', JSON.stringify(parity, null, 2) + '\n');
  return {
    exitCode: result.status === 0 && parity.ok ? 0 : 1,
    summary:
      result.status === 0 && parity.ok
        ? 'All checked-in HN case files passed through invoke --case and the legacy JSONL parity contract matches the YAML cases.'
        : `HN case coverage failed${parity.ok ? '.' : '; legacy parity drift detected.'}`,
    artifactRefs: [artifact, parityArtifact],
  };
});

await runGate(
  'multi-turn-state-preservation',
  `${formatCommand([
    'invoke',
    './hn-monitor/agent.ts',
    '--case',
    './hn-monitor/cases/slack-follow-up.case.yaml',
    '--output',
    '<run-record>',
  ])}`,
  async () => {
    const runRecordPath = resolve(artifactFilesRoot, 'slack-follow-up.run-record.json');
    const result = runAgentworkforce(
      [
        'invoke',
        './hn-monitor/agent.ts',
        '--case',
        './hn-monitor/cases/slack-follow-up.case.yaml',
        '--output',
        runRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );
    const stdoutArtifact = writeArtifact('slack-follow-up.stdout.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
    const artifacts = [stdoutArtifact];
    if (result.status === 0) artifacts.push(relative(taskRoot, runRecordPath));
    if (result.status !== 0) {
      return { exitCode: result.status, summary: 'Multi-turn HN follow-up case failed.', artifactRefs: artifacts };
    }

    const runRecord = readJson(runRecordPath);
    const turns = runRecord.extensions?.turns ?? [];
    const logs = readLogLines(runRecord);
    const hasHydrated = logs.some((entry) => entry.message === 'hn-monitor.qa.hydrated');
    const hasReply = logs.some((entry) => entry.message === 'hn-monitor.qa.slack-replied');
    const recalled = runRecord.actions.some((action) => action.kind === 'memory.recall' && action.data?.items >= 1);
    return {
      exitCode: turns.length === 2 && hasHydrated && hasReply && recalled ? 0 : 1,
      summary:
        turns.length === 2 && hasHydrated && hasReply && recalled
          ? 'Two-turn HN follow-up preserved preview state across turns.'
          : 'Multi-turn HN follow-up did not preserve the expected state/action sequence.',
      artifactRefs: artifacts,
    };
  },
);

await runGate(
  'relayfile-slack-preview-threading',
  `${formatCommand([
    'invoke',
    './hn-monitor/agent.ts',
    '--case',
    './hn-monitor/cases/agentic-feeds.case.yaml',
    '--output',
    '<run-record>',
  ])}`,
  async () => {
    const runRecordPath = resolve(artifactFilesRoot, 'threaded-preview.run-record.json');
    const env = {
      ...baseAgentworkforceEnv(),
      RELAYFILE_URL: 'https://relayfile.example.test',
      RELAYFILE_TOKEN: 'relay_pa_acceptance_preview_secret',
      RELAYFILE_WORKSPACE_ID: 'ws_acceptance_preview',
      SLACK_TOKEN: 'xoxb-acceptance-preview-token',
    };
    const result = runAgentworkforce(
      [
        'invoke',
        './hn-monitor/agent.ts',
        '--case',
        './hn-monitor/cases/agentic-feeds.case.yaml',
        '--output',
        runRecordPath,
      ],
      { env, timeoutMs: invokeTimeoutMs },
    );
    const stdoutArtifact = writeArtifact('threaded-preview.stdout.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
    const artifacts = [stdoutArtifact];
    if (result.status === 0) artifacts.push(relative(taskRoot, runRecordPath));
    if (result.status !== 0) {
      return { exitCode: result.status, summary: 'Threaded Slack preview case failed.', artifactRefs: artifacts };
    }

    const runRecord = readJson(runRecordPath);
    const writes = runRecord.actions.filter((action) => action.kind === 'provider.write' && action.provider === 'slack');
    const header = writes.find((action) => action.resource === 'messages' && !action.data?.body?.parentRef);
    const thread = writes.find((action) => action.resource === 'messages' && typeof action.data?.body?.parentRef === 'string');
    const previewedOnly = writes.every((action) => action.status === 'previewed');

    return {
      exitCode: header && thread && thread.data?.body?.thread_ts && previewedOnly ? 0 : 1,
      summary:
        header && thread && thread.data?.body?.thread_ts && previewedOnly
          ? 'Production-shaped Relayfile/Slack credentials still yielded preview-only parent+thread Slack writes.'
          : 'Preview parent/thread Slack proof was incomplete.',
      artifactRefs: artifacts,
    };
  },
);

await runGate(
  'preview-network-safety',
  [
    formatCommand([
      'invoke',
      './scripts/acceptance/fixtures/fetch-preview-persona.ts',
      '--fixture',
      './scripts/acceptance/fixtures/invoke-safety.fixture.json',
      '--reads',
      'live',
      '--input',
      'ALLOWED_GET_URL=<sentinel>',
      '--input',
      'DENIED_POST_URL=<sentinel>',
      '--output',
      '<fetch-run-record>',
    ]),
    formatCommand([
      'invoke',
      './scripts/acceptance/fixtures/invoke-safety-persona.ts',
      '--fixture',
      './scripts/acceptance/fixtures/invoke-safety.fixture.json',
      '--reads',
      'live',
      '--input',
      'ALLOWED_GET_URL=<sentinel>',
      '--input',
      'DENIED_POST_URL=<sentinel>',
      '--output',
      '<raw-run-record>',
    ]),
  ].join('\n'),
  async () => {
    const sentinel = await createSentinelServer();
    const fetchRunRecordPath = resolve(artifactFilesRoot, 'fetch-preview.run-record.json');
    const rawRunRecordPath = resolve(artifactFilesRoot, 'raw-http-denial.run-record.json');
    const rawStdoutPath = resolve(artifactFilesRoot, 'raw-http-denial.stdout.txt');
    const rawStderrPath = resolve(artifactFilesRoot, 'raw-http-denial.stderr.txt');

    try {
      const fetchProbe = await runAgentworkforceAsync(
        [
          'invoke',
          './scripts/acceptance/fixtures/fetch-preview-persona.ts',
          '--fixture',
          './scripts/acceptance/fixtures/invoke-safety.fixture.json',
          '--reads',
          'live',
          '--input',
          `ALLOWED_GET_URL=${sentinel.allowedUrl}`,
          '--input',
          `DENIED_POST_URL=${sentinel.deniedUrl}`,
          '--output',
          fetchRunRecordPath,
        ],
        { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
      );
      const rawImport = await runAgentworkforceAsync(
        [
          'invoke',
          './scripts/acceptance/fixtures/invoke-safety-persona.ts',
          '--fixture',
          './scripts/acceptance/fixtures/invoke-safety.fixture.json',
          '--reads',
          'live',
          '--input',
          `ALLOWED_GET_URL=${sentinel.allowedUrl}`,
          '--input',
          `DENIED_POST_URL=${sentinel.deniedUrl}`,
          '--output',
          rawRunRecordPath,
        ],
        { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
      );

      writeFileSync(rawStdoutPath, `${rawImport.stdout}`.trim() + '\n');
      writeFileSync(rawStderrPath, `${rawImport.stderr}`.trim() + '\n');
      const fetchArtifact = writeArtifact('fetch-preview.stdout.txt', `${fetchProbe.stdout}\n${fetchProbe.stderr}`.trim() + '\n');
      const rawStdoutArtifact = relative(taskRoot, rawStdoutPath);
      const rawStderrArtifact = relative(taskRoot, rawStderrPath);
      const countsArtifact = writeArtifact('preview-network-safety.sentinels.json', JSON.stringify(sentinel.counts, null, 2) + '\n');
      const artifacts = [fetchArtifact, rawStdoutArtifact, rawStderrArtifact, countsArtifact];
      if (fetchProbe.status === 0) artifacts.push(relative(taskRoot, fetchRunRecordPath));
      if (rawImport.status === 0) artifacts.push(relative(taskRoot, rawRunRecordPath));

      const rawRecord = rawImport.status === 0 ? readJson(rawRunRecordPath) : null;
      const rawDenied =
        /(preview bundles may not import node:http|preview worker denied raw module import node:http|denied raw module import node:http)/u.test(`${rawImport.stdout}\n${rawImport.stderr}`) ||
        rawRecord?.actions?.some((action) => action.kind === 'http.read' && action.status === 'denied' && action.data?.module === 'node:http');
      const fetchRecord = fetchProbe.status === 0 ? readJson(fetchRunRecordPath) : null;
      const blockedPost = fetchRecord
        ? readLogLines(fetchRecord).some((entry) => entry.message === 'acceptance.fetch.denied-post.blocked')
        : false;
      const rawBlocked = rawRecord
        ? rawRecord.actions?.some((action) => action.kind === 'http.read' && action.status === 'denied' && action.data?.module === 'node:http')
        : false;

      return {
        exitCode:
          fetchProbe.status === 0 &&
          sentinel.counts.allowed.get === 2 &&
          sentinel.counts.denied.post === 0 &&
          sentinel.counts.denied.raw === 0 &&
          rawImport.status === 0 &&
          rawDenied &&
          rawBlocked &&
          blockedPost
            ? 0
            : 1,
        summary:
          fetchProbe.status === 0 &&
          sentinel.counts.allowed.get === 2 &&
          sentinel.counts.denied.post === 0 &&
          sentinel.counts.denied.raw === 0 &&
          rawImport.status === 0 &&
          rawDenied &&
          rawBlocked &&
          blockedPost
            ? 'Declared GETs reached the sentinel twice; fetch POST and raw node:http writes were blocked before any denied write landed.'
          : 'Preview network safety boundary did not match the required allow/deny behavior.',
        artifactRefs: artifacts,
      };
    } finally {
      sentinel.close();
    }
  },
);

await runGate(
  'compose-parity-zero-child-preview',
  [
    'node scripts/test.mjs tests/team-spec.test.mjs',
    formatCommand([
      'invoke',
      './scripts/acceptance/fixtures/zero-child-persona.ts',
      '--fixture',
      './scripts/acceptance/fixtures/invoke-safety.fixture.json',
      '--output',
      '<run-record>',
    ]),
  ].join('\n'),
  async () => {
    const composeResult = runShell(['node', 'scripts/test.mjs', 'tests/team-spec.test.mjs'], { cwd: taskRoot });
    const composeArtifact = writeArtifact('team-spec-compose-parity.txt', `${composeResult.stdout}\n${composeResult.stderr}`.trim() + '\n');

    const runRecordPath = resolve(artifactFilesRoot, 'zero-child.run-record.json');
    const previewResult = runAgentworkforce(
      [
        'invoke',
        './scripts/acceptance/fixtures/zero-child-persona.ts',
        '--fixture',
        './scripts/acceptance/fixtures/invoke-safety.fixture.json',
        '--output',
        runRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );
    const previewArtifact = writeArtifact('zero-child.stdout.txt', `${previewResult.stdout}\n${previewResult.stderr}`.trim() + '\n');
    const artifacts = [composeArtifact, previewArtifact];
    if (previewResult.status === 0) artifacts.push(relative(taskRoot, runRecordPath));

    const runRecord = previewResult.status === 0 ? readJson(runRecordPath) : null;
    const composeRunPreviewed = runRecord?.actions.some((action) => action.kind === 'compose.run' && action.status === 'previewed');
    const shellExecPresent = runRecord?.actions.some((action) => action.kind === 'shell.exec');

    return {
      exitCode: composeResult.status === 0 && previewResult.status === 0 && composeRunPreviewed && !shellExecPresent ? 0 : 1,
      summary:
        composeResult.status === 0 && previewResult.status === 0 && composeRunPreviewed && !shellExecPresent
          ? 'Compose remains the TeamSpec authority; compose.run stayed previewed and no shell.exec action launched.'
          : 'Compose parity or zero-child preview proof failed.',
      artifactRefs: artifacts,
    };
  },
);

await runGate(
  'cloud-adapter-parity',
  [
    'npm run typecheck --workspace @cloud/webhook-worker',
    'node ./node_modules/typescript/bin/tsc -p packages/router/tsconfig.json --noEmit',
    'npm run test --workspace @cloud/webhook-worker',
    'node scripts/check-route-coverage.mjs',
    'node ./node_modules/vitest/vitest.mjs run --config vitest.config.ts <cloud ingress suites>',
    'npm run web:webhook-ingress:test',
    'node ./node_modules/vitest/vitest.mjs run --config vitest.config.ts <cloud replay suites>',
  ].join('\n'),
  async () => {
    const workerTypecheck = runShell(['npm', 'run', 'typecheck', '--workspace', '@cloud/webhook-worker'], { cwd: cloudRoot });
    const routerTypecheck = runShell(['node', './node_modules/typescript/bin/tsc', '-p', 'packages/router/tsconfig.json', '--noEmit'], { cwd: cloudRoot });
    const workerTests = runShell(['npm', 'run', 'test', '--workspace', '@cloud/webhook-worker'], { cwd: cloudRoot });
    const routeCoverage = runShell(['node', 'scripts/check-route-coverage.mjs'], { cwd: cloudRoot });
    const ingressArgs = [
      'node',
      './node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.ts',
      'packages/web/lib/integrations/ingress/receiver.test.ts',
      'packages/web/lib/integrations/ingress/sql-ledger.pglite.test.ts',
      'packages/web/lib/integrations/ingress/registration-health.test.ts',
      'packages/web/lib/integrations/ingress/live-watch-receiver.test.ts',
      'packages/web/lib/integrations/ingress/live-adapters.test.ts',
      'packages/web/lib/integrations/nango-webhook-route-handler.test.ts',
      'packages/web/lib/integrations/nango-webhook-router-github-forward.test.ts',
      'packages/web/lib/integrations/nango-webhook-router-slack-relayfile-routing.test.ts',
      'packages/router/test/webhook-routing.test.ts',
      'packages/web/app/api/v1/workspaces/[workspaceId]/events/routes.test.ts',
      'tests/hookdeck-webhook-route.test.ts',
      'packages/web/app/api/v1/webhooks/composio/route.test.ts',
      'packages/web/app/api/v1/webhooks/composio/connect/callback/route.test.ts',
    ];
    const webhookIngress = runShell(['npm', 'run', 'web:webhook-ingress:test'], { cwd: cloudRoot });
    const replayArgs = [
      'node',
      './node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.ts',
      'packages/web/lib/proactive-runtime/deployment-run-observability-core.test.ts',
      'packages/web/lib/proactive-runtime/replay-bundle.test.ts',
    ];

    const ingress = runShell(ingressArgs, { cwd: cloudRoot });
    const replay = runShell(replayArgs, { cwd: cloudRoot });
    const artifacts = [
      writeArtifact('cloud-webhook-worker-typecheck.txt', `${workerTypecheck.stdout}\n${workerTypecheck.stderr}`.trim() + '\n'),
      writeArtifact('cloud-router-typecheck.txt', `${routerTypecheck.stdout}\n${routerTypecheck.stderr}`.trim() + '\n'),
      writeArtifact('cloud-webhook-worker-tests.txt', `${workerTests.stdout}\n${workerTests.stderr}`.trim() + '\n'),
      writeArtifact('cloud-route-coverage.txt', `${routeCoverage.stdout}\n${routeCoverage.stderr}`.trim() + '\n'),
      writeArtifact('cloud-ingress-suite.txt', `${ingress.stdout}\n${ingress.stderr}`.trim() + '\n'),
      writeArtifact('cloud-webhook-ingress-suite.txt', `${webhookIngress.stdout}\n${webhookIngress.stderr}`.trim() + '\n'),
      writeArtifact('cloud-replay-suite.txt', `${replay.stdout}\n${replay.stderr}`.trim() + '\n'),
    ];
    return {
      exitCode:
        workerTypecheck.status === 0 &&
        routerTypecheck.status === 0 &&
        workerTests.status === 0 &&
        routeCoverage.status === 0 &&
        ingress.status === 0 &&
        webhookIngress.status === 0 &&
        replay.status === 0
          ? 0
          : 1,
      summary:
        workerTypecheck.status === 0 &&
        routerTypecheck.status === 0 &&
        workerTests.status === 0 &&
        routeCoverage.status === 0 &&
        ingress.status === 0 &&
        webhookIngress.status === 0 &&
        replay.status === 0
          ? 'Cloud router/webhook-worker/ingress/Composio/replay parity suites passed at the sibling Cloud commit.'
          : 'Cloud focused parity or replay suite failed.',
      artifactRefs: artifacts,
      repositoryCommits: {
        ...repoEvidence.repositories,
        cloud: repoEvidence.repositories.cloud,
      },
    };
  },
);

await runGate(
  'cloud-replay-bundle-consumption',
  [
    'npm run composable-runtime:replay-bundle:fixture -- --out <bundle>',
    formatCommand([
      'invoke',
      './scripts/acceptance/fixtures/replay-bundle-persona.ts',
      '--fixture',
      '<bundle>',
      '--output',
      '<run-record>',
    ]),
  ].join('\n'),
  async () => {
    const bundlePath = resolve(artifactFilesRoot, 'cloud-replay-bundle.json');
    const generate = runShell(
      [
        'npm',
        'run',
        'composable-runtime:replay-bundle:fixture',
        '--',
        '--out',
        bundlePath,
      ],
      { cwd: cloudRoot },
    );
    const bundleArtifact = writeArtifact('cloud-replay-bundle.generate.txt', `${generate.stdout}\n${generate.stderr}`.trim() + '\n');
    if (generate.status !== 0) {
      return {
        exitCode: generate.status,
        summary: 'Cloud replay bundle generation failed.',
        artifactRefs: [bundleArtifact],
      };
    }
    const bundle = readJson(bundlePath);
    const serializedBundle = JSON.stringify(bundle);
    const redactionProof = {
      eventFidelity: bundle.manifest?.files?.['event.json']?.fidelity ?? null,
      runFidelity: bundle.manifest?.files?.['run.json']?.fidelity ?? null,
      inputsFidelity: bundle.manifest?.files?.['inputs.redacted.json']?.fidelity ?? null,
      stateFidelity: bundle.manifest?.files?.['state/manifest.json']?.fidelity ?? null,
      httpFidelity: bundle.manifest?.files?.['http/cassette.json']?.fidelity ?? null,
      modelFidelity: bundle.manifest?.files?.['models/responses.json']?.fidelity ?? null,
      containsGitHubSecret: serializedBundle.includes('ghp_acceptance_secret_abcdefghijklmnopqrstuvwxyz'),
      containsRelaySecret: serializedBundle.includes('relay_pa_live-secret'),
      containsAccessTokenSecret: serializedBundle.includes('fixture-secret@example.test'),
      containsPasswordSecret: serializedBundle.includes('ordinary-secret'),
    };
    const redactionArtifact = writeArtifact('cloud-replay-bundle.redaction.json', JSON.stringify(redactionProof, null, 2) + '\n');

    const runRecordPath = resolve(artifactFilesRoot, 'cloud-replay-bundle.run-record.json');
    const invoke = runAgentworkforce(
      [
        'invoke',
        './scripts/acceptance/fixtures/replay-bundle-persona.ts',
        '--fixture',
        bundlePath,
        '--output',
        runRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );
    const invokeArtifact = writeArtifact('cloud-replay-bundle.stdout.txt', `${invoke.stdout}\n${invoke.stderr}`.trim() + '\n');
    const artifacts = [bundleArtifact, redactionArtifact, invokeArtifact, relative(taskRoot, bundlePath)];
    if (invoke.status === 0) artifacts.push(relative(taskRoot, runRecordPath));
    if (invoke.status !== 0) {
      return {
        exitCode: invoke.status,
        summary: 'Workforce invoke could not consume the Cloud replay bundle.',
        artifactRefs: artifacts,
      };
    }

    const runRecord = readJson(runRecordPath);
    const stateSource = runRecord.extensions?.stateSource ?? null;
    const logs = readLogLines(runRecord);
    const provenance = runRecord.extensions?.provenance ?? null;
    const replayLog = logs.some((entry) => entry.message === 'acceptance.replay.event' && entry.type === 'github.issues.labeled');
    return {
      exitCode:
        redactionProof.eventFidelity === 'historical' &&
        redactionProof.runFidelity === 'historical' &&
        redactionProof.inputsFidelity === 'unavailable' &&
        redactionProof.stateFidelity === 'unavailable' &&
        redactionProof.httpFidelity === 'unavailable' &&
        redactionProof.modelFidelity === 'unavailable' &&
        !redactionProof.containsGitHubSecret &&
        !redactionProof.containsRelaySecret &&
        !redactionProof.containsAccessTokenSecret &&
        !redactionProof.containsPasswordSecret &&
        stateSource?.kind === 'replay' &&
        stateSource?.fidelity === 'unavailable' &&
        provenance?.sourceRunId === 'run-replay-fixture' &&
        provenance?.sourceEventId === 'event-legacy' &&
        replayLog &&
        runRecord.status === 'succeeded'
          ? 0
          : 1,
      summary:
        redactionProof.eventFidelity === 'historical' &&
        redactionProof.runFidelity === 'historical' &&
        redactionProof.inputsFidelity === 'unavailable' &&
        redactionProof.stateFidelity === 'unavailable' &&
        redactionProof.httpFidelity === 'unavailable' &&
        redactionProof.modelFidelity === 'unavailable' &&
        !redactionProof.containsGitHubSecret &&
        !redactionProof.containsRelaySecret &&
        !redactionProof.containsAccessTokenSecret &&
        !redactionProof.containsPasswordSecret &&
        stateSource?.kind === 'replay' &&
        stateSource?.fidelity === 'unavailable' &&
        provenance?.sourceRunId === 'run-replay-fixture' &&
        provenance?.sourceEventId === 'event-legacy' &&
        replayLog &&
        runRecord.status === 'succeeded'
          ? 'A deterministic replay bundle was generated via the real Cloud export path and consumed by Workforce invoke.'
          : 'Replay bundle consumption did not preserve the expected replay provenance.',
      artifactRefs: artifacts,
    };
  },
);

await runGate(
  'split-file-compatibility',
  `${formatCommand([
    'invoke',
    './hn-monitor/persona.ts',
    '--case',
    './hn-monitor/cases/agentic-feeds.case.yaml',
    '--output',
    '<run-record>',
  ])}`,
  async () => {
    const runRecordPath = resolve(artifactFilesRoot, 'split-file.run-record.json');
    const result = runAgentworkforce(
      [
        'invoke',
        './hn-monitor/persona.ts',
        '--case',
        './hn-monitor/cases/agentic-feeds.case.yaml',
        '--output',
        runRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );
    const stdoutArtifact = writeArtifact('split-file.stdout.txt', `${result.stdout}\n${result.stderr}`.trim() + '\n');
    const artifacts = [stdoutArtifact];
    if (result.status === 0) artifacts.push(relative(taskRoot, runRecordPath));
    const synthesizedWarning = /synthesized a minimal preview persona/u.test(`${result.stdout}\n${result.stderr}`);
    return {
      exitCode: result.status === 0 && !synthesizedWarning ? 0 : 1,
      summary:
        result.status === 0 && !synthesizedWarning
          ? 'Split-file persona.ts + agent.ts invocation succeeded without the bare-agent compatibility warning.'
          : 'Split-file persona compatibility failed or fell back to the bare-agent shim.',
      artifactRefs: artifacts,
    };
  },
);

await runGate('artifact-secret-scan', 'scan generated artifact contents for secret values', async () => {
  const findings = [];
  const concreteSecrets = [
    process.env.OPENAI_API_KEY,
    process.env.SLACK_BOT_TOKEN,
    process.env.RELAYFILE_TOKEN,
    process.env.WORKFORCE_TOKEN,
    'relay_pa_acceptance_preview_secret',
    'xoxb-acceptance-preview-token',
  ].filter(Boolean);
  const secretPatterns = [
    ['slack-token', /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]+\b/gu],
    ['relay-token', /\brelay(?:_pa|_ws)_[A-Za-z0-9_-]+\b/gu],
    ['github-token', /\bghp_[A-Za-z0-9]{20,}\b/gu],
    ['access-token-url', /\bx-access-token:(?!\[REDACTED\])[\w./~:%+-]+/gu],
    ['openai-token', /\bsk-(?:live|proj|test)-[A-Za-z0-9_-]+\b/gu],
  ];

  for (const file of listFiles(artifactFilesRoot)) {
    if (file.endsWith('artifact-secret-scan.json')) continue;
    const text = readFileSync(file, 'utf8');
    for (const secret of concreteSecrets) {
      if (secret && text.includes(secret)) {
        findings.push({
          file: relative(taskRoot, file),
          kind: 'exact',
          signature: secretLabel(secret),
        });
      }
    }
    for (const [label, pattern] of secretPatterns) {
      const matches = [...text.matchAll(pattern)].map((match) => match[0]);
      for (const match of matches) {
        findings.push({
          file: relative(taskRoot, file),
          kind: 'pattern',
          signature: `${label}:${shortHash(match)}`,
        });
      }
    }
  }

  const artifact = writeArtifact('artifact-secret-scan.json', JSON.stringify({ findings }, null, 2) + '\n');
  return {
    exitCode: findings.length === 0 ? 0 : 1,
    summary: findings.length === 0 ? 'No secret-shaped values were found in generated artifact contents.' : 'Secret-shaped values were found in generated artifact contents.',
    artifactRefs: [artifact],
  };
});

const completedAt = new Date().toISOString();
const finalResults = {
  startedAt,
  completedAt,
  repository: 'AgentWorkforce/agents',
  repositories: repoEvidence.repositories,
  packageArtifacts: repoEvidence.packageArtifacts,
  cli: {
    source: cliSource,
    identity: cliIdentity,
    overrideEnv: agentworkforceCliOverrideEnv,
    configDir: relative(taskRoot, workforceConfigDir),
  },
  gates: results,
};

writeFileSync(resolve(artifactRoot, 'results.json'), JSON.stringify(finalResults, null, 2) + '\n');
writeFileSync(resolve(artifactRoot, 'FINAL_ACCEPTANCE.md'), renderMarkdown(finalResults));

const failed = results.filter((gate) => gate.exitCode !== 0);
process.exit(failed.length === 0 ? 0 : 1);

function collectRepoEvidence() {
  return {
    repositories: {
      agents: gitHead(taskRoot),
      workforce: gitHead(workforceRoot),
      cloud: gitHead(cloudRoot),
      relayfileAdapters: gitHead(relayfileAdaptersRoot),
    },
    packageArtifacts: {
      agents: {
        agentworkforce: agentsPkg.devDependencies.agentworkforce,
        compose: agentsPkg.dependencies['@agentworkforce/compose'],
        runtime: agentsPkg.dependencies['@agentworkforce/runtime'],
        relayHelpers: agentsPkg.dependencies['@relayfile/relay-helpers'],
      },
      workforce: {
        cliOverride: process.env[agentworkforceCliOverrideEnv] ?? null,
        installedBin: agentworkforceBin,
      },
      cloud: {
        replayBundleModule: 'packages/web/lib/proactive-runtime/replay-bundle.ts',
      },
      relayfileAdapters: {
        relayHelpersInstalledVersion: readOptionalPackageVersion(resolve(taskRoot, 'node_modules/@relayfile/relay-helpers/package.json')),
      },
    },
  };
}

function gitHead(cwd) {
  return runShell(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.trim();
}

function baseAgentworkforceEnv() {
  return {
    AGENT_WORKFORCE_CONFIG_DIR: workforceConfigDir,
  };
}

function readOptionalPackageVersion(path) {
  try {
    return readJson(path).version ?? null;
  } catch {
    return null;
  }
}

function runShell(args, options = {}) {
  const [cmd, ...rest] = args;
  const result = spawnSync(cmd, rest, {
    cwd: options.cwd ?? taskRoot,
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeArtifact(name, contents) {
  const path = resolve(artifactFilesRoot, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return relative(taskRoot, path);
}

function formatCommand(args) {
  return [getAgentworkforceInvocation(args).command, ...getAgentworkforceInvocation(args).argv].join(' ');
}

function readLogLines(runRecord) {
  return (runRecord.extensions?.logs ?? [])
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line };
      }
    });
}

function assertLegacyHnParity() {
  const yamlCase = readFileSync(resolve(taskRoot, 'hn-monitor/cases/agentic-feeds.case.yaml'), 'utf8');
  const yamlMatch = yamlCase.match(/hn-monitor\.feed-scan front_page=\d+ show_hn=\d+ new=\d+/u)?.[0] ?? null;
  const jsonlEntry = readFileSync(resolve(taskRoot, 'evals/cases.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((entry) => entry.id === 'hn-monitor.agentic-feeds');
  const jsonlMatch = jsonlEntry?.expect?.logsAny?.find((value) => value.startsWith('hn-monitor.feed-scan')) ?? null;
  return {
    ok: yamlMatch !== null && yamlMatch === jsonlMatch,
    yaml: yamlMatch,
    jsonl: jsonlMatch,
  };
}

function listFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

function extractTopLevelCommands(helpText) {
  const lines = helpText.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Commands:');
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'Options:');
  const commandLines = lines.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : lines.length);
  return commandLines
    .map((line) => line.match(/^ {2}([a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]+)?)(?=\s{2,}|\s+(?:\[|<|"))/u)?.[1] ?? null)
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function secretLabel(value) {
  return `sha256:${shortHash(value)}`;
}

async function runGate(name, command, fn) {
  const begin = Date.now();
  try {
    const outcome = await fn();
    results.push({
      gate: name,
      command,
      exitCode: outcome.exitCode,
      status: outcome.exitCode === 0 ? 'passed' : 'failed',
      summary: outcome.summary,
      durationMs: Date.now() - begin,
      repositoryCommits: outcome.repositoryCommits ?? repoEvidence.repositories,
      packageArtifacts: repoEvidence.packageArtifacts,
      artifactRefs: outcome.artifactRefs ?? [],
    });
  } catch (error) {
    const artifact = writeArtifact(`${name}.error.txt`, `${String(error)}\n`);
    results.push({
      gate: name,
      command,
      exitCode: 1,
      status: 'failed',
      summary: String(error),
      durationMs: Date.now() - begin,
      repositoryCommits: repoEvidence.repositories,
      packageArtifacts: repoEvidence.packageArtifacts,
      artifactRefs: [artifact],
    });
  }
}

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
    counts,
    close: () => server.close(),
  };
}

function renderMarkdown(finalResults) {
  const lines = [
    '# Composable Runtime Closure Acceptance',
    '',
    `- Started: ${finalResults.startedAt}`,
    `- Completed: ${finalResults.completedAt}`,
    `- Agents commit: ${finalResults.repositories.agents}`,
    `- Workforce commit: ${finalResults.repositories.workforce}`,
    `- Cloud commit: ${finalResults.repositories.cloud}`,
    `- Relayfile adapters commit: ${finalResults.repositories.relayfileAdapters}`,
    `- Workforce CLI artifact: ${finalResults.cli.identity}`,
    `- AGENT_WORKFORCE_CONFIG_DIR: ${finalResults.cli.configDir}`,
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
