import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentworkforceBin,
  agentworkforceCliOverrideEnv,
  formatCommand,
  getAgentworkforceInvocation,
} from '../scripts/agentworkforce-cli.mjs';

test('agentworkforce helper defaults to the installed local binary', () => {
  delete process.env[agentworkforceCliOverrideEnv];
  const invocation = getAgentworkforceInvocation(['invoke', '--help']);
  assert.equal(invocation.source, 'installed-package');
  assert.equal(invocation.command, agentworkforceBin);
  assert.deepEqual(invocation.argv, ['invoke', '--help']);
});

test('agentworkforce helper accepts an explicit js artifact override', () => {
  process.env[agentworkforceCliOverrideEnv] = '/tmp/workforce-cli/dist/cli.js';
  const invocation = getAgentworkforceInvocation(['invoke', '--help']);
  assert.equal(invocation.source, 'override');
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.argv, ['/tmp/workforce-cli/dist/cli.js', 'invoke', '--help']);
  assert.equal(
    formatCommand(['invoke', '--help']),
    `${process.execPath} /tmp/workforce-cli/dist/cli.js invoke --help`,
  );
  delete process.env[agentworkforceCliOverrideEnv];
});

test('agentworkforce helper accepts an explicit binary override', () => {
  process.env[agentworkforceCliOverrideEnv] = '/tmp/workforce-cli/bin/agentworkforce';
  const invocation = getAgentworkforceInvocation(['runs', 'export', '--help']);
  assert.equal(invocation.source, 'override');
  assert.equal(invocation.command, '/tmp/workforce-cli/bin/agentworkforce');
  assert.deepEqual(invocation.argv, ['runs', 'export', '--help']);
  delete process.env[agentworkforceCliOverrideEnv];
});
