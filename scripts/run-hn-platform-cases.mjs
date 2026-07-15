#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  requireAgentworkforceFlags,
  runAgentworkforce,
} from './agentworkforce-cli.mjs';

const casesDir = resolve('hn-monitor/cases');
const caseFiles = readdirSync(casesDir)
  .filter((name) => name.endsWith('.case.yaml'))
  .sort();

try {
  requireAgentworkforceFlags('invoke', ['invoke'], ['--case']);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (caseFiles.length === 0) {
  console.error(`No HN case files found under ${casesDir}`);
  process.exit(1);
}

for (const file of caseFiles) {
  const casePath = `./hn-monitor/cases/${file}`;
  console.error(`\n=== ${file} ===`);
  const result = runAgentworkforce([
    'invoke',
    './hn-monitor/agent.ts',
    '--case',
    casePath,
  ]);

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`\nCase failed: ${casePath}`);
    process.exit(result.status);
  }
}
