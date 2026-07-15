import path from 'node:path';
import {
  CloudApiClient,
  clearStoredAuth,
  defaultApiUrl,
  ensureAuthenticated,
  type StoredAuth
} from '@agent-relay/cloud';
import {
  canonicalizeCloudUrl,
  clearActiveWorkspace,
  clearStoredWorkspaceToken,
  createTerminalIO,
  deploy,
  writeActiveWorkspace,
  type CloudAuthRecoveryResolver,
  type DeployMode,
  type DeployOptions,
  type ModeLaunchHandle
} from '@agentworkforce/deploy';


type LoginApiClient = Pick<CloudApiClient, 'fetch'>;

type DeployCommandDeps = {
  ensureAuthenticated: typeof ensureAuthenticated;
  clearStoredAuth: typeof clearStoredAuth;
  clearStoredWorkspaceToken: typeof clearStoredWorkspaceToken;
  clearActiveWorkspace: typeof clearActiveWorkspace;
  writeActiveWorkspace: typeof writeActiveWorkspace;
  createTerminalIO: typeof createTerminalIO;
  createCloudApiClient(auth: StoredAuth, apiUrl: string): LoginApiClient;
};

const defaultDeployCommandDeps: DeployCommandDeps = {
  ensureAuthenticated,
  clearStoredAuth,
  clearStoredWorkspaceToken,
  clearActiveWorkspace,
  writeActiveWorkspace,
  createTerminalIO,
  createCloudApiClient(auth, apiUrl) {
    return new CloudApiClient({
      apiUrl,
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      accessTokenExpiresAt: auth.accessTokenExpiresAt
    });
  }
};

let deployCommandDeps = defaultDeployCommandDeps;

export function configureDeployCommandForTest(overrides: Partial<DeployCommandDeps>): () => void {
  const previous = deployCommandDeps;
  deployCommandDeps = { ...deployCommandDeps, ...overrides };
  return () => {
    deployCommandDeps = previous;
  };
}

/**
 * Argv parser + dispatcher for `agentworkforce deploy <persona-path> [flags]`.
 * Keeps cli.ts itself slim — the file is already a large dispatcher and
 * each command lands in its own module when it grows past trivial.
 */
