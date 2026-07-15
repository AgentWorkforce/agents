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
export const agentworkforceCliOverrideEnv = 'AGENTWORKFORCE_CLI_PATH';

function resolveAgentworkforceExecutable() {
  const override = process.env[agentworkforceCliOverrideEnv]?.trim();
  if (!override) {
    return {
      source: 'installed-package',
      command: agentworkforceBin,
      prefixArgs: [],
      identity: agentworkforceBin,
    };
  }

  const viaNode = /\.(?:c|m)?js$/iu.test(override);
  return {
    source: 'override',
    command: viaNode ? process.execPath : override,
    prefixArgs: viaNode ? [override] : [],
    identity: override,
  };
}

export function isAgentworkforceInstalled() {
  return existsSync(resolveAgentworkforceExecutable().identity);
}

export function getAgentworkforceInvocation(args = []) {
  const executable = resolveAgentworkforceExecutable();
  return {
    ...executable,
    argv: [...executable.prefixArgs, ...args],
  };
}

export function runAgentworkforce(args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    input,
    timeoutMs,
  } = options;
  const invocation = getAgentworkforceInvocation(args);

  if (!isAgentworkforceInstalled()) {
    return {
      ok: false,
      status: 1,
      stdout: '',
      stderr: `Missing ${invocation.identity}. Install agentworkforce locally or set ${agentworkforceCliOverrideEnv}.`,
      command: formatCommand(args),
    };
  }

  const result = spawnSync(invocation.command, invocation.argv, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const timedOut = timeoutMs !== undefined && result.error?.code === 'ETIMEDOUT';
  const stderr = timedOut
    ? `${result.stderr ?? ''}${result.stderr ? '\n' : ''}Timed out after ${timeoutMs}ms`
    : (result.stderr ?? '');

  return {
    ok: !timedOut && result.status === 0,
    status: timedOut ? 124 : (result.status ?? 1),
    stdout: result.stdout ?? '',
    stderr,
    command: formatCommand(args),
    error: result.error,
  };
}

export function runAgentworkforceAsync(args, options = {}) {
  const {
    cwd = repoRoot,
    env = {},
    input,
    timeoutMs,
  } = options;
  const invocation = getAgentworkforceInvocation(args);

  if (!isAgentworkforceInstalled()) {
    return Promise.resolve({
      ok: false,
      status: 1,
      stdout: '',
      stderr: `Missing ${invocation.identity}. Install agentworkforce locally or set ${agentworkforceCliOverrideEnv}.`,
      command: formatCommand(args),
    });
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutId;

    const resolveOnce = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolvePromise(result);
    };

    const killChild = () => {
      if (child.pid === undefined) return;
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 500).unref();
        return;
      }

      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 500).unref();
    };

    if (input !== undefined) {
      child.stdin.end(input);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      rejectPromise(error);
    });
    child.on('close', (status) => {
      if (timedOut) return;
      resolveOnce({
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
        resolveOnce({
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
  const invocation = getAgentworkforceInvocation(args);
  return [invocation.command, ...invocation.argv].join(' ');
}
