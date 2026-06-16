import {
  assertMountedLocalRootWithinAssigned,
  assertSafeMemberWritePath,
  memberWritePath,
  pathScope,
  validateMemberRelayfileAccessScopes,
} from "@cloud/core/proactive-runtime/member-token-scope.js";
import {
  launchMember,
  scopesFromRelayfileAccessToken,
  type LaunchMemberOptions,
  type LaunchMemberResult,
} from "@cloud/core/bootstrap/launch-member.js";
import { capabilityConfig, isTeamSolvePersona } from "@cloud/core/proactive-runtime/capabilities.js";
import { deploymentPersonaSpec } from "@cloud/core/proactive-runtime/agent-spec.js";
import {
  mintWorkspacePathScopedRelayfileToken,
} from "@cloud/core/relayfile/client.js";
import type { CredentialBundle } from "@cloud/core/auth/credentials.js";
import { Resource } from "sst";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import { buildCredentialBundle, getCliCredentials } from "@/lib/workflows";
import { mintScopedS3Credentials } from "@/lib/aws/sts-credentials";
import { isWorkerRuntime } from "@/lib/aws/runtime";
import {
  buildCloudApiWorkflowStorageCredentials,
  getWorkflowStorageBackend,
} from "@/lib/storage";
import { createApiTokenSession } from "@/lib/auth/api-token-store";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { ensureRelayWorkspace } from "@/lib/relay-workspaces";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";
import { readBoundRelayWorkspaceId } from "@/lib/workspaces/relay-workspace-binding";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";
import { toAbsoluteAppUrl, toAppPath } from "@/lib/app-path";
import { getCloudflareContext } from "@/lib/cloudflare-context";
import { logger } from "@/lib/logger";
import { mintWorkflowGithubWriteToken } from "@/lib/integrations/github-workflow-write-token";
import type { TeamRosterMemberConfig } from "@/lib/proactive-runtime/team-roster";

export type TeamLaunchN1Payload = Record<string, unknown>;

export type TeamLaunchN1Input = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  payload: TeamLaunchN1Payload;
  provisioningSandboxId?: string | null;
};

export type BuildTeamLaunchPayloadInput = TeamLaunchN1Input & {
  deployedByUserId?: string | null;
  organizationId?: string | null;
  appOrigin?: string | null;
  memberConfig?: TeamRosterMemberConfig | null;
};

export type BuildTeamLaunchPayloadDeps = {
  buildCredentialBundleForLaunch?: (input: {
    workspaceId: string;
    deployedByUserId: string;
    organizationId: string;
    deliveryId: string;
    runId: string;
    workflowConfig: string;
    appOrigin?: string | null;
    assignedRoot: string;
  }) => Promise<CredentialBundle | LaunchCredentialBundle>;
};

type LaunchCredentialBundle = {
  credentialBundle: CredentialBundle;
  envSecrets?: Record<string, string>;
};

export type TeamLaunchN1LaunchedResult = {
  status: "launched";
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  memberName: string;
  role: string;
  channel: string;
  sandboxId: string;
  assignedRoot: string;
  localRoot: string;
  writeScopes: string[];
};

export type TeamLaunchN1SkippedResult = {
  status: "skipped";
  reason:
    | "disabled"
    | "launch-deps-unavailable"
    | "unsupported-event"
    | "missing-issue-root"
    | "missing-target";
  workspaceId: string;
  agentId: string;
  deliveryId: string;
};

export type TeamLaunchN1Result =
  | TeamLaunchN1LaunchedResult
  | TeamLaunchN1SkippedResult;

export type TeamLaunchMemberOptions = LaunchMemberOptions;
export type TeamLaunchMemberResult = LaunchMemberResult;

export type TeamLaunchN1Deps = {
  isEnabled?: () => boolean;
  launchMember?: LaunchMemberFn;
  buildLaunchOptions?: (input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
    payload: TeamLaunchN1Payload;
    assignedRoot: string;
    localRoot: string;
  }) => Promise<TeamLaunchMemberOptions>;
};

type LaunchMemberFn = (
  options: TeamLaunchMemberOptions,
) => Promise<TeamLaunchMemberResult>;

export type BuildTeamLaunchMemberOptionsInput = {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
  payload: TeamLaunchN1Payload;
  assignedRoot: string;
  localRoot: string;
  memberConfig?: TeamRosterMemberConfig | null;
  provisioningSandboxId?: string | null;
  onSandboxCreated?: LaunchMemberOptions["onSandboxCreated"];
  onProvisioningSandboxCreated?: LaunchMemberOptions["onProvisioningSandboxCreated"];
};

