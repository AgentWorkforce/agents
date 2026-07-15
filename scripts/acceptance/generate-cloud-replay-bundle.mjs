#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: node --import tsx scripts/acceptance/generate-cloud-replay-bundle.mjs <output-path>');
  process.exit(1);
}

const cloudRoot = process.env.CLOUD_WORKTREE_ROOT
  ? resolve(process.env.CLOUD_WORKTREE_ROOT)
  : resolve(process.cwd(), '..', 'cloud');

const replayModule = await import(resolve(cloudRoot, 'packages/web/lib/proactive-runtime/replay-bundle.ts'));
const { buildReplayBundle } = replayModule;

const bundle = buildReplayBundle({
  runId: 'cloud-run-acceptance-1',
  exportedAt: '2026-07-15T10:00:00.000Z',
  event: {
    schemaVersion: 1,
    id: 'event-acceptance-1',
    workspace: '11111111-1111-4111-8111-111111111111',
    type: 'github.issues.labeled',
    contractVersion: 1,
    occurredAt: '2026-07-15T10:00:00.000Z',
    attempt: 1,
    resource: {
      path: '/github/repos/acme/cloud/issues/2619/meta.json',
      kind: 'github.issue',
      id: '2619',
      provider: 'github',
    },
    summary: { title: 'Issue labeled' },
    payload: {
      issue: { number: 2619, title: 'Closure acceptance' },
      label: { name: 'acceptance' },
      sender: { login: 'octocat' },
    },
  },
  run: {
    id: 'cloud-run-acceptance-1',
    status: 'succeeded',
    summary: 'deterministic replay bundle fixture',
  },
  inputs: {
    SOURCE: 'cloud-replay-bundle',
  },
  state: {
    schemaVersion: 1,
    kind: 'replay-state',
    fidelity: 'historical',
    memory: [{ id: 'mem-historical-1', scope: 'workspace', tags: ['acceptance-replay'] }],
  },
});

writeFileSync(outputPath, JSON.stringify(bundle, null, 2) + '\n');
