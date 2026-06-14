/**
 * daytona-auth — an always-valid, auto-refreshing Daytona (Auth0) access token.
 *
 * Option B: the user runs `daytona login` ONCE (browser OAuth). After that we
 * stay authenticated indefinitely by silently refreshing the Auth0 access token
 * with the stored refresh token — no further human interaction.
 *
 * This is a faithful, dependency-free re-implementation of what the official
 * `daytona` CLI does in Go (apps/cli/auth/auth.go::RefreshTokenIfNeeded):
 *   - reads ~/<config>/daytona/config.json (the CLI's own token store),
 *   - if the cached JWT is within 5 minutes of expiry, exchanges the stored
 *     refresh token at the Auth0 token endpoint,
 *   - persists the (rotated) refresh token + new access token back to the file,
 *   - returns a fresh access token.
 *
 * THE CRACK: a naive Auth0 refresh returns `401 access_denied` because Daytona's
 * Auth0 application is a *confidential* client — the refresh call MUST include
 * `client_secret`. The CLI bakes that secret into its release binary via
 * -ldflags (apps/cli/hack/build.sh); it ships in the public Homebrew build and
 * is reproduced here as a default. Every value is overridable by the same env
 * vars the CLI honors, so nothing is hard-locked.
 *
 * The exact working refresh call (Auth0 `client_secret_post`):
 *   POST https://daytonaio.us.auth0.com/oauth/token
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=refresh_token
 *   client_id=<Auth0ClientId>
 *   client_secret=<Auth0ClientSecret>
 *   refresh_token=<stored refresh token>
 *   (NB: do NOT resend `audience` or `scope` on refresh — only initial login does.)
 *
 * Self-contained on purpose: only Node built-ins, so it lifts cleanly into
 * nightcto later. Public surface kept stable: `getDaytonaAccessToken(orgId?)`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Auth0 / Daytona constants (mirror the CLI's -ldflags defaults) ────────────
const AUTH0_DOMAIN = process.env.DAYTONA_AUTH0_DOMAIN || 'https://daytonaio.us.auth0.com/';
const CLIENT_ID = process.env.DAYTONA_AUTH0_CLIENT_ID || 'kOJeeyZoCe0YiTJQQOJjItqpoogxIjWw';
const CLIENT_SECRET =
  process.env.DAYTONA_AUTH0_CLIENT_SECRET ||
  'zKBl-v_YCEAg7uH6AYET39VgPLk6QhaaFESmdZs6laTZPtnennw1OpjEM8jp6ht2';

// Refresh when the cached token has <5 min of life left — matches the CLI.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
// Auth0 access tokens are ~24h; used only if the response omits `expires_in`.
const DEFAULT_EXPIRES_IN_SEC = 24 * 60 * 60;

// ── config.json shape (subset; unknown fields preserved on write) ─────────────
interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}
interface Profile {
  id: string;
  name?: string;
  api?: { url?: string; key?: string | null; token?: StoredToken | null };
  activeOrganizationId?: string | null;
  [extra: string]: unknown;
}
interface DaytonaConfig {
  activeProfile?: string;
  profiles?: Profile[];
  [extra: string]: unknown;
}

/** Injection seams — defaulted in production, overridden in tests. */
export interface AuthDeps {
  /** Path to the daytona CLI config.json. Defaults to the CLI's own location. */
  configPath?: string;
  /** fetch implementation (for offline tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Clock, in ms. Defaults to Date.now. */
  now?: () => number;
  /** Environment to read injected credentials from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface RefreshResult {
  accessToken: string;
  /** Rotated refresh token (Auth0 rotation), or the original if none returned. */
  refreshToken: string;
  expiresInSec: number;
}

/**
 * Resolve the daytona CLI config.json path, mirroring Go's `os.UserConfigDir()`
 * plus the `DAYTONA_CONFIG_DIR` override the CLI honors.
 */
export function daytonaConfigPath(): string {
  const override = process.env.DAYTONA_CONFIG_DIR;
  if (override) return path.join(override, 'config.json');
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'daytona', 'config.json');
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'daytona',
        'config.json',
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'daytona',
        'config.json',
      );
  }
}