export class TeamLaunchOptionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamLaunchOptionsUnavailableError";
  }
}

export async function buildTeamLaunchMemberOptions(
  input: BuildTeamLaunchMemberOptionsInput,
): Promise<TeamLaunchMemberOptions> {
  assertTeamLaunchN1ReadSurface({
    assignedRoot: input.assignedRoot,
    localRoot: input.localRoot,
  });
  const assignedRoot = assertConcreteGithubIssueRoot(input.assignedRoot);
  const launchConfig = launchConfigFromPayload(input.payload);
  const relayfile = resolveRelayfileConfig();
  if (!relayfile.relayAuthApiKey) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch options unavailable: RelayAuth API key is not configured",
    );
  }

  const memberConfig = resolveMemberConfig({
    rosterConfig: input.memberConfig,
  });
  const memberName = memberConfig.memberName;
  const relayWorkspaceId = await readBoundRelayWorkspaceId(input.workspaceId);
  if (!relayWorkspaceId) {
    await logger.warn("teamLaunchN1 RelayFile workspace binding not found", {
      area: "team-launch-n1",
      diag: "relay-workspace-binding-missing",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      assignedRoot,
    });
    throw new TeamLaunchOptionsUnavailableError(
      `teamLaunchN1 launch options unavailable: RelayFile workspace binding not found for app workspace ${input.workspaceId}`,
    );
  }
  const relayfileToken = await mintDirectMemberRelayfileToken({
    workspaceId: relayWorkspaceId,
    agentId: input.agentId,
    memberName,
    assignedRoot,
    relayAuthUrl: relayfile.relayAuthUrl,
    relayAuthApiKey: relayfile.relayAuthApiKey,
  });
  const orchestratorLibUrl = toAbsoluteAppUrl(
    resolveCloudApiUrl(),
    "/orchestrator-lib.tar.gz",
  ).toString();
  const orchestratorLibTarball = await loadOrchestratorLibTarballFromAssets(
    orchestratorLibUrl,
    input,
  );

  return {
    memberName,
    role: memberConfig.role,
    channel: memberConfig.channel,
    assignedRoot,
    localRoot: input.localRoot,
    workspaceId: input.workspaceId,
    relayfileUrl: relayfile.relayfileUrl,
    relayAuthUrl: relayfile.relayAuthUrl,
    relayAuthApiKey: relayfile.relayAuthApiKey,
    relayfileToken,
    runId: launchConfig.runId ?? input.deliveryId,
    credentialBundle: launchConfig.credentialBundle,
    fileType: launchConfig.fileType ?? "typescript",
    harness: memberConfig.harness,
    ...(memberConfig.model ? { model: memberConfig.model } : {}),
    ...(launchConfig.workflowConfig ? { workflowConfig: launchConfig.workflowConfig } : {}),
    ...(launchConfig.workflowPath ? { workflowPath: launchConfig.workflowPath } : {}),
    ...(launchConfig.workflowFileContent ? { workflowFileContent: launchConfig.workflowFileContent } : {}),
    ...(launchConfig.workflowFileName ? { workflowFileName: launchConfig.workflowFileName } : {}),
    ...(launchConfig.s3CodeKey ? { s3CodeKey: launchConfig.s3CodeKey } : {}),
    ...(launchConfig.snapshot ? { snapshot: launchConfig.snapshot } : {}),
    ...(launchConfig.envSecrets ? { envSecrets: launchConfig.envSecrets } : {}),
    orchestratorLibUrl,
    ...(orchestratorLibTarball ? { orchestratorLibTarball } : {}),
    ...(input.onSandboxCreated ? { onSandboxCreated: input.onSandboxCreated } : {}),
    ...(input.provisioningSandboxId ? { provisioningSandboxId: input.provisioningSandboxId } : {}),
    ...(input.onProvisioningSandboxCreated
      ? { onProvisioningSandboxCreated: input.onProvisioningSandboxCreated }
      : {}),
  };
}

export const launchTeamMember: LaunchMemberFn = (options) => launchMember(options);

