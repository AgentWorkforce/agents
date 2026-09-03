#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PreviewTransport, clearPreviewTransport, setPreviewTransport } from '@relayfile/relay-helpers';

const bundleDir = process.argv[2];
if (!bundleDir) throw new Error('usage: hn-relayflow-bundle-smoke.mjs <bundle-dir>');

const bundle = await import(pathToFileURL(path.resolve(bundleDir, 'agent.bundle.mjs')).href);
const saved = [];
const files = new Map();
const preview = new PreviewTransport({ idFactory: (_request, sequence) => String(sequence) });
let workflowCall;

const ctx = {
  workspaceId: 'bundle-smoke-workspace',
  agentName: 'hn-monitor',
  log() {},
  persona: {
    inputs: { SLACK_CHANNEL: 'C123', TOPICS: 'agents,orchestration', LOOKBACK_HOURS: '24', MAX_STORIES: '8' },
    inputSpecs: {
      SLACK_CHANNEL: { env: 'SLACK_CHANNEL', optional: true },
      TELEGRAM_CHAT: { env: 'TELEGRAM_CHAT', optional: true },
      TOPICS: { env: 'TOPICS', default: 'agents,orchestration' },
      LOOKBACK_HOURS: { env: 'LOOKBACK_HOURS', default: '24' },
      MAX_STORIES: { env: 'MAX_STORIES', default: '8' },
    },
  },
  memory: {
    async save(content, opts) {
      saved.push({ content, opts });
      return { id: `memory-${saved.length}` };
    },
    async recall() { return []; },
  },
  files: {
    async read(name) {
      if (files.has(name)) return files.get(name);
      const error = new Error(`ENOENT: ${name}`);
      error.code = 'ENOENT';
      throw error;
    },
    async write(name, value) { files.set(name, value); },
  },
  workflow: {
    async run(name, args) {
      workflowCall = { name, args, source: files.get(`workflows/${name}.ts`) };
      return {
        runId: 'bundle-smoke',
        async completion() {
          return {
            status: 'success',
            output: 'HN_DIGEST_NOTES_JSON:{"theme":"Durable HN orchestration.","stories":[{"id":20,"why":"Exercises a journaled agent workflow."}]}',
          };
        },
      };
    },
  },
};

const fixtureStory = {
  id: 20,
  title: 'Show HN: Durable agent workflow journals',
  url: 'https://example.com/agent-workflows',
  points: 120,
  comments: 42,
  feeds: ['show_hn'],
  category: 'agent orchestration',
};

setPreviewTransport(preview);
try {
  await bundle.runScheduledScan(ctx, { fetchStories: async () => [fixtureStory] });
} finally {
  clearPreviewTransport();
}

const posts = preview.actions.filter((action) => action.kind === 'provider.write' && action.provider === 'slack');

assert.equal(workflowCall?.name, 'hn-monitor-scheduled-digest-v1');
assert.equal(workflowCall?.args.relayflowVersion, 'v1');
assert.match(workflowCall?.source ?? '', /from '@relayflows\/core'/u);
assert.doesNotMatch(workflowCall?.source ?? '', /from ['"]\.\/relayflow-v1-resume/u);
assert.equal(posts.length, 2);
assert.ok(posts.every((post) => typeof post.body.idempotencyKey === 'string'));
assert.equal(posts[1].body.parentRef, posts[0].path);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:seen')).length, 1);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:post')).length, 1);
const outboxSaves = saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:digest-outbox'));
assert.equal(outboxSaves.length, 7);
assert.equal(JSON.parse(outboxSaves.at(-1).content).cleared, true);

const sourceDir = await mkdtemp(path.resolve('.hn-relayflow-bundle-source-'));
let sourceDryRun;
try {
  const workflowPath = path.join(sourceDir, 'hn-monitor-scheduled-digest-v1.ts');
  await writeFile(workflowPath, workflowCall.source);
  sourceDryRun = spawnSync(
    path.resolve('node_modules/.bin/tsx'),
    [workflowPath],
    {
      cwd: sourceDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        DRY_RUN: '1',
        invocationArgs: JSON.stringify(workflowCall.args),
      },
    },
  );
  assert.equal(sourceDryRun.status, 0, `${sourceDryRun.stdout}\n${sourceDryRun.stderr}`);
  assert.match(sourceDryRun.stdout, /HN_RELAYFLOW_DRY_RUN:/u);
  assert.match(sourceDryRun.stdout, /"name":"hn-monitor-scheduled-digest-v1-workflow"/u);
} finally {
  await rm(sourceDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  workflow: workflowCall.name,
  version: workflowCall.args.relayflowVersion,
  sourceBytes: workflowCall.source.length,
  posts: posts.length,
  stateSaves: saved.length,
  emittedSourceDryRun: sourceDryRun?.status === 0,
}));
