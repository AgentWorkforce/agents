import assert from 'node:assert/strict';
import test from 'node:test';

import { postFreshStories } from '../.test-build/hn-monitor/agent.js';

test('postFreshStories claims fresh story ids before summarizing', async () => {
  const events = [];
  const saved = [];
  const ctx = {
    memory: {
      async save(content, opts) {
        events.push('save');
        saved.push({ content, opts });
      },
    },
    llm: {
      async complete() {
        events.push('llm');
        throw new Error('summary failed');
      },
    },
  };

  await assert.rejects(
    postFreshStories(ctx, 'C123', [10], [
      { id: 20, title: 'Agent Workforce cron leases', url: 'https://example.com/20', points: 42 },
    ]),
    /summary failed/,
  );

  assert.deepEqual(events, ['save', 'llm']);
  assert.deepEqual(saved, [{
    content: JSON.stringify([10, 20]),
    opts: { tags: ['hn-monitor:seen'], scope: 'workspace' },
  }]);
});