const ENABLED_RESOURCE = "CloudTeamLaunchN1Enabled";
const ENABLED_ENV = "CLOUD_TEAM_LAUNCH_N1_ENABLED";
const TEST_ENABLED_ENV = "TEAM_LAUNCH_N1_TEST_MODE";
// Separate flag for the multi-member (maxMembers > 1) dispatcher leg so the
// proven N=1 path cannot be destabilized by a roster with extra rows. Default
// off: maxMembers > 1 personas keep today's teamIssue stand-down until this
// is flipped. The SST resource is intentionally NOT registered yet — flip via
// env until the go-live PR adds the infra link (documented in the PR body).
const MULTI_ENABLED_RESOURCE = "CloudTeamLaunchMultiEnabled";
const MULTI_ENABLED_ENV = "CLOUD_TEAM_LAUNCH_MULTI_ENABLED";
const MULTI_TEST_ENABLED_ENV = "TEAM_LAUNCH_MULTI_TEST_MODE";
const MEMBER_LOCAL_ROOT = "/home/daytona/workspace";
const MEMBER_TOKEN_TTL_SECONDS = 3600;
const FALLBACK_MEMBER_NAME = "cloud-team-issue-n1";
const FALLBACK_MEMBER_ROLE = "implementer";
const FALLBACK_MEMBER_CHANNEL = "team-launch-n1-agent";
const FALLBACK_MEMBER_HARNESS = "claude";
const FALLBACK_MEMBER_MODEL = "claude-sonnet-4-6";
const MEMBER_WORKFLOW_NAME = "cloud-team-issue-n1";
// In-box run lock claimed by the workflow's first (deterministic) step.
// /tmp survives for the sandbox lifetime and is writable regardless of the
// read-only bundle materialization (#1832).
const MEMBER_RUN_LOCK_DIR = "/tmp/.team-launch-run-lock";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled";
}

function readProcessEnvString(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isTeamLaunchN1Enabled(): boolean {
  return truthyFlag(
    tryResourceValue(ENABLED_RESOURCE) ??
      readProcessEnvString(ENABLED_ENV) ??
      readProcessEnvString(TEST_ENABLED_ENV),
  );
}

export function isTeamLaunchMultiEnabled(): boolean {
  return truthyFlag(
    tryResourceValue(MULTI_ENABLED_RESOURCE) ??
      readProcessEnvString(MULTI_ENABLED_ENV) ??
      readProcessEnvString(MULTI_TEST_ENABLED_ENV),
  );
}

/**
 * Single definition for the teamSolve member cap — the dispatcher gate and
 * the delivery drain MUST read the same persona-level resolver (the wrapped
 * `{persona, agent}` spec snapshot made raw `spec.capabilities` reads
 * silently false; see the #1649 capability-reader regression).
 */
export function teamSolveMaxMembers(spec: unknown): number | null {
  if (!isTeamSolvePersona(spec)) {
    return null;
  }
  return capabilityConfig(spec, "teamSolve").maxMembers;
}

export async function buildTeamLaunchPayload(
  input: BuildTeamLaunchPayloadInput,
  deps: BuildTeamLaunchPayloadDeps = {},
): Promise<TeamLaunchN1Payload> {
  const assignedRoot = deriveGithubIssueAssignedRoot(input.payload);
  if (!assignedRoot) {
    return input.payload;
  }

  const deployedByUserId = stringValue(input.deployedByUserId);
  if (!deployedByUserId) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch payload unavailable: deployedByUserId is missing",
    );
  }
  const organizationId = stringValue(input.organizationId) ?? input.workspaceId;
  const localRoot = memberLocalRootForAssignedRoot(assignedRoot);
  const memberConfig = resolveMemberConfig({
    rosterConfig: input.memberConfig,
  });
  const workflowConfig = buildMemberWorkflowConfig({
    assignedRoot,
    localRoot,
    memberConfig,
  });
  const runId = crypto.randomUUID();
  const credentials = normalizeLaunchCredentialBundle(
    await (deps.buildCredentialBundleForLaunch ?? buildDefaultLaunchCredentialBundle)({
      workspaceId: input.workspaceId,
      deployedByUserId,
      organizationId,
      deliveryId: input.deliveryId,
      runId,
      workflowConfig,
      appOrigin: input.appOrigin,
      assignedRoot,
    }),
  );

  return {
    ...input.payload,
    launchMember: {
      memberName: memberConfig.memberName,
      role: memberConfig.role,
      channel: memberConfig.channel,
      harness: memberConfig.harness,
      ...(memberConfig.model ? { model: memberConfig.model } : {}),
      runId,
      credentialBundle: credentials.credentialBundle,
      workflowConfig,
      fileType: "config",
      ...(credentials.envSecrets ? { envSecrets: credentials.envSecrets } : {}),
    },
  };
}

