import { fileURLToPath } from 'node:url';
import { workflow } from '@agent-relay/sdk/workflows';

const WORKFLOW_NAME = 'linear-chat-lead';
const REPO_DIR = './repo';
const CREATE_PR_ARGS_PATH = `/tmp/${WORKFLOW_NAME}-open-pr.args.json`;
const CREATE_PR_SCRIPT_PATH = fileURLToPath(new URL('./linear-create-pr.cjs', import.meta.url));

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
  repoOwner: string;
  repoName: string;
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
      `printf %s ${shellArg(JSON.stringify(args.openPrArgs, null, 2))} > ${shellArg(CREATE_PR_ARGS_PATH)}`,
      `node ${shellArg(CREATE_PR_SCRIPT_PATH)} ${shellArg(CREATE_PR_ARGS_PATH)}`,
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
    repoOwner: readRequiredString(parsed, 'repoOwner'),
    repoName: readRequiredString(parsed, 'repoName'),
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
