import { randomUUID } from 'node:crypto';
import { workflow } from '@agent-relay/sdk/workflows';

const WORKFLOW_NAME = 'linear-chat-lead';
const REPO_DIR = './repo';
const createPrScriptPath = `/tmp/${WORKFLOW_NAME}-create-pr-${randomUUID()}.cjs`;
const createPrArgsPath = `/tmp/${WORKFLOW_NAME}-open-pr-${randomUUID()}.args.json`;
// ctx.workflow.run uploads this workflow source by itself, so the PR helper
// has to be materialized from the workflow rather than read from a sibling file.
const CREATE_PR_SCRIPT_SOURCE = `
(async () => {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');

  const argsPath = process.argv[2];
  if (!argsPath) throw new Error('open-pr args path is required');
  const args = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
  const repoDir = readRequiredString(args, 'repoDir');
  const owner = readRequiredString(args, 'owner');
  const repo = readRequiredString(args, 'repo');
  const branch = readRequiredString(args, 'branch');
  const title = readRequiredString(args, 'title');
  const body = readRequiredString(args, 'body');

  const cloudApiUrl = readCredentialUrl('CLOUD_API_URL');
  const pullRequestAuthToken = readCredential('WORKFORCE_WORKSPACE_TOKEN') || readCredential('CLOUD_API_ACCESS_TOKEN');
  if (!cloudApiUrl) throw new Error('CLOUD_API_URL is required to open a PR');
  if (!pullRequestAuthToken) throw new Error('WORKFORCE_WORKSPACE_TOKEN or CLOUD_API_ACCESS_TOKEN is required to open a PR');

  const baseSha = readBaseSha();
  const baseBranch = readBaseBranch();

  function readRequiredString(record, key) {
    const value = record && record[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('open-pr args.' + key + ' must be a non-empty string');
    }
    return value;
  }

  function readCredential(name) {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function readCredentialUrl(name) {
    return readCredential(name).replace(/\\/+$/, '');
  }

  function gitLines(args) {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).split('\\n').filter(Boolean);
  }

  function gitLinesOrEmpty(args) {
    try {
      return gitLines(args);
    } catch {
      return [];
    }
  }

  function readBaseSha() {
    const marker = path.join(repoDir, '.linear-chat-base-sha');
    if (fs.existsSync(marker)) {
      const value = fs.readFileSync(marker, 'utf8').trim();
      if (value) return value;
    }
    return gitLines(['rev-parse', 'HEAD'])[0];
  }

  function readBaseBranch() {
    const remoteHead = gitLinesOrEmpty(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])[0] || '';
    const remoteHeadMatch = remoteHead.match(/^origin\\/(.+)$/);
    if (remoteHeadMatch) return remoteHeadMatch[1];
    const branchAtBase = gitLinesOrEmpty(['branch', '-r', '--points-at', baseSha])
      .map((line) => line.trim())
      .find((line) => line.startsWith('origin/') && line !== 'origin/HEAD');
    if (branchAtBase) return branchAtBase.replace(/^origin\\//, '');
    return 'main';
  }

  function collectDiffPaths() {
    const committedRange = baseSha + '..HEAD';
    const changed = Array.from(new Set([
      ...gitLines(['diff', '--name-only', '--diff-filter=ACMRT', committedRange]),
      ...gitLines(['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD']),
      ...gitLines(['ls-files', '--others', '--exclude-standard']),
    ])).filter((filePath) => filePath !== '.linear-chat-base-sha');
    const deleted = Array.from(new Set([
      ...gitLines(['diff', '--name-only', '--diff-filter=D', committedRange]),
      ...gitLines(['diff', '--name-only', '--diff-filter=D', 'HEAD']),
    ])).filter((filePath) => !changed.includes(filePath));
    return { changed, deleted };
  }

  const { changed, deleted } = collectDiffPaths();
  const absoluteRepoDir = path.resolve(repoDir);
  const files = [];
  for (const filePath of changed) {
    if (filePath.startsWith('.git/')) continue;
    const absolutePath = path.resolve(absoluteRepoDir, filePath);
    if (!isPathInside(absolutePath, absoluteRepoDir)) {
      throw new Error('Refusing to read changed file outside repo: ' + filePath);
    }
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error('Refusing to read symbolic link in PR payload: ' + filePath);
    }
    files.push({
      path: filePath,
      content: fs.readFileSync(absolutePath).toString('base64'),
      encoding: 'base64',
    });
  }
  for (const filePath of deleted) {
    files.push({ path: filePath, deleted: true });
  }
  if (files.length === 0) throw new Error('No file changes to publish');

  const response = await fetch(cloudApiUrl + '/api/v1/github/pull-request', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + pullRequestAuthToken, 'content-type': 'application/json' },
    body: JSON.stringify({ owner, repo, branch, baseSha, baseBranch, title, body, files }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.prUrl) {
    throw new Error('Proxy PR create failed: ' + response.status + ' ' + JSON.stringify(payload));
  }
  console.log(payload.prUrl);
  console.log(branch);

  function isPathInside(child, parent) {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

type OpenPrArgs = {
  repoDir: string;
  owner: string;
  repo: string;
  branch: string;
  title: string;
  body: string;
};

type ImplementWorkflowArgs = {
  repo: string;
  branch: string;
  issueTitle: string;
  issueBody: string;
  userPrompt: string;
  issueId?: string;
  issueIdentifier?: string;
  issueUrl?: string;
  openPrArgs: OpenPrArgs;
};

const args = readInvocationArgs();

await workflow(WORKFLOW_NAME)
  .description('Implement a Linear issue delegated by the chat lead')
  .pattern('dag')
  .timeout(4_500_000)
  .agent('impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement the Linear issue and prepare a PR.',
    retries: 1,
    maxTokens: 32000,
  })
  .step('clone', {
    type: 'deterministic',
    command: [
      'set -e',
      `rm -rf ${shellArg(REPO_DIR)}`,
      `git clone --filter=blob:none ${shellArg(`https://github.com/${args.repo}.git`)} ${shellArg(REPO_DIR)}`,
      `cd ${shellArg(REPO_DIR)} && git checkout -B ${shellArg(args.branch)}`,
      `cd ${shellArg(REPO_DIR)} && git config user.email ${shellArg('linear-chat-lead@agentworkforce.local')}`,
      `cd ${shellArg(REPO_DIR)} && git config user.name ${shellArg('linear-chat-lead')}`,
      `cd ${shellArg(REPO_DIR)} && git rev-parse HEAD > .linear-chat-base-sha`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 900000,
  })
  .step('implement', {
    agent: 'impl',
    dependsOn: ['clone'],
    task: [
      `Work in ${REPO_DIR} on branch ${args.branch}.`,
      `Linear issue: ${args.issueIdentifier ? `${args.issueIdentifier}: ` : ''}${args.issueTitle}`,
      args.issueUrl ? `Issue URL: ${args.issueUrl}` : '',
      `User prompt: ${args.userPrompt || '(no explicit prompt)'}`,
      `Issue body:\n${args.issueBody}`,
      'Make the code changes needed to fully satisfy the Linear request.',
      'Do not commit, push, or open a PR; the final deterministic step handles that.',
    ].filter(Boolean).join('\n\n'),
    verification: { type: 'exit_code', value: '0' },
    timeoutMs: 1_800_000,
    retries: 1,
  })
  .step('open-pr', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: [
      'set -e',
      `script_path=${shellArg(createPrScriptPath)}`,
      `args_path=${shellArg(createPrArgsPath)}`,
      'trap \'rm -f "$args_path" "$script_path"\' EXIT',
      `printf %s ${shellArg(CREATE_PR_SCRIPT_SOURCE)} > "$script_path"`,
      `printf %s ${shellArg(JSON.stringify(args.openPrArgs, null, 2))} > "$args_path"`,
      'node "$script_path" "$args_path"',
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 300000,
  })
  .run();

function readInvocationArgs(): ImplementWorkflowArgs {
  const raw = process.env.invocationArgs ?? '{}';
  const parsed = parseJsonObject(raw, 'invocationArgs');
  const openPrArgs = readObject(parsed.openPrArgs, 'openPrArgs');
  return {
    repo: readRequiredString(parsed, 'repo'),
    branch: readRequiredString(parsed, 'branch'),
    issueTitle: readRequiredString(parsed, 'issueTitle'),
    issueBody: readString(parsed.issueBody),
    userPrompt: readString(parsed.userPrompt),
    issueId: readOptionalString(parsed.issueId),
    issueIdentifier: readOptionalString(parsed.issueIdentifier),
    issueUrl: readOptionalString(parsed.issueUrl),
    openPrArgs: {
      repoDir: readRequiredString(openPrArgs, 'repoDir'),
      owner: readRequiredString(openPrArgs, 'owner'),
      repo: readRequiredString(openPrArgs, 'repo'),
      branch: readRequiredString(openPrArgs, 'branch'),
      title: readRequiredString(openPrArgs, 'title'),
      body: readRequiredString(openPrArgs, 'body'),
    },
  };
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  return readObject(parsed, label);
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`invocationArgs.${key} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