function normalizeLaunchCredentialBundle(
  value: CredentialBundle | LaunchCredentialBundle,
): LaunchCredentialBundle {
  if (isRecord(value) && isRecord(value.credentialBundle)) {
    return {
      credentialBundle: value.credentialBundle as unknown as CredentialBundle,
      envSecrets: recordOfStrings(value.envSecrets),
    };
  }
  return { credentialBundle: value as CredentialBundle };
}

export function deriveGithubIssueAssignedRoot(payload: TeamLaunchN1Payload): string | null {
  if (payload.provider !== "github" || payload.eventType !== "issues.labeled") {
    return null;
  }

  const paths = Array.isArray(payload.paths)
    ? payload.paths.filter((path): path is string => typeof path === "string")
    : [];
  assertNoUnsafeEventPaths(paths);
  for (const path of paths) {
    const root = githubIssueRootFromPath(path);
    if (root) return root;
  }

  const resource = isRecord(payload.resource) ? payload.resource : {};
  const issue = isRecord(resource.issue) ? resource.issue : resource;
  const repository = isRecord(resource.repository)
    ? resource.repository
    : isRecord(issue.repository)
    ? issue.repository
    : {};
  const fullName = stringValue(repository.full_name);
  const issueNumber = stringValue(issue.number ?? resource.number);
  if (!fullName || !issueNumber) {
    return null;
  }
  const parts = fullName.split("/");
  if (parts.length !== 2) {
    return null;
  }
  const owner = cleanPathSegment(parts[0] ?? "");
  const repo = cleanPathSegment(parts[1] ?? "");
  const issueId = cleanIssueId(issueNumber);
  if (!owner || !repo || !issueId) {
    return null;
  }
  return `/github/repos/${owner}/${repo}/issues/${issueId}`;
}

export function memberLocalRootForAssignedRoot(assignedRoot: string): string {
  const normalized = assertSafeMemberWritePath(assignedRoot);
  // Strict N=1 seam proof: no broad repo clone/read seed. The member code
  // mount is a one-to-one local projection of the assigned Relayfile issue root.
  return `${MEMBER_LOCAL_ROOT}${normalized}`;
}

export function assertTeamLaunchN1ReadSurface(input: {
  assignedRoot: string;
  localRoot: string;
}): void {
  const assignedRoot = assertSafeMemberWritePath(input.assignedRoot);
  const expectedLocalRoot = memberLocalRootForAssignedRoot(assignedRoot);
  if (input.localRoot !== expectedLocalRoot) {
    throw new Error("teamLaunchN1 localRoot must be bounded to the assigned issue root");
  }
  assertMountedLocalRootWithinAssigned([assignedRoot], [assignedRoot]);
}

export function assertExactSingleWriteScope(input: {
  assignedRoot: string;
  writeScopes: readonly string[];
}): string[] {
  const expected = pathScope(input.assignedRoot);
  const scopes = input.writeScopes.map((scope) => scope.trim());
  const writeScopes = scopes.filter((scope) => scope.startsWith("relayfile:fs:write:"));
  if (writeScopes.length !== 1 || writeScopes[0] !== expected) {
    throw new Error("teamLaunchN1 relay_pa write scope must exactly match the assigned root");
  }
  validateMemberRelayfileAccessScopes(scopes, [input.assignedRoot]);
  return [expected];
}

export async function dispatchTeamLaunchN1(
  input: TeamLaunchN1Input,
  deps: TeamLaunchN1Deps = {},
): Promise<TeamLaunchN1Result> {
  if (!(deps.isEnabled ?? isTeamLaunchN1Enabled)()) {
    return skipped(input, "disabled");
  }

  const assignedRoot = deriveGithubIssueAssignedRoot(input.payload);
  if (!assignedRoot) {
    return skipped(input, "missing-issue-root");
  }
  const safeAssignedRoot = assertSafeMemberWritePath(assignedRoot);
  const localRoot = memberLocalRootForAssignedRoot(safeAssignedRoot);
  assertTeamLaunchN1ReadSurface({ assignedRoot: safeAssignedRoot, localRoot });

  if (!deps.launchMember || !deps.buildLaunchOptions) {
    return skipped(input, "launch-deps-unavailable");
  }

  let launchOptions: TeamLaunchMemberOptions;
  try {
    launchOptions = await deps.buildLaunchOptions({
      ...input,
      assignedRoot: safeAssignedRoot,
      localRoot,
    });
  } catch (error) {
    if (error instanceof TeamLaunchOptionsUnavailableError) {
      return skipped(input, "launch-deps-unavailable");
    }
    throw error;
  }
  assertTeamLaunchN1ReadSurface({
    assignedRoot: launchOptions.assignedRoot,
    localRoot: launchOptions.localRoot,
  });

  const launched = await deps.launchMember(launchOptions);
  return sanitizeLaunchResult({
    input,
    launched,
    assignedRoot: safeAssignedRoot,
    localRoot,
  });
}