/**
 * The ONE correct refresh call. Exchanges a refresh token for a fresh access
 * token at the Auth0 token endpoint, including the required `client_secret`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult> {
  const tokenUrl = new URL('oauth/token', AUTH0_DOMAIN).toString();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    // Surface Auth0's error verbatim (e.g. invalid_grant on a revoked/rotated
    // token) so the caller knows a fresh `daytona login` is required.
    throw new Error(`Daytona Auth0 token refresh failed (HTTP ${res.status}): ${text}`);
  }

  let json: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Daytona Auth0 token refresh returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!json.access_token) {
    throw new Error(`Daytona Auth0 token refresh returned no access_token: ${text.slice(0, 200)}`);
  }

  return {
    accessToken: json.access_token,
    // Rotation is enabled: Auth0 issues a NEW refresh token each time. If a
    // response ever omits it, keep the current one rather than dropping auth.
    refreshToken: json.refresh_token ?? refreshToken,
    expiresInSec: json.expires_in ?? DEFAULT_EXPIRES_IN_SEC,
  };
}

async function readConfig(configPath: string): Promise<DaytonaConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new Error(
      `Daytona config not found at ${configPath}. Run \`daytona login\` once to authenticate.`,
    );
  }
  try {
    return JSON.parse(raw) as DaytonaConfig;
  } catch {
    throw new Error(`Daytona config at ${configPath} is not valid JSON.`);
  }
}

function activeProfile(cfg: DaytonaConfig): Profile {
  const profiles = cfg.profiles ?? [];
  if (profiles.length === 0) {
    throw new Error('No Daytona profiles found. Run `daytona login` once to authenticate.');
  }
  const byActive = cfg.activeProfile
    ? profiles.find((p) => p.id === cfg.activeProfile)
    : undefined;
  return byActive ?? profiles[0];
}

/** Atomic write so a concurrent `daytona` CLI never sees a half-written file. */
async function writeConfig(configPath: string, cfg: DaytonaConfig): Promise<void> {
  const tmp = `${configPath}.${process.pid}.tmp`;
  // Go's json.MarshalIndent uses 2-space indent and no trailing newline.
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.rename(tmp, configPath);
}

// Serialize refreshes within a process so concurrent ticks don't double-spend
// (and double-rotate) the refresh token.
let inFlight: Promise<string> | null = null;

async function resolve(deps: AuthDeps): Promise<string> {
  const env = deps.env ?? process.env;

  // Deployed-persona path: the cloud runtime resolves the token from the
  // credential store (refresh + rotation happen server-side) and injects a
  // narrow, short-lived `DAYTONA_ACCESS_TOKEN` into the sandbox — no refresh
  // token, no config file, no encryption key. Prefer it. When it's absent
  // (local dev / offline) fall through to the `daytona login` config + the
  // local self-refresh below.
  const injected = env.DAYTONA_ACCESS_TOKEN;
  if (typeof injected === 'string' && injected.length > 0) {
    return injected;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const configPath = deps.configPath ?? daytonaConfigPath();

  const cfg = await readConfig(configPath);
  const profile = activeProfile(cfg);
  const token = profile.api?.token ?? null;

  if (!token?.accessToken) {
    if (profile.api?.key) {
      throw new Error(
        'Daytona profile is API-key auth; API keys cannot mint usage-scoped JWTs. ' +
          'Run `daytona login` (browser) for a user token.',
      );
    }
    throw new Error(`No Daytona access token in ${configPath}. Run \`daytona login\`.`);
  }

  // Still fresh? Hand it back untouched.
  const expMs = Date.parse(token.expiresAt);
  if (Number.isFinite(expMs) && expMs - now() > EXPIRY_BUFFER_MS) {
    return token.accessToken;
  }

  if (!token.refreshToken) {
    throw new Error(
      'Daytona access token is expired and no refresh token is stored. Run `daytona login`.',
    );
  }

  const refreshed = await refreshAccessToken(token.refreshToken, fetchImpl);

  // Persist the rotated refresh token + new access token before returning, so a
  // crash after refresh can never strand us on the now-invalidated old token.
  profile.api!.token = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: new Date(now() + refreshed.expiresInSec * 1000).toISOString(),
  };
  await writeConfig(configPath, cfg);

  return refreshed.accessToken;
}

/**
 * Always returns a valid, auto-refreshed Daytona Auth0 access token.
 *
 * `orgId` is accepted for forward-compatibility and interface stability with
 * the daytona-monitor agent; the stored token is org-agnostic so it is not
 * required to mint the token (the org id goes on the API request header).
 *
 * @param orgId optional Daytona organization id (currently advisory).
 * @param deps  optional injection seams (config path / fetch / clock) for tests.
 */
export async function getDaytonaAccessToken(
  orgId?: string,
  deps: AuthDeps = {},
): Promise<string> {
  // Coalesce concurrent callers onto a single refresh.
  if (inFlight) return inFlight;
  inFlight = resolve(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Resolve the active Daytona organization id.
 *
 * Prefers the cloud-injected `DAYTONA_ORG_ID` (set alongside
 * `DAYTONA_ACCESS_TOKEN` in deployed-persona sandboxes), falling back to the
 * `activeOrganizationId` of the local config's active profile. Returns
 * `undefined` when neither is present — the token is org-agnostic, so callers
 * that require an org scope can supply one explicitly.
 */
export async function getDaytonaOrgId(deps: AuthDeps = {}): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const injected = env.DAYTONA_ORG_ID;
  if (typeof injected === 'string' && injected.length > 0) {
    return injected;
  }
  try {
    const configPath = deps.configPath ?? daytonaConfigPath();
    const cfg = await readConfig(configPath);
    const orgId = activeProfile(cfg).activeOrganizationId;
    return typeof orgId === 'string' && orgId.length > 0 ? orgId : undefined;
  } catch {
    return undefined;
  }
}

export default getDaytonaAccessToken;
