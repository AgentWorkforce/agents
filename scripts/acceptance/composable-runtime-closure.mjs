#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSentinelServer } from './sentinel-server.mjs';
import { createIntegrationHealthServer } from './integration-health-server.mjs';
import { createModelMockServer } from './model-mock-server.mjs';
import { writeBlockedFile, removeBlockedFile } from './blocked-lifecycle.mjs';
import {
  acceptancePackageSourceModes,
  createLocalPackWorkforceProof,
  createPublishedInstalledWorkforceProof,
  resolveAcceptancePackageSourceMode,
} from './workforce-package-proof.mjs';

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
const acceptancePackageSourceMode = resolveAcceptancePackageSourceMode();
const workforcePackageArtifacts = {
  proofMode: acceptancePackageSourceMode,
  cliOverrideRequested: process.env[agentworkforceCliOverrideEnv] ?? null,
  producerArtifacts: [],
  requiredPackages: [],
  installedPackages: {},
  installCommand: null,
  installedBin: agentworkforceBin,
};

const repoEvidence = collectRepoEvidence(workforcePackageArtifacts);
let cliIdentity = agentworkforceBin;
let cliSource = 'installed-package';

await runGate(
  'cli-help-snapshot',
  [
    acceptancePackageSourceMode === acceptancePackageSourceModes.localPack
      ? 'pack and install the reviewed Workforce producer artifacts'
      : 'validate the exact published Workforce package versions',
    'agentworkforce --help',
    'agentworkforce invoke --help',
    'agentworkforce runs export --help',
  ].join('\n'),
  async () => {
    if (process.env[agentworkforceCliOverrideEnv]?.trim()) {
      return {
        exitCode: 1,
        summary: `${agentworkforceCliOverrideEnv} is set. This acceptance must run through the installed package path without source overrides.`,
        artifactRefs: [],
      };
    }

    if (!isSupportedAcceptanceNode()) {
      return {
        exitCode: 1,
        summary: `Acceptance requires patched Node >=26.5.0 with permission flags; detected ${process.versions.node} at ${process.execPath}.`,
        artifactRefs: [],
      };
    }

    const packageOutcome = acceptancePackageSourceMode === acceptancePackageSourceModes.localPack
      ? createLocalPackWorkforceProof({
        taskRoot,
        workforceRoot,
        artifactRoot,
        agentsPackage: agentsPkg,
      })
      : createPublishedInstalledWorkforceProof({
        taskRoot,
        workforceRoot,
        agentsPackage: agentsPkg,
      });

    Object.assign(workforcePackageArtifacts, packageOutcome.proof);
    cliIdentity = getAgentworkforceInvocation([]).identity;
    cliSource = getAgentworkforceInvocation([]).source;
    if (packageOutcome.exitCode !== 0) return packageOutcome;

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
      exitCode:
        topHelp.ok
        && invokeFlags.ok
        && exportFlags.ok
        && missing.length === 0
        && topLevelDrift.length === 0
          ? 0
          : 1,
      summary:
        missing.length === 0 && topLevelDrift.length === 0
          ? `${packageOutcome.summary} Captured CLI surface for ${cliSource} artifact ${cliIdentity}.`
          : `${packageOutcome.summary} CLI surface mismatch: ${[...missing, ...topLevelDrift].join(', ')}`,
      artifactRefs: [...packageOutcome.artifactRefs, ...helpArtifacts],
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

await runGate('hn-case-suite', 'node scripts/run-hn-platform-cases.mjs + live-read once + live-model once with local Codex SSE mock', async () => {
  const modelMock = await createModelMockServer();

  let deterministicResult = null;
  let liveReadResult = null;
  let liveModelResult = null;
  let liveReadRecord = null;
  let liveModelRecord = null;

  try {
    deterministicResult = runShell(['node', 'scripts/run-hn-platform-cases.mjs'], {
      cwd: taskRoot,
      env: baseAgentworkforceEnv(),
    });

    const liveReadRunRecordPath = resolve(artifactFilesRoot, 'live-read.run-record.json');
    liveReadResult = runAgentworkforce(
      [
        'invoke',
        './hn-monitor/agent.ts',
        '--case',
        './hn-monitor/cases/live-read.case.yaml',
        '--output',
        liveReadRunRecordPath,
      ],
      {
        env: baseAgentworkforceEnv(),
        timeoutMs: invokeTimeoutMs,
      },
    );

    const liveModelRunRecordPath = resolve(artifactFilesRoot, 'live-model.run-record.json');
    liveModelResult = await runAgentworkforceExactEnvAsync(
      [
        'invoke',
        './hn-monitor/agent.ts',
        '--case',
        './hn-monitor/cases/live-model.case.yaml',
        '--output',
        liveModelRunRecordPath,
      ],
      {
        env: buildSanitizedAgentworkforceEnv({
          CODEX_BACKEND_BASE_URL: modelMock.codexBase,
          CODEX_OAUTH_CREDENTIAL: modelMock.mockCredential,
        }),
        timeoutMs: invokeTimeoutMs,
      },
    );

    if (liveReadResult.status === 0) liveReadRecord = readJson(liveReadRunRecordPath);
    if (liveModelResult.status === 0) liveModelRecord = readJson(liveModelRunRecordPath);
  } finally {
    modelMock.close();
  }

  const artifact = writeArtifact('hn-case-suite.txt', `${deterministicResult.stdout}\n${deterministicResult.stderr}`.trim() + '\n');
  const liveReadArtifact = writeArtifact('live-read.stdout.txt', `${liveReadResult.stdout}\n${liveReadResult.stderr}`.trim() + '\n');
  const liveModelArtifact = writeArtifact('live-model.stdout.txt', `${liveModelResult.stdout}\n${liveModelResult.stderr}`.trim() + '\n');
  const modelCountsArtifact = writeArtifact('model-mock-server.counts.json', JSON.stringify(modelMock.counts, null, 2) + '\n');
  const parity = assertLegacyHnParity();
  const parityArtifact = writeArtifact('hn-case-parity.json', JSON.stringify(parity, null, 2) + '\n');

  const artifacts = [artifact, liveReadArtifact, liveModelArtifact, modelCountsArtifact, parityArtifact];
  if (liveReadResult?.status === 0) artifacts.push(relative(taskRoot, resolve(artifactFilesRoot, 'live-read.run-record.json')));
  if (liveModelResult?.status === 0) artifacts.push(relative(taskRoot, resolve(artifactFilesRoot, 'live-model.run-record.json')));

  const liveReadHttpReads = (liveReadRecord?.actions ?? []).filter((action) => action.kind === 'http.read');
  const liveReadHttpSourceFidelities = collectSourceFidelities(liveReadRecord ?? {}, 'http.read');
  const liveReadFeedKinds = [...new Set(liveReadHttpReads.map((action) => classifyHnFeedRead(action.data?.url)).filter(Boolean))];
  const liveReadCurrentHn =
    liveReadHttpReads.length === 3 &&
    liveReadHttpReads.every(
      (action) =>
        action.status === 'previewed' &&
        action.extensions?.sourceFidelity === 'current' &&
        isCurrentHnGet(action.data?.url, action.data?.method),
    ) &&
    liveReadHttpSourceFidelities.length === 1 &&
    liveReadHttpSourceFidelities[0] === 'current' &&
    liveReadFeedKinds.length === 3;
  const liveReadNoForbiddenWrites = !(liveReadRecord?.actions ?? []).some(
    (action) => action.kind === 'provider.write' && action.status === 'live',
  );

  const liveModelHttpReads = (liveModelRecord?.actions ?? []).filter((action) => action.kind === 'http.read');
  const liveModelHttpSourceFidelities = collectSourceFidelities(liveModelRecord ?? {}, 'http.read');
  const liveModelModelSourceFidelities = collectSourceFidelities(liveModelRecord ?? {}, 'model.complete');
  const liveModelModelActions = (liveModelRecord?.actions ?? []).filter((action) => action.kind === 'model.complete');
  const liveModelSlackWrites = (liveModelRecord?.actions ?? []).filter(
    (action) => action.kind === 'provider.write' && action.provider === 'slack',
  );
  const liveModelFixtureReads =
    liveModelHttpReads.length === 3 &&
    liveModelHttpReads.every((action) => action.status === 'previewed' && isFixtureHnSource(action.data?.source)) &&
    ['front_page', 'show_hn', 'new'].every((feed) => liveModelHttpReads.some((action) => classifyHnFeedRead(action.data?.url) === feed));
  const liveModelPreviewOnlyWrites =
    liveModelSlackWrites.length >= 1 && liveModelSlackWrites.every((action) => action.status === 'previewed');
  const liveModelNoForbiddenWrites = liveModelSlackWrites.every((action) => action.status !== 'live');
  const liveModelHttpFidelityFixture = liveModelHttpSourceFidelities.includes('fixture');
  const liveModelModelFidelityCurrent = liveModelModelSourceFidelities.includes('current');
  const modelCallsTotal = modelMock.counts.total;
  const modelCallsExact = modelCallsTotal > 0 && modelCallsTotal === liveModelModelActions.length;
  const modelCallsExpectedOnly =
    modelMock.counts.unexpected.length === 0 &&
    modelMock.counts.requests.length > 0 &&
    modelMock.counts.requests.every((request) =>
      request.method === 'POST' &&
      request.path === '/backend-api/codex/responses' &&
      request.authMatchedExpected === true &&
      request.accountMatchedExpected === true,
    );

  const evidentSummary = [
    `live-read HN GETs: ${liveReadHttpReads.length} (${liveReadFeedKinds.join(', ') || 'none'})`,
    `live-read http fidelity: ${liveReadHttpSourceFidelities.join(', ') || 'missing'}`,
    `live-read forbidden writes: ${!liveReadNoForbiddenWrites}`,
    `live-model fixture HN GETs: ${liveModelHttpReads.length}`,
    `live-model http fidelity: ${liveModelHttpSourceFidelities.join(', ') || 'missing'}`,
    `live-model model fidelity: ${liveModelModelSourceFidelities.join(', ') || 'missing'}`,
    `live-model mock calls: ${modelCallsTotal}`,
    `live-model preview writes: ${liveModelSlackWrites.length}`,
  ].join('; ');

  writeArtifact('hn-live-evidence.json', JSON.stringify({
    liveRead: {
      httpReadCount: liveReadHttpReads.length,
      feeds: liveReadFeedKinds,
      urls: liveReadHttpReads.map((action) => action.data?.url ?? null),
      httpSourceFidelities: liveReadHttpSourceFidelities,
      noForbiddenWrites: liveReadNoForbiddenWrites,
    },
    liveModel: {
      httpReadCount: liveModelHttpReads.length,
      httpUrls: liveModelHttpReads.map((action) => action.data?.url ?? null),
      httpSources: liveModelHttpReads.map((action) => action.data?.source ?? null),
      httpSourceFidelities: liveModelHttpSourceFidelities,
      modelSourceFidelities: liveModelModelSourceFidelities,
      modelActionCount: liveModelModelActions.length,
      previewWriteCount: liveModelSlackWrites.length,
      previewOnlyWrites: liveModelPreviewOnlyWrites,
      noForbiddenWrites: liveModelNoForbiddenWrites,
    },
    modelMockCounts: modelMock.counts,
    modelCallsExact,
    modelCallsExpectedOnly,
    parity,
  }, null, 2) + '\n');

  const allOk =
    deterministicResult.status === 0 &&
    parity.ok &&
    liveReadResult.status === 0 &&
    liveModelResult.status === 0 &&
    liveReadCurrentHn &&
    liveReadNoForbiddenWrites &&
    liveModelFixtureReads &&
    liveModelHttpFidelityFixture &&
    liveModelModelFidelityCurrent &&
    modelCallsExact &&
    modelCallsExpectedOnly &&
    liveModelPreviewOnlyWrites &&
    liveModelNoForbiddenWrites &&
    !artifactContainsAny(
      artifactFilesRoot,
      [
        modelMock.mockCredential,
        modelMock.mockAccessToken,
        modelMock.mockRefreshToken,
        process.env.CODEX_OAUTH_CREDENTIAL,
        process.env.CODEX_OAUTH_TOKEN,
        process.env.CODEX_ACCOUNT_ID,
        process.env.OPENAI_API_KEY,
        process.env.ANTHROPIC_API_KEY,
        process.env.CLAUDE_CODE_OAUTH_TOKEN,
        process.env.OPENCODE_API_KEY,
      ].filter(Boolean),
    );

  return {
    exitCode: allOk ? 0 : 1,
    summary: allOk
      ? `All HN cases passed; live-read hit the real HN GET allowlist once and live-model stayed on fixture HN reads plus the local Codex SSE mock only. ${evidentSummary}.`
      : `HN case coverage or live evidence failed. ${evidentSummary}.`,
    artifactRefs: artifacts,
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
    const hnRunRecordPath = resolve(artifactFilesRoot, 'slack-follow-up.run-record.json');
    const hnResult = runAgentworkforce(
      [
        'invoke',
        './hn-monitor/agent.ts',
        '--case',
        './hn-monitor/cases/slack-follow-up.case.yaml',
        '--output',
        hnRunRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );
    const linkRunRecordPath = resolve(artifactFilesRoot, 'preview-thread-link.run-record.json');
    const linkResult = runAgentworkforce(
      [
        'invoke',
        './scripts/acceptance/fixtures/preview-thread-link-persona.ts',
        '--case',
        './scripts/acceptance/fixtures/preview-thread-link.case.yaml',
        '--output',
        linkRunRecordPath,
      ],
      { env: baseAgentworkforceEnv(), timeoutMs: invokeTimeoutMs },
    );

    const hnStdoutArtifact = writeArtifact('slack-follow-up.stdout.txt', `${hnResult.stdout}\n${hnResult.stderr}`.trim() + '\n');
    const linkStdoutArtifact = writeArtifact('preview-thread-link.stdout.txt', `${linkResult.stdout}\n${linkResult.stderr}`.trim() + '\n');
    const artifacts = [hnStdoutArtifact, linkStdoutArtifact];
    if (hnResult.status === 0) artifacts.push(relative(taskRoot, hnRunRecordPath));
    if (linkResult.status === 0) artifacts.push(relative(taskRoot, linkRunRecordPath));
    if (hnResult.status !== 0 || linkResult.status !== 0) {
      return {
        exitCode: hnResult.status || linkResult.status,
        summary: 'Multi-turn closure evidence failed before validation completed.',
        artifactRefs: artifacts,
      };
    }

    const hnRunRecord = readJson(hnRunRecordPath);
    const linkRunRecord = readJson(linkRunRecordPath);
    const turns = hnRunRecord.extensions?.turns ?? [];
    const logs = readLogLines(hnRunRecord);
    const hasHydrated = logs.some((entry) => entry.message === 'hn-monitor.qa.hydrated');
    const hasReply = logs.some((entry) => entry.message === 'hn-monitor.qa.slack-replied');

    // Memory recall continuity: turn 2 must recall >= 1 item saved in turn 1.
    const recalled = hnRunRecord.actions.some((action) => action.kind === 'memory.recall' && action.data?.items >= 1);

    // Turn 1 must have saved the HN post (memory.save tagged hn-monitor:post).
    const turn1PostSaved = hnRunRecord.actions.some(
      (action) => action.kind === 'memory.save' && (action.data?.tags ?? []).includes('hn-monitor:post'),
    );
    const filesPersisted =
      hnRunRecord.actions.some((action) => action.kind === 'files.write' && (action.data?.path ?? '').includes('/hn-monitor/digests/by-thread/')) &&
      hnRunRecord.actions.some((action) => action.kind === 'files.write' && (action.data?.path ?? '').endsWith('/hn-monitor/recent-digests.json'));

    // Turn 2 grounding: qa.selected log must show source === exact_state or memory (not algolia),
    // proving the cross-turn state (not a live fallback) resolved the story.
    const qaSelectedLog = logs.find((entry) => entry.message === 'hn-monitor.qa.selected');
    const qaSource = qaSelectedLog?.source ?? qaSelectedLog?.data?.source;
    const groundedFromRecall = qaSource === 'exact_state' || qaSource === 'memory';

    const linkTurns = linkRunRecord.extensions?.turns ?? [];
    const linkWrites = linkRunRecord.actions.filter((action) => action.kind === 'provider.write' && action.provider === 'slack');
    const linkParentWrite = linkWrites.find((action) => !action.data?.body?.parentRef);
    const linkReplyWrite = linkWrites.find((action) => typeof action.data?.body?.parentRef === 'string');
    const exactThreadLink =
      Boolean(linkParentWrite) &&
      Boolean(linkReplyWrite) &&
      linkReplyWrite.data.body.parentRef === linkParentWrite.data.path &&
      linkReplyWrite.data.body.thread_ts === linkParentWrite.data.simulatedReceipt?.id;

    const multiTurnOk =
      turns.length === 2 &&
      hasHydrated &&
      hasReply &&
      recalled &&
      turn1PostSaved &&
      filesPersisted &&
      groundedFromRecall &&
      linkTurns.length === 2 &&
      exactThreadLink;

    const multiTurnEvidence = {
      hnFollowUp: {
        turns: turns.length,
        hasHydrated,
        hasReply,
        recalled,
        turn1PostSaved,
        filesPersisted,
        qaSource: qaSource ?? null,
        groundedFromRecall,
      },
      previewThreadLink: {
        turns: linkTurns.length,
        parentPath: linkParentWrite?.data?.path ?? null,
        parentReceiptId: linkParentWrite?.data?.simulatedReceipt?.id ?? null,
        replyParentRef: linkReplyWrite?.data?.body?.parentRef ?? null,
        replyThreadTs: linkReplyWrite?.data?.body?.thread_ts ?? null,
        exactThreadLink,
      },
    };
    writeArtifact('multi-turn-evidence.json', JSON.stringify(multiTurnEvidence, null, 2) + '\n');

    return {
      exitCode: multiTurnOk ? 0 : 1,
      summary: multiTurnOk
        ? `Two-turn HN follow-up preserved memory/files grounding, and the acceptance thread-link case proved exact preview threading continuity (parentRef=${linkReplyWrite?.data?.body?.parentRef}, thread_ts=${linkReplyWrite?.data?.body?.thread_ts}).`
        : `Multi-turn HN follow-up or preview thread-link evidence failed. ${JSON.stringify(multiTurnEvidence)}.`,
      artifactRefs: [...artifacts, '.workflow-artifacts/composable-runtime-closure/artifacts/multi-turn-evidence.json'],
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
      '--input',
      'UNDECLARED_GET_URL=<sentinel>',
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
      '--input',
      'UNDECLARED_GET_URL=<sentinel>',
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
          '--input',
          `UNDECLARED_GET_URL=${sentinel.undeclaredUrl}`,
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
          '--input',
          `UNDECLARED_GET_URL=${sentinel.undeclaredUrl}`,
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
      const undeclaredBlocked = fetchRecord
        ? readLogLines(fetchRecord).some((entry) => entry.message === 'acceptance.fetch.undeclared-get.blocked') ||
          fetchRecord.actions?.some((action) => action.kind === 'http.read' && action.status === 'denied' && (action.data?.url ?? '').includes('/undeclared-get'))
        : false;

      return {
        exitCode:
          fetchProbe.status === 0 &&
          sentinel.counts.allowed.get === 2 &&
          sentinel.counts.denied.post === 0 &&
          sentinel.counts.denied.raw === 0 &&
          sentinel.counts.undeclared.get === 0 &&
          rawImport.status === 0 &&
          rawDenied &&
          rawBlocked &&
          blockedPost &&
          undeclaredBlocked
            ? 0
            : 1,
        summary:
          fetchProbe.status === 0 &&
          sentinel.counts.allowed.get === 2 &&
          sentinel.counts.denied.post === 0 &&
          sentinel.counts.denied.raw === 0 &&
          sentinel.counts.undeclared.get === 0 &&
          rawImport.status === 0 &&
          rawDenied &&
          rawBlocked &&
          blockedPost &&
          undeclaredBlocked
            ? 'Declared GETs reached the sentinel twice; undeclared GET, fetch POST, and raw node:http writes were blocked before any denied write landed.'
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
    const composeRunPreviewed = runRecord?.actions?.some((action) => action.kind === 'compose.run' && action.status === 'previewed');
    const shellExecPresent = runRecord?.actions?.some((action) => action.kind === 'shell.exec');

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

    // Integration-health CLI projection proof
    const integHealthServer = await createIntegrationHealthServer();
    let integHealthResult = null;
    let integHealthStdout = '';
    try {
      const integHealthEnv = {
        ...baseAgentworkforceEnv(),
        WORKFORCE_WORKSPACE_ID: integHealthServer.workspaceId,
        WORKFORCE_WORKSPACE_TOKEN: 'acceptance-integ-health-token',
      };
      integHealthResult = await runAgentworkforceAsync(
        [
          'integrations',
          'github',
          '--json',
          `--cloud-url=${integHealthServer.url}`,
        ],
        { env: integHealthEnv, timeoutMs: invokeTimeoutMs },
      );
      integHealthStdout = integHealthResult.stdout;
    } finally {
      integHealthServer.close();
    }
    const integHealthArtifact = writeArtifact(
      'cloud-integ-health.stdout.txt',
      `${integHealthStdout}\n${integHealthResult?.stderr ?? ''}`.trim() + '\n',
    );
    // receivedRequests stores only hasAuth/authScheme — never the raw credential.
    const integHealthRequestsArtifact = writeArtifact(
      'cloud-integ-health.server-requests.json',
      JSON.stringify(integHealthServer.receivedRequests, null, 2) + '\n',
    );
    artifacts.push(integHealthArtifact, integHealthRequestsArtifact);

    let integHealthDoc = null;
    try { integHealthDoc = integHealthResult?.status === 0 ? JSON.parse(integHealthStdout) : null; } catch {}
    const githubRow = integHealthDoc?.integrations?.find((row) => row.id === 'github');
    const integHealthPopulated = !!(githubRow?.registrationHealth);

    // Assert all five expected Cloud endpoints were reached and all carried auth.
    const wsId = integHealthServer.workspaceId;
    const expectedPaths = [
      '/api/v1/integrations/catalog',
      '/api/v1/me/integrations',
      `/api/v1/workspaces/${encodeURIComponent(wsId)}/integrations`,
      `/api/v1/workspaces/${encodeURIComponent(wsId)}/integrations/github/status?scope=deployer_user`,
      `/api/v1/workspaces/${encodeURIComponent(wsId)}/integrations/github/status?scope=workspace`,
    ];
    const reqs = integHealthServer.receivedRequests;
    const allFivePresent = expectedPaths.every((p) => reqs.some((r) => r.url === p));
    const allFiveAuthed = expectedPaths.every((p) => reqs.some((r) => r.url === p && r.hasAuth));
    const integAuthPresent = allFivePresent && allFiveAuthed;

    return {
      exitCode:
        workerTypecheck.status === 0 &&
        routerTypecheck.status === 0 &&
        workerTests.status === 0 &&
        routeCoverage.status === 0 &&
        ingress.status === 0 &&
        webhookIngress.status === 0 &&
        replay.status === 0 &&
        integHealthResult?.status === 0 &&
        integHealthPopulated &&
        integAuthPresent
          ? 0
          : 1,
      summary:
        workerTypecheck.status === 0 &&
        routerTypecheck.status === 0 &&
        workerTests.status === 0 &&
        routeCoverage.status === 0 &&
        ingress.status === 0 &&
        webhookIngress.status === 0 &&
        replay.status === 0 &&
        integHealthResult?.status === 0 &&
        integHealthPopulated &&
        integAuthPresent
          ? 'Cloud router/webhook-worker/ingress/Composio/replay parity suites passed at the sibling Cloud commit; integration health projection populated and auth was forwarded.'
          : 'Cloud focused parity, replay suite, or integration health projection failed.',
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
    process.env.ANTHROPIC_API_KEY,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.OPENCODE_API_KEY,
    process.env.CODEX_OAUTH_TOKEN,
    process.env.CODEX_ACCOUNT_ID,
    process.env.CODEX_OAUTH_CREDENTIAL,
    'relay_pa_acceptance_preview_secret',
    'xoxb-acceptance-preview-token',
    'acceptance-integ-health-token',
    'dummy-mock-access-token',
    'dummy-mock-refresh-token',
    'acct-live-model-mock',
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
    nodeVersion: process.versions.node,
    nodeExecutable: process.execPath,
    configDir: relative(taskRoot, workforceConfigDir),
  },
  gates: results,
};

writeFileSync(resolve(artifactRoot, 'results.json'), JSON.stringify(finalResults, null, 2) + '\n');
writeFileSync(resolve(artifactRoot, 'FINAL_ACCEPTANCE.md'), renderMarkdown(finalResults));

const failed = results.filter((gate) => gate.exitCode !== 0);

const blockedPath = resolve(artifactRoot, 'BLOCKED_NO_MERGE.md');
if (failed.length > 0) {
  writeBlockedFile(blockedPath, failed, repoEvidence.repositories.agents);
} else {
  removeBlockedFile(blockedPath);
}

process.exit(failed.length === 0 ? 0 : 1);

function collectRepoEvidence(workforceArtifacts) {
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
      workforce: workforceArtifacts,
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

function isSupportedAcceptanceNode() {
  return compareVersions(process.versions.node, '26.5.0') >= 0
    && ['--permission', '--allow-fs-read', '--allow-net']
      .every((flag) => process.allowedNodeEnvironmentFlags.has(flag));
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function baseAgentworkforceEnv() {
  return {
    AGENT_WORKFORCE_CONFIG_DIR: workforceConfigDir,
  };
}

function buildSanitizedAgentworkforceEnv(overrides = {}) {
  const env = { ...baseAgentworkforceEnv() };
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'USER',
    'LOGNAME',
    'SHELL',
    'TERM',
    'CI',
    'NO_COLOR',
    'FORCE_COLOR',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    ...overrides,
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
  const command = cmd === 'node' ? process.execPath : cmd;
  const result = spawnSync(command, rest, {
    cwd: options.cwd ?? taskRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    input: options.input,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: [command, ...rest].join(' '),
  };
}

function runAgentworkforceExactEnvAsync(args, options = {}) {
  const {
    cwd = taskRoot,
    env = {},
    input,
    timeoutMs,
  } = options;
  const invocation = getAgentworkforceInvocation(args);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.argv, {
      cwd,
      env,
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutId;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolvePromise(result);
    };
    const killChild = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 500).unref();
    };

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', rejectPromise);
    child.on('close', (status) => {
      if (timedOut) return;
      finish({
        ok: status === 0,
        status: status ?? 1,
        stdout,
        stderr,
        command: formatCommand(args),
      });
    });

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        stderr = `${stderr}${stderr ? '\n' : ''}Timed out after ${timeoutMs}ms`;
        killChild();
        finish({
          ok: false,
          status: 124,
          stdout,
          stderr,
          command: formatCommand(args),
        });
      }, timeoutMs);
    }
  });
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

function artifactContainsAny(root, secrets) {
  for (const file of listFiles(root)) {
    const text = readFileSync(file, 'utf8');
    if (secrets.some((secret) => secret && text.includes(secret))) {
      return true;
    }
  }
  return false;
}

function classifyHnFeedRead(urlText) {
  if (typeof urlText !== 'string') return null;
  try {
    const url = new URL(urlText);
    const tags = url.searchParams.get('tags');
    if (tags === 'front_page') return 'front_page';
    if (tags === 'show_hn') return 'show_hn';
    if (tags === 'story') return 'new';
    return null;
  } catch {
    return null;
  }
}

function isCurrentHnGet(urlText, method) {
  if (method !== 'GET' || typeof urlText !== 'string') return false;
  try {
    const url = new URL(urlText);
    return url.hostname === 'hn.algolia.com' && classifyHnFeedRead(urlText) !== null;
  } catch {
    return false;
  }
}

function isFixtureHnSource(source) {
  return source === 'fixture' ||
    (typeof source === 'string' && /\/hn-monitor\/fixtures\/hn-(front-page|show-hn|new)\.json$/u.test(source));
}

function collectSourceFidelities(runRecord, kind) {
  const values = [];
  for (const entry of [...(runRecord.trace ?? []), ...(runRecord.actions ?? [])]) {
    if (entry.kind !== kind) continue;
    for (const candidate of [
      entry.sourceFidelity,
      entry.data?.sourceFidelity,
      entry.data?.fidelity,
      entry.extensions?.sourceFidelity,
      kind === 'http.read' ? runRecord.extensions?.sourceFidelity?.http : undefined,
      kind === 'model.complete' ? runRecord.extensions?.sourceFidelity?.model : undefined,
    ]) {
      if (typeof candidate === 'string' && !values.includes(candidate)) values.push(candidate);
    }
  }
  return values;
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
    `- CLI source: ${finalResults.cli.source}`,
    `- Workforce CLI artifact: ${finalResults.cli.identity}`,
    `- Node runtime: ${finalResults.cli.nodeVersion} (${finalResults.cli.nodeExecutable})`,
    `- Workforce package proof mode: ${finalResults.packageArtifacts.workforce.proofMode}`,
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