function sanitizeLaunchResult({
  input,
  launched,
  assignedRoot,
  localRoot,
}: {
  input: TeamLaunchN1Input;
  launched: TeamLaunchMemberResult;
  assignedRoot: string;
  localRoot: string;
}): TeamLaunchN1LaunchedResult {
  const writeScopes = assertExactSingleWriteScope({
    assignedRoot,
    writeScopes: launched.writeScopes,
  });
  if (launched.relayfileToken.startsWith("relay_ws_")) {
    throw new Error("teamLaunchN1 member launch returned a control-plane token");
  }
  return {
    status: "launched",
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
    memberName: launched.memberName,
    role: launched.role,
    channel: launched.channel,
    sandboxId: launched.sandboxId,
    assignedRoot,
    localRoot,
    writeScopes,
  };
}

export async function mintDirectMemberRelayfileToken(input: {
  workspaceId: string;
  agentId: string;
  memberName: string;
  assignedRoot: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
}): Promise<string> {
  const assignedRoot = assertConcreteGithubIssueRoot(input.assignedRoot);
  const expectedWriteScope = pathScope(assignedRoot);
  const token = await mintWorkspacePathScopedRelayfileToken({
    workspaceId: input.workspaceId,
    relayAuthUrl: input.relayAuthUrl,
    relayAuthApiKey: input.relayAuthApiKey,
    agentName: input.memberName,
    agentId: input.agentId,
    paths: [memberWritePath(assignedRoot)],
    scopes: [expectedWriteScope],
    ttlSeconds: MEMBER_TOKEN_TTL_SECONDS,
  });
  const decodedScopes = scopesFromRelayfileAccessToken(token);
  const writeScopes = assertExactSingleWriteScope({
    assignedRoot,
    writeScopes: decodedScopes,
  });
  if (writeScopes[0] !== expectedWriteScope) {
    throw new Error("teamLaunchN1 decoded relay_pa write scope did not byte-match requested scope");
  }
  assertTokenTtlHonored(token, MEMBER_TOKEN_TTL_SECONDS);
  return token;
}

function skipped(input: TeamLaunchN1Input, reason: TeamLaunchN1SkippedResult["reason"]): TeamLaunchN1SkippedResult {
  return {
    status: "skipped",
    reason,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    deliveryId: input.deliveryId,
  };
}

function launchConfigFromPayload(payload: TeamLaunchN1Payload): {
  runId?: string;
  credentialBundle: CredentialBundle;
  fileType?: LaunchMemberOptions["fileType"];
  workflowConfig?: string;
  workflowPath?: string;
  workflowFileContent?: string;
  workflowFileName?: string;
  s3CodeKey?: string;
  snapshot?: string;
  envSecrets?: Record<string, string>;
} {
  const rawConfig = isRecord(payload.launchMember)
    ? payload.launchMember
    : isRecord(payload.launch)
    ? payload.launch
    : null;
  if (!rawConfig) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch options unavailable: launch credentials are missing",
    );
  }
  const credentialBundle = rawConfig.credentialBundle;
  if (!isRecord(credentialBundle)) {
    throw new TeamLaunchOptionsUnavailableError(
      "teamLaunchN1 launch options unavailable: credentialBundle is missing",
    );
  }

  return {
    runId: stringValue(rawConfig.runId) ?? undefined,
    credentialBundle: credentialBundle as unknown as CredentialBundle,
    fileType: fileTypeValue(rawConfig.fileType),
    workflowConfig: stringValue(rawConfig.workflowConfig) ?? undefined,
    workflowPath: stringValue(rawConfig.workflowPath) ?? undefined,
    workflowFileContent: stringValue(rawConfig.workflowFileContent) ?? undefined,
    workflowFileName: stringValue(rawConfig.workflowFileName) ?? undefined,
    s3CodeKey: stringValue(rawConfig.s3CodeKey) ?? undefined,
    snapshot: stringValue(rawConfig.snapshot) ?? undefined,
    envSecrets: recordOfStrings(rawConfig.envSecrets),
  };
}

type ResolvedMemberConfig = {
  memberName: string;
  role: string;
  channel: string;
  harness: string;
  model?: string;
};

