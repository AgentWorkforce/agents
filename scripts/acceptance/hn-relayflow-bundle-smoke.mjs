#!/usr/bin/env node

import assert from 'node:assert/strict';
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
let workflowSource;
let sandboxExec;

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
  sandbox: {
    cwd: '/workspace',
    async writeFile(filePath, contents) {
      workflowSource = { filePath, contents };
    },
    async exec(command, options) {
      sandboxExec = { command, options };
      workflowCall = JSON.parse(options.env.invocationArgs);
      return {
        exitCode: 0,
        output: 'HN_DIGEST_NOTES_JSON:{"theme":"Durable HN orchestration.","stories":[{"id":20,"why":"Exercises the bundled local runner."}]}\nHN_RELAYFLOW_RUN_ID:bundle-smoke\n',
      };
    },
  },
  workflow: {
    async run() {
      throw new Error('bundle smoke must not allocate a hosted workflow sandbox');
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
  await bundle.runScheduledScan(ctx, {
    fetchStories: async () => [fixtureStory],
  });
} finally {
  clearPreviewTransport();
}

const posts = preview.actions.filter((action) => action.kind === 'provider.write' && action.provider === 'slack');

assert.equal(workflowCall?.relayflowVersion, 'v1');
assert.equal(workflowCall?.batchKey, 'hn-monitor:v1:20');
assert.match(workflowSource?.filePath ?? '', /\.agentworkforce\/hn-monitor\/workflows\/hn-monitor-scheduled-digest-v1\.ts$/u);
assert.match(workflowSource?.contents ?? '', /from '@relayflows\/core'/u);
assert.match(sandboxExec?.command ?? '', /command -v agent-relay/u);
assert.match(sandboxExec?.command ?? '', /node --experimental-strip-types/u);
assert.equal(sandboxExec?.options?.cwd, '/workspace');
assert.equal(posts.length, 2);
assert.ok(posts.every((post) => typeof post.body.idempotencyKey === 'string'));
assert.equal(posts[1].body.parentRef, posts[0].path);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:seen')).length, 1);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:post')).length, 1);
const outboxSaves = saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:digest-outbox'));
assert.equal(outboxSaves.length, 7);
assert.equal(JSON.parse(outboxSaves.at(-1).content).cleared, true);

console.log(JSON.stringify({
  workflow: 'hn-monitor-scheduled-digest-v1',
  version: workflowCall.relayflowVersion,
  posts: posts.length,
  stateSaves: saved.length,
  bundledLocalRunnerExercised: true,
}));
