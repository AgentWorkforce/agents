#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundleDir = process.argv[2];
if (!bundleDir) throw new Error('usage: hn-relayflow-bundle-smoke.mjs <bundle-dir>');

const bundle = await import(pathToFileURL(path.resolve(bundleDir, 'agent.bundle.mjs')).href);
const saved = [];
const files = new Map();
const posts = [];
let workflowCall;

const ctx = {
  log() {},
  persona: {
    inputs: { SLACK_CHANNEL: 'C123' },
    inputSpecs: { SLACK_CHANNEL: { env: 'SLACK_CHANNEL', optional: true } },
  },
  memory: {
    async save(content, opts) { saved.push({ content, opts }); },
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

const delivery = {
  targets: ['slack'],
  async publish(text) { return this.send(text, { nonBlocking: true }); },
  async send(text, options) {
    const ref = {
      provider: 'slack',
      channel: 'C123',
      ts: options?.nonBlocking ? '' : `1.${posts.length + 1}`,
      draftRef: `ref-${posts.length + 1}`,
    };
    posts.push({ text, options });
    return { ok: true, refs: [ref] };
  },
};

await bundle.postFreshStories(ctx, delivery, [], [{
  id: 20,
  title: 'Show HN: Durable agent workflow journals',
  url: 'https://example.com/agent-workflows',
  points: 120,
  comments: 42,
  feeds: ['show_hn'],
  category: 'agent orchestration',
}]);

assert.equal(workflowCall?.name, 'hn-monitor-scheduled-digest-v1');
assert.equal(workflowCall?.args.relayflowVersion, 'v1');
assert.match(workflowCall?.source ?? '', /from '@relayflows\/core'/u);
assert.doesNotMatch(workflowCall?.source ?? '', /from ['"]\.\/relayflow-v1-resume/u);
assert.equal(posts.length, 2);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:seen')).length, 1);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:post')).length, 1);
assert.equal(saved.filter((entry) => entry.opts?.tags?.includes('hn-monitor:pending-post-state')).length, 2);

console.log(JSON.stringify({
  workflow: workflowCall.name,
  version: workflowCall.args.relayflowVersion,
  sourceBytes: workflowCall.source.length,
  posts: posts.length,
  stateSaves: saved.length,
}));