function configFromPersonaSpec(spec: unknown): Partial<ResolvedMemberConfig> {
  const persona = deploymentPersonaSpec(spec);
  if (!persona) {
    return {};
  }

  return {
    memberName: stringValue(persona.slug) ??
      stringValue(persona.name) ??
      stringValue(persona.id) ??
      undefined,
    role: stringValue(persona.role) ??
      capabilityConfig(persona, "teamSolve").roles[0],
    channel: stringValue(persona.channel) ?? undefined,
    harness: stringValue(persona.harness) ?? undefined,
    ...(stringValue(persona.model) ? { model: stringValue(persona.model)! } : {}),
  };
}

function resolveMemberConfig(input: {
  rosterConfig?: TeamRosterMemberConfig | null;
}): ResolvedMemberConfig {
  const rosterConfig = input.rosterConfig ?? null;
  const personaConfig = configFromPersonaSpec(rosterConfig?.personaSpec);
  const model = stringValue(rosterConfig?.model) ??
    personaConfig.model ??
    (rosterConfig ? undefined : FALLBACK_MEMBER_MODEL);
  const memberName =
    stringValue(rosterConfig?.memberName) ??
    personaConfig.memberName ??
    FALLBACK_MEMBER_NAME;

  return {
    memberName,
    role: stringValue(rosterConfig?.role) ??
      personaConfig.role ??
      FALLBACK_MEMBER_ROLE,
    channel: stringValue(rosterConfig?.channel) ??
      personaConfig.channel ??
      FALLBACK_MEMBER_CHANNEL,
    harness: stringValue(rosterConfig?.harness) ??
      personaConfig.harness ??
      FALLBACK_MEMBER_HARNESS,
    ...(model ? { model } : {}),
  };
}

function buildMemberWorkflowConfig(input: {
  assignedRoot: string;
  localRoot: string;
  memberConfig: ResolvedMemberConfig;
}): string {
  const repo = githubRepoFromAssignedRoot(input.assignedRoot);
  const cloneTarget = repo ? `${repo.owner}/${repo.name}` : "the assigned GitHub repository";
  const agent: Record<string, unknown> = {
    name: input.memberConfig.memberName,
    cli: input.memberConfig.harness,
    preset: "worker",
    role: input.memberConfig.role,
    interactive: false,
  };
  if (input.memberConfig.model) {
    agent.constraints = { model: input.memberConfig.model };
  }
  return JSON.stringify({
    version: "1.0",
    name: MEMBER_WORKFLOW_NAME,
    swarm: {
      pattern: "pipeline",
      channel: input.memberConfig.channel,
      maxConcurrency: 1,
      timeoutMs: 3600_000,
    },
    agents: [agent],
    workflows: [
      {
        name: MEMBER_WORKFLOW_NAME,
        steps: [
          // Run lock — deterministic, not prompt-dependent. Daytona's exec
          // proxy 524s long bootstraps while the dispatched process keeps
          // running in-box; the queue's retry then dispatches a SIBLING
          // bootstrap into the same sandbox. On #1820 this produced 8 member
          // runs / 8 PRs from one labeled event. `mkdir` is atomic: the first
          // workflow creates the lock and proceeds; any sibling's mkdir exits
          // non-zero, failing this step and aborting its workflow before the
          // agent step spawns. Crash-before-lock leaves no lock, so a genuine
          // retry of a never-started run still proceeds.
          {
            name: "acquire-run-lock",
            type: "deterministic",
            command: `mkdir ${MEMBER_RUN_LOCK_DIR}`,
          },
          {
            name: "implement",
            agent: input.memberConfig.memberName,
            task: [
              `Read the assigned issue mounted at ${input.localRoot}.`,
              `Run gh auth setup-git, then gh repo clone ${cloneTarget}, check out a new branch, implement the requested change, run relevant checks, commit, git push the branch, and create the pull request with gh pr create against AgentWorkforce/cloud.`,
              `Stay within the assigned Relayfile root ${input.assignedRoot} for Relayfile reads and writes only.`,
            ].join(" "),
          },
        ],
      },
    ],
  });
}