export async function runDeploy(args: readonly string[]): Promise<void> {
  if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(DEPLOY_USAGE);
    process.exit(args.length === 0 ? 1 : 0);
  }

  let parsed = parseDeployArgs(args);
  if (!parsed.mode) {
    parsed = { ...parsed, mode: 'cloud' };
  }

  try {
    const result = await deploy(parsed, {
      authRecovery: createDeployAuthRecovery(parsed)
    });
    if (parsed.dryRun) {
      process.stdout.write(`\nok: ${result.deploymentId} (dry-run)\n`);
      process.exit(0);
    }
    if (parsed.bundleOut) {
      process.stdout.write(`\nbundle: ${result.bundleDir}\n`);
      process.exit(0);
    }
    process.stdout.write(
      `\nok: ${result.deploymentId} (mode=${result.mode}, workspace=${result.workspace})\n`
    );

    // `--detach` returns immediately; otherwise the CLI blocks on the
    // runner's `done` promise so logs keep streaming in the foreground
    // and Ctrl-C tears the runner down cleanly.
    if (parsed.detach || !isRunHandle(result.runHandle)) {
      process.exit(0);
    }
    const exit = await result.runHandle.done;
    process.exit(exit.code);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce deploy failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

function createDeployAuthRecovery(opts: DeployOptions): CloudAuthRecoveryResolver {
  return {
    async recover({ workspace, cloudUrl, io, reason }) {
      const ok = await io.confirm(
        'Cloud login is required before deploy can check integrations. Log in now? (opens browser)',
        { defaultValue: true }
      );
      if (!ok) return false;

      io.info(`cloud: starting login because integration auth failed (${reason})`);
      const auth = await deployCommandDeps.ensureAuthenticated(cloudUrl, { force: true });
      const apiUrl = normalizeCloudUrl(auth.apiUrl || cloudUrl);
      const activeWorkspace = opts.workspace ?? workspace;
      await deployCommandDeps.writeActiveWorkspace({
        workspace: activeWorkspace,
        cloudUrl: apiUrl
      });
      io.info(`cloud: logged in for workspace ${activeWorkspace}; retrying integration check`);
      return {
        token: auth.accessToken
      };
    }
  };
}

function isRunHandle(value: unknown): value is ModeLaunchHandle {
  if (typeof value !== 'object' || value === null || !('done' in value)) {
    return false;
  }
  const done = (value as { done?: unknown }).done;
  return typeof done === 'object' && done !== null && typeof (done as { then?: unknown }).then === 'function';
}

export async function runLogin(args: readonly string[]): Promise<void> {
  if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(LOGIN_USAGE);
    process.exit(0);
  }

  const opts = parseLoginArgs(args);
  const io = deployCommandDeps.createTerminalIO();
  const cloudUrl = canonicalizeCloudUrl(normalizeCloudUrl(
    opts.cloudUrl ?? process.env.WORKFORCE_DEPLOY_CLOUD_URL ?? process.env.WORKFORCE_CLOUD_URL ?? defaultApiUrl()
  ));

  try {
    const auth = await deployCommandDeps.ensureAuthenticated(cloudUrl);
    // Canonicalize what ensureAuthenticated handed back — when the auth
    // request happens to route through cloud's edge-bypass hostname,
    // auth.apiUrl can be `https://origin.agentrelay.cloud` even though
    // the user's session cookies are scoped to `agentrelay.com`. Storing
    // that URL is what causes every subsequent API call to 401.
    const apiUrl = canonicalizeCloudUrl(normalizeCloudUrl(auth.apiUrl || cloudUrl));
    let workspaces: LoginWorkspace[] = [];
    let chosen: string;
    if (opts.workspace) {
      chosen = opts.workspace;
    } else {
      workspaces = await listWorkspacesForLogin(auth, apiUrl);
      if (workspaces.length === 0) {
        throw new Error(
          'no workspaces are accessible from this account. Create one at https://agentrelay.com/cloud, '
            + 'or pass --workspace <id-or-slug> if you already know the workspace identifier.'
        );
      }
      chosen = await pickWorkspaceInteractive(workspaces, io);
    }
    // No workspace-scoped token mint — cloud's resolveRequestAuth accepts
    // the shared @agent-relay/cloud accessToken as Bearer directly. We just
    // persist a pointer recording which workspace the user picked so
    // resolveWorkspaceToken can pair it with the shared accessToken on
    // each subsequent deploy call.
    const match = findWorkspace(workspaces, chosen);
    await deployCommandDeps.writeActiveWorkspace({
      workspace: chosen,
      ...(match?.slug ? { workspaceSlug: match.slug } : {}),
      ...(match?.id ? { workspaceId: match.id } : {}),
      cloudUrl: apiUrl
    });
    process.stdout.write(`\nlogged in: ${chosen}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce login failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

export async function runLogout(args: readonly string[]): Promise<void> {
  if (args.length > 0 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(LOGOUT_USAGE);
    process.exit(0);
  }
  const opts = parseLogoutArgs(args);
  try {
    if (opts.cloudAuth) {
      await deployCommandDeps.clearStoredAuth();
    }
    // Always drop the active-workspace pointer — `agentworkforce logout`
    // should detach this machine from any workspace regardless of whether
    // the user also wants to nuke the shared cloud login.
    await deployCommandDeps.clearActiveWorkspace();
    // Legacy keychain workspace token is also cleared so users mid-upgrade
    // don't end up with a stale minted token after logout.
    await deployCommandDeps.clearStoredWorkspaceToken(opts.workspace);
    process.stdout.write(opts.cloudAuth ? 'logged out\n' : 'workspace login cleared\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `\nagentworkforce logout failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

const DEPLOY_USAGE = `usage: agentworkforce deploy <persona-path> [flags]

Flags:
  --mode dev|sandbox|cloud    Pick a run mode (prompts in an interactive terminal)
  --workspace <name>           Workforce workspace; defaults to the active workspace
  --no-connect                 Skip integration-connect prompts; fail if any are missing
  --reconnect <provider>       Force a fresh integration connect flow (repeatable)
  --byo-sandbox                Force BYO Daytona auth even when logged in
  --detach                     Background the runner instead of streaming logs
  --bundle-out <dir>           Emit the bundle to <dir> and exit (no launch)
  --dry-run                    Validate the persona and exit before any side effects
  --cloud-url <url>            Override the workforce cloud base URL
  --no-prompt                  Fail instead of prompting for cloud setup
  --harness-source <source>    Cloud harness source: plan, byok, or oauth
  --byok-key <key>             API key for --harness-source byok
  --on-exists <choice>         Existing cloud persona behavior: cancel, update, or destroy
  --input <key>=<value>        Override a declared persona input (repeatable)
  -h, --help                   Print this message
`;

const LOGIN_USAGE = `usage: agentworkforce login [flags]

Connect this machine to a workforce workspace. Opens the browser to sign in
to the workforce cloud and stores a small pointer at
\`~/.agentworkforce/active.json\` recording which workspace this machine targets.

Flags:
  --workspace <name>          Workforce workspace; defaults to WORKFORCE_WORKSPACE_ID or prompt
  --cloud-url <url>           Override the workforce cloud base URL
  When --workspace is set, the CLI skips listing workspaces — useful when your
  account hits 403 on /api/v1/workspaces but you already know the workspace id.
  -h, --help                  Print this message
`;

const LOGOUT_USAGE = `usage: agentworkforce logout [flags]

Clear the stored workforce workspace pointer. The shared cloud browser auth
is preserved unless --cloud-auth is passed.

Flags:
  --workspace <name>          Optional workspace token entry to clear
  --cloud-auth                Also clear the shared cloud login
  --all                       Alias for --cloud-auth
  -h, --help                  Print this message
`;

const HARNESS_SOURCES = ['plan', 'byok', 'oauth'] as const;
const ON_EXISTS_CHOICES = ['update', 'destroy', 'cancel'] as const;

export function parseDeployArgs(args: readonly string[]): DeployOptions {
  let personaPath: string | undefined;
  let mode: DeployMode | undefined;
  let workspace: string | undefined;
  let noConnect = false;
  let byoSandbox = false;
  let detach = false;
  let bundleOut: string | undefined;
  let dryRun = false;
  let cloudUrl: string | undefined;
  let noPrompt = false;
  let harnessSource: DeployOptions['harnessSource'];
  let byokKey: string | undefined;
  let onExists: DeployOptions['onExists'];
  const inputs: Record<string, string> = {};
  const reconnectProviders: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(DEPLOY_USAGE);
      process.exit(0);
    } else if (a === '--mode') {
      const v = args[++i];
      if (v !== 'dev' && v !== 'sandbox' && v !== 'cloud') {
        die(`--mode: expected one of dev|sandbox|cloud; got "${v ?? ''}"`);
      }
      mode = v;
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (a === '--no-connect') {
      noConnect = true;
    } else if (a === '--reconnect') {
      reconnectProviders.push(...parseProviderList(expectValue('--reconnect', args[++i])));
    } else if (a.startsWith('--reconnect=')) {
      reconnectProviders.push(...parseProviderList(expectInlineValue('--reconnect', a.slice('--reconnect='.length))));
    } else if (a === '--byo-sandbox') {
      byoSandbox = true;
    } else if (a === '--detach') {
      detach = true;
    } else if (a === '--bundle-out') {
      bundleOut = expectValue('--bundle-out', args[++i]);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (a.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', a.slice('--cloud-url='.length));
    } else if (a === '--no-prompt') {
      noPrompt = true;
      noConnect = true;
    } else if (a === '--harness-source') {
      harnessSource = expectChoice('--harness-source', expectValue('--harness-source', args[++i]), HARNESS_SOURCES);
    } else if (a.startsWith('--harness-source=')) {
      harnessSource = expectChoice('--harness-source', expectInlineValue('--harness-source', a.slice('--harness-source='.length)), HARNESS_SOURCES);
    } else if (a === '--byok-key') {
      byokKey = expectValue('--byok-key', args[++i]);
    } else if (a.startsWith('--byok-key=')) {
      byokKey = expectInlineValue('--byok-key', a.slice('--byok-key='.length));
    } else if (a === '--on-exists') {
      onExists = expectChoice('--on-exists', expectValue('--on-exists', args[++i]), ON_EXISTS_CHOICES);
    } else if (a.startsWith('--on-exists=')) {
      onExists = expectChoice('--on-exists', expectInlineValue('--on-exists', a.slice('--on-exists='.length)), ON_EXISTS_CHOICES);
    } else if (a === '--input') {
      parseDeployInputValue(expectDeployInputValue(args[++i]), inputs);
    } else if (a.startsWith('--input=')) {
      parseDeployInputValue(a.slice('--input='.length), inputs);
    } else if (a.startsWith('--')) {
      die(`deploy: unknown flag "${a}"`);
    } else if (!personaPath) {
      personaPath = path.resolve(a);
    } else {
      die(`deploy: unexpected positional argument "${a}"`);
    }
  }

  if (!personaPath) {
    die('deploy: missing persona path. Usage: agentworkforce deploy <persona-path>');
  }

  return {
    personaPath,
    ...(mode ? { mode } : {}),
    ...(workspace ? { workspace } : {}),
    ...(noConnect ? { noConnect: true } : {}),
    ...(byoSandbox ? { byoSandbox: true } : {}),
    ...(detach ? { detach: true } : {}),
    ...(bundleOut ? { bundleOut } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...(cloudUrl ? { cloudUrl } : {}),
    ...(noPrompt ? { noPrompt: true } : {}),
    ...(reconnectProviders.length > 0 ? { reconnectProviders: [...new Set(reconnectProviders)] } : {}),
    ...(harnessSource ? { harnessSource } : {}),
    ...(byokKey ? { byokKey } : {}),
    ...(onExists ? { onExists } : {}),
    ...(Object.keys(inputs).length > 0 ? { inputs } : {})
  };
}

function parseProviderList(value: string): string[] {
  const providers = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (providers.length === 0) {
    die('--reconnect: expected <provider>');
  }
  return providers;
}

function expectDeployInputValue(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    die('--input: expected <key>=<value>');
  }
  return value;
}

function parseDeployInputValue(raw: string, inputs: Record<string, string>): void {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    die(`--input: expected <key>=<value>; got "${raw}"`);
  }
  const key = raw.slice(0, eq);
  inputs[key] = raw.slice(eq + 1);
}

function expectValue(flag: string, value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    die(`${flag}: missing value`);
  }
  // Reject the next token if it looks like a flag — `--workspace --detach`
  // should fail loudly rather than silently treating `--detach` as the
  // workspace name.
  if (value.startsWith('-')) {
    die(`${flag}: missing value (got "${value}", which looks like a flag)`);
  }
  return value;
}

function expectInlineValue(flag: string, value: string): string {
  if (!value.trim()) {
    die(`${flag}: missing value`);
  }
  return value;
}

function expectChoice<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    die(`${flag}: expected one of ${allowed.join('|')}; got "${value}"`);
  }
  return value as T;
}

