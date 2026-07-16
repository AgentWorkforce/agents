#!/usr/bin/env node

import {
  requireAgentworkforceFlags,
  runAgentworkforce,
} from './agentworkforce-cli.mjs';

const slackChannel = process.env.SLACK_CHANNEL ?? 'C123';
const extraArgs = process.argv.slice(2);

try {
  requireAgentworkforceFlags('invoke', ['invoke'], ['--schedule', '--reads', '--model']);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

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
  `SLACK_CHANNEL=${slackChannel}`,
  ...extraArgs,
]);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status);