async function buildDefaultLaunchCredentialBundle(input: {
  workspaceId: string;
  deployedByUserId: string;
  organizationId: string;
  deliveryId: string;
  runId: string;
  workflowConfig: string;
  appOrigin?: string | null;
  assignedRoot: string;
}): Promise<LaunchCredentialBundle> {
  const runId = input.runId;
  const apiUrl = resolveCloudApiUrl(input.appOrigin);
  const storageBackend = getWorkflowStorageBackend();
  const tokenSession = await createApiTokenSession({
    subjectType: "sandbox",
    userId: input.deployedByUserId,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    runId,
    accessTokenTtlSeconds: 4 * 3600,
    scopes: [
      "auth:token:refresh",
      "auth:token:revoke",
      "workflow:invoke:write",
      "workflow:invoke:read",
      "workflow:runs:read",
      "workflow:logs:read",
      "workflow:runs:events:write",
    ],
  });
  const s3Credentials = storageBackend === "r2"
    ? buildCloudApiWorkflowStorageCredentials({
      userId: input.deployedByUserId,
      runId,
      apiUrl,
      accessToken: tokenSession.accessToken,
      refreshToken: tokenSession.refreshToken,
    })
    : await mintScopedS3Credentials({
      userId: input.deployedByUserId,
      runId,
      roleArn: isWorkerRuntime() ? undefined : safeWorkflowStorageResource("stsRoleArn"),
      bucket: isWorkerRuntime() ? undefined : safeWorkflowStorageResource("bucketName"),
    });

  let cliCredentials = "";
  try {
    cliCredentials = await getCliCredentials(
      input.deployedByUserId,
      "anthropic",
      Resource.CredentialEncryptionKey.value,
    );
  } catch (error) {
    await logger.warn("teamLaunchN1 CLI credentials unavailable", {
      area: "team-launch-n1",
      diag: "cli-credentials-unavailable",
      workspaceId: input.workspaceId,
      deliveryId: input.deliveryId,
      userId: input.deployedByUserId,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    });
    cliCredentials = "";
  }

  const resolvedRelayWorkspace = await resolveOrProvisionRelayWorkspace({
    userId: input.deployedByUserId,
    appWorkspaceId: input.workspaceId,
  });
  await ensureRelayWorkspace(resolvedRelayWorkspace.id, { ignored: [], readonly: [] });
  const daytonaAuth = resolveServerDaytonaAuthParams();
  const githubRepo = githubRepoFromAssignedRoot(input.assignedRoot);
  const envSecrets: Record<string, string> = {};
  if (githubRepo) {
    const githubToken = await mintWorkflowGithubWriteToken({
      userId: input.deployedByUserId,
      workspaceId: input.workspaceId,
      repoOwner: githubRepo.owner,
      repoName: githubRepo.name,
    });
    envSecrets.GITHUB_TOKEN = githubToken.token;
  }

  return {
    credentialBundle: buildCredentialBundle({
      s3Credentials,
      cliCredentials,
      workspaceId: resolvedRelayWorkspace.id,
      relayApiKey: resolvedRelayWorkspace.relaycastApiKey,
      relayBaseUrl: resolveRelaycastUrl(),
      runId,
      userId: input.deployedByUserId,
      cloudApiUrl: apiUrl,
      cloudApiAccessToken: tokenSession.accessToken,
      cloudApiRefreshToken: tokenSession.refreshToken,
      cloudApiAccessTokenExpiresAt: tokenSession.accessTokenExpiresAt,
      ...daytonaAuth,
      workflowConfig: input.workflowConfig,
    }),
    ...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),
  };
}

function resolveCloudApiUrl(appOrigin?: string | null): string {
  const origin = appOrigin?.trim()
    || optionalEnv("NEXT_PUBLIC_APP_URL")
    || optionalEnv("APP_URL")
    || optionalEnv("CLOUD_APP_URL")
    || "https://cloud.agentrelay.com";
  return toAbsoluteAppUrl(origin, "/").toString();
}

type AssetsBinding = {
  fetch(input: string | URL): Promise<Response>;
};

async function loadOrchestratorLibTarballFromAssets(
  orchestratorLibUrl: string,
  input: Pick<BuildTeamLaunchMemberOptionsInput, "workspaceId" | "agentId" | "deliveryId">,
): Promise<Uint8Array | undefined> {
  let assets: AssetsBinding | undefined;
  try {
    const env = getCloudflareContext({ async: false }).env as
      | { ASSETS?: AssetsBinding }
      | undefined;
    assets = env?.ASSETS;
  } catch {
    return undefined;
  }
  if (!assets) {
    return undefined;
  }

  try {
    const assetUrl = new URL(toAppPath("/orchestrator-lib.tar.gz"), orchestratorLibUrl);
    const res = await assets.fetch(assetUrl);
    if (!res.ok) {
      await logger.warn("teamLaunchN1 ASSETS orchestrator-lib fetch not ok", {
        area: "team-launch-n1",
        diag: "orchestrator-lib-assets-fetch-not-ok",
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deliveryId: input.deliveryId,
        status: res.status,
      });
      return undefined;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > 1 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return buf;
    }
    await logger.warn("teamLaunchN1 ASSETS orchestrator-lib body not a valid gzip", {
      area: "team-launch-n1",
      diag: "orchestrator-lib-assets-invalid-gzip",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      sizeBytes: buf.byteLength,
    });
  } catch (error) {
    await logger.warn("teamLaunchN1 ASSETS orchestrator-lib load failed", {
      area: "team-launch-n1",
      diag: "orchestrator-lib-assets-load-failed",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : undefined,
    });
  }
  return undefined;
}