function parseLoginArgs(args: readonly string[]): { workspace?: string; cloudUrl?: string } {
  let workspace: string | undefined;
  let cloudUrl: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(LOGIN_USAGE);
      process.exit(0);
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (a.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', a.slice('--workspace='.length));
    } else if (a === '--cloud-url') {
      cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (a.startsWith('--cloud-url=')) {
      cloudUrl = expectInlineValue('--cloud-url', a.slice('--cloud-url='.length));
    } else {
      die(`login: unknown argument "${a}"`);
    }
  }

  return {
    ...(workspace ? { workspace } : {}),
    ...(cloudUrl ? { cloudUrl } : {})
  };
}

function parseLogoutArgs(args: readonly string[]): { workspace?: string; cloudAuth?: boolean } {
  let workspace: string | undefined;
  let cloudAuth = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(LOGOUT_USAGE);
      process.exit(0);
    } else if (a === '--workspace') {
      workspace = expectValue('--workspace', args[++i]);
    } else if (a.startsWith('--workspace=')) {
      workspace = expectInlineValue('--workspace', a.slice('--workspace='.length));
    } else if (a === '--cloud-auth' || a === '--all') {
      cloudAuth = true;
    } else {
      die(`logout: unknown argument "${a}"`);
    }
  }
  return {
    ...(workspace ? { workspace } : {}),
    ...(cloudAuth ? { cloudAuth } : {})
  };
}

