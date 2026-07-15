import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
export const agentworkforceBin = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'agentworkforce.cmd' : 'agentworkforce',
);

export function isAgentworkforceInstalled() {
  return existsSync(agentworkforceBin);
}

export function runAgentworkforce(args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    input,
    timeoutMs,
  } = options;

  if (!isAgentworkforceInstalled()) {
    return {
      ok: false,
      status: 1,
      stdout: '',
      stderr: `Missing ${agentworkforceBin}. Run npm install --ignore-scripts first.`,
      command: formatCommand(args),
    };
  }

  const result = spawnSync(agentworkforceBin, args, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
  });

  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    command: formatCommand(args),
    error: result.error,
  };
}

export function runAgentworkforceAsync(args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    input,
  } = options;

  if (!isAgentworkforceInstalled()) {
    return Promise.resolve({
      ok: false,
      status: 1,
      stdout: '',
      stderr: `Missing ${agentworkforceBin}. Run npm install --ignore-scripts first.`,
      command: formatCommand(args),
    });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(agentworkforceBin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    if (input !== undefined) {
      child.stdin.end(input);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (status) => {
      resolvePromise({
        ok: status === 0,
        status: status ?? 1,
        stdout,
        stderr,
        command: formatCommand(args),
      });
    });
  });
}

export function readAgentworkforceHelp(args) {
  return runAgentworkforce([...args, '--help']);
}

export function findMissingFlags(helpText, requiredFlags) {
  return requiredFlags.filter((flag) => !helpText.includes(flag));
}

export function checkAgentworkforceFlags(args, requiredFlags) {
  const help = readAgentworkforceHelp(args);
  const text = `${help.stdout}\n${help.stderr}`;
  return {
    ...help,
    text,
    missingFlags: help.ok ? findMissingFlags(text, requiredFlags) : [...requiredFlags],
  };
}

export function formatMissingFlagsMessage(commandLabel, requiredFlags, helpText = '') {
  const missingFlags = findMissingFlags(helpText, requiredFlags);
  const missing = missingFlags.length > 0 ? missingFlags : requiredFlags;
  return [
    `agentworkforce ${commandLabel} is missing required closure flags: ${missing.join(', ')}`,
    'This repo now routes HN preview/cases through the platform invoke path only.',
    'Install a Workforce CLI artifact that implements the composable-runtime closure surface, then retry.',
  ].join('\n');
}

export function requireAgentworkforceFlags(commandLabel, args, requiredFlags) {
  const check = checkAgentworkforceFlags(args, requiredFlags);
  if (!check.ok) {
    throw new Error(check.stderr || `Unable to read help for agentworkforce ${commandLabel}`);
  }
  if (check.missingFlags.length > 0) {
    throw new Error(formatMissingFlagsMessage(commandLabel, requiredFlags, check.text));
  }
  return check;
}

export function formatCommand(args) {
  return [agentworkforceBin, ...args].join(' ');
}