function safeWorkflowStorageResource(prop: "bucketName" | "stsRoleArn"): string | undefined {
  try {
    const resource = Resource.WorkflowStorage as unknown as Record<string, unknown>;
    const value = resource?.[prop];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function fileTypeValue(value: unknown): LaunchMemberOptions["fileType"] | undefined {
  return value === "yaml" || value === "typescript" || value === "python" || value === "config"
    ? value
    : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function githubRepoFromAssignedRoot(assignedRoot: string): { owner: string; name: string } | null {
  const normalized = assertSafeMemberWritePath(assignedRoot);
  const match = normalized.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/[^/]+$/u);
  if (!match) return null;
  const owner = match[1]?.trim();
  const name = match[2]?.trim();
  return owner && name ? { owner, name } : null;
}

function assertConcreteGithubIssueRoot(assignedRoot: string): string {
  const normalized = assertSafeMemberWritePath(assignedRoot);
  if (normalized.includes("*")) {
    throw new Error("teamLaunchN1 assigned issue root must be wildcard-free");
  }
  if (!/^\/github\/repos\/[^/]+\/[^/]+\/issues\/[^/]+$/u.test(normalized)) {
    throw new Error("teamLaunchN1 assigned root must be a concrete GitHub issue path");
  }
  return normalized;
}

function assertTokenTtlHonored(token: string, maxTtlSeconds: number): void {
  const claims = jwtPayload(token);
  const issuedAt = numericClaim(claims.iat);
  const expiresAt = numericClaim(claims.exp);
  if (issuedAt === null || expiresAt === null || expiresAt <= issuedAt) {
    throw new Error("teamLaunchN1 relay_pa token must include valid iat/exp claims");
  }
  if (expiresAt - issuedAt > maxTtlSeconds) {
    throw new Error("teamLaunchN1 relay_pa token TTL exceeded requested short TTL");
  }
}

function jwtPayload(token: string): Record<string, unknown> {
  if (!token.startsWith("relay_pa_")) {
    throw new Error("teamLaunchN1 direct member token must be relay_pa_");
  }
  const payloadPart = token.slice("relay_pa_".length).split(".")[1];
  if (!payloadPart) {
    throw new Error("teamLaunchN1 relay_pa token is not a JWT");
  }
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
  if (!isRecord(payload)) {
    throw new Error("teamLaunchN1 relay_pa token payload must be an object");
  }
  return payload;
}

function numericClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function githubIssueRootFromPath(path: string): string | null {
  const canonical = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)/u);
  if (!canonical) return null;
  const owner = cleanPathSegment(canonical[1] ?? "");
  const repo = cleanPathSegment(canonical[2] ?? "");
  const issueId = cleanIssueId(canonical[3] ?? "");
  if (!owner || !repo || !issueId) return null;
  return `/github/repos/${owner}/${repo}/issues/${issueId}`;
}

function assertNoUnsafeEventPaths(paths: readonly string[]): void {
  for (const path of paths) {
    for (const rawSegment of path.split("/")) {
      const segment = decodePathSegment(rawSegment).trim();
      if (
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\")
      ) {
        throw new Error("teamLaunchN1 event path contains unsafe traversal");
      }
    }
  }
}

function cleanPathSegment(value: string): string {
  const cleaned = decodePathSegment(value).trim();
  if (
    !cleaned ||
    cleaned === "*" ||
    cleaned.includes("*") ||
    cleaned.includes("/") ||
    cleaned.includes("\\")
  ) {
    return "";
  }
  return encodePathSegment(cleaned);
}

function cleanIssueId(value: string): string {
  const cleaned = decodePathSegment(value)
    .replace(/\.json$/u, "")
    .trim();
  if (!cleaned || cleaned === "_index" || cleaned.includes("*")) return "";
  if (cleaned.includes("/") || cleaned.includes("\\")) return "";
  return encodePathSegment(cleaned);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