type LoginWorkspace = {
  id: string;
  slug?: string;
  name?: string;
};

async function listWorkspacesForLogin(auth: StoredAuth, apiUrl: string): Promise<LoginWorkspace[]> {
  const client = deployCommandDeps.createCloudApiClient(auth, apiUrl);
  const res = await client.fetch('/api/v1/workspaces');
  if (res.ok) {
    return parseWorkspaceList(await res.json().catch(() => null));
  }
  if (res.status === 403) {
    throw new Error(
      'workspace list returned 403 Forbidden. Pass --workspace <id-or-slug> to skip listing, '
        + 'or check that your account has access to a workspace at https://agentrelay.com/cloud.'
    );
  }
  if (res.status !== 404 && res.status !== 405) {
    throw new Error(`workspace list failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
  }

  const who = await client.fetch('/api/v1/auth/whoami');
  if (!who.ok) return [];
  return parseWorkspaceList(await who.json().catch(() => null));
}

async function pickWorkspaceInteractive(
  workspaces: readonly LoginWorkspace[],
  io: ReturnType<typeof createTerminalIO>
): Promise<string> {
  if (workspaces.length === 1) {
    return workspaceKey(workspaces[0]);
  }
  if (workspaces.length > 1) {
    for (let i = 0; i < workspaces.length; i += 1) {
      const ws = workspaces[i];
      io.info(`[${i + 1}] ${workspaceKey(ws)}${ws.name ? ` (${ws.name})` : ''}`);
    }
    const answer = await io.prompt('Workspace', { defaultValue: '1' });
    const index = Number(answer.trim());
    if (Number.isInteger(index) && index >= 1 && index <= workspaces.length) {
      return workspaceKey(workspaces[index - 1]);
    }
    const found = findWorkspace(workspaces, answer.trim());
    if (found) return workspaceKey(found);
    throw new Error(`unknown workspace "${answer}"`);
  }
  const answer = await io.prompt('Workspace');
  if (!answer.trim()) {
    throw new Error('workspace is required');
  }
  return answer.trim();
}

function parseWorkspaceList(payload: unknown): LoginWorkspace[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { workspaces?: unknown }).workspaces)
      ? (payload as { workspaces: unknown[] }).workspaces
      : payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
        ? (payload as { items: unknown[] }).items
        : payload && typeof payload === 'object' && (payload as { currentWorkspace?: unknown }).currentWorkspace
          ? [(payload as { currentWorkspace: unknown }).currentWorkspace]
          : [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const id = readString(record, 'id') ?? readString(record, 'workspaceId');
    if (!id) return [];
    return [{
      id,
      ...(readString(record, 'slug') ? { slug: readString(record, 'slug') } : {}),
      ...(readString(record, 'name') ? { name: readString(record, 'name') } : {})
    }];
  });
}

function findWorkspace(workspaces: readonly LoginWorkspace[], value: string): LoginWorkspace | undefined {
  return workspaces.find((workspace) => [workspace.id, workspace.slug, workspace.name].includes(value));
}

function workspaceKey(workspace: LoginWorkspace): string {
  return workspace.slug ?? workspace.id;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeCloudUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : defaultApiUrl().replace(/\/+$/, '');
}

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
