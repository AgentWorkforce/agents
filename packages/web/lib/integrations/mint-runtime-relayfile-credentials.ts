import {
  mintPathScopedRelayfileTokenPair,
  mintWorkspaceScopedRelayfileTokenPair,
  mintWorkspacePathScopedRelayfileTokenPair,
  type MintPathScopedRelayfileTokenOptions,
} from "@cloud/core/relayfile/client.js";
import {
  normalizeRelayfilePath,
  RelayfilePathScopeError,
  relayfilePathsForIntegrations,
  type RelayfileTriggerDescriptor,
  type RelayfileTriggerIntegrations,
} from "@cloud/core/relayfile/path-scopes.js";
import {
  relayfileTriggerIntegrationsFromAgentOrLegacy,
} from "@cloud/core/proactive-runtime/agent-spec.js";
import {
  assertSafeMemberWritePath,
  MemberTokenScopeError,
} from "@cloud/core/proactive-runtime/member-token-scope.js";
import { resolveRelayAuthConfig, resolveRelayfileConfig } from "@/lib/relayfile";
import {
  normalizePersonaIntegrationSource,
  type PersonaIntegrationConfigWithSource,
} from "./persona-integration-config";

export type RuntimeRelayfileCredentials = {
  relayfileUrl: string;
  relayauthUrl: string;
  relayfileWorkspaceId: string;
  relayfileToken: string | null;
  relayfileTokenExpiresAt: string | null;
  relayfileRefreshToken: string | null;
  relayfileRefreshTokenExpiresAt: string | null;
  relayfileScopes: string[];
  delegationNotAfter: string | null;
  relayfileMountPaths: string[];
};

export type MintRuntimeRelayfileCredentialsInput = {
  workspaceId: string;
  workspaceToken?: string | null;
  useRelayAuthApiKey?: boolean;
  relayfileMountPaths: string[];
  relayfileScopes?: string[];
  ttlSeconds: number;
  delegationNotAfter?: string | null;
  agentName: string;
  agentId?: string | null;
  auditLogger?: MintPathScopedRelayfileTokenOptions["auditLogger"];
  includeRelayfileUrl?: boolean;
};

export function normalizePersonaIntegrationConfigs(
  value: unknown,
): Record<string, PersonaIntegrationConfigWithSource> | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }

  const normalized: Record<string, PersonaIntegrationConfigWithSource> = {};
  for (const [rawProvider, rawConfig] of Object.entries(value)) {
    const provider = rawProvider.trim();
    if (!provider || rawConfig === null || !isRecord(rawConfig)) {
      return null;
    }

    try {
      normalized[provider] = {
        ...rawConfig,
        source: normalizePersonaIntegrationSource(rawConfig),
      };
    } catch {
      return null;
    }
  }
  return normalized;
}

export function normalizeRelayfileMountPaths(value: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (value ?? [])
        .map(normalizeRuntimeRelayfileMountPath)
        .filter((entry): entry is string => entry !== null),
    ),
  ].sort();
}

export function relayfileTriggerIntegrationsFromPersonaIntegrations(
  value: unknown,
): RelayfileTriggerIntegrations | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const integrations = new Map<string, { triggers?: RelayfileTriggerDescriptor[] }>();
  for (const [provider, config] of Object.entries(value)) {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider || !isRecord(config)) {
      continue;
    }

    const triggers = normalizeTriggerArray(config.triggers);
    if (triggers) {
      integrations.set(normalizedProvider, { triggers });
    }
  }

  return integrations.size > 0 ? Object.fromEntries(integrations) : undefined;
}

export function resolveRuntimeRelayfileMountPaths(input: {
  relayfileMountPaths?: readonly string[];
  integrations?: unknown;
  agent?: unknown;
}): string[] {
  if (input.relayfileMountPaths !== undefined) {
    return normalizeRelayfileMountPaths(input.relayfileMountPaths);
  }

  const triggerIntegrations = relayfileTriggerIntegrationsFromAgentOrLegacy({
    agent: input.agent,
    integrations: input.integrations,
  });
  assertAgentTriggerProvidersHaveIntegrations(input.agent, input.integrations);
  return relayfilePathsForIntegrations(triggerIntegrations);
}

export async function mintRuntimeRelayfileCredentials(
  input: MintRuntimeRelayfileCredentialsInput,
): Promise<RuntimeRelayfileCredentials> {
  const config = input.includeRelayfileUrl === false
    ? { ...resolveRelayAuthConfig(), relayfileUrl: "" }
    : resolveRelayfileConfig();
  const relayfileMountPaths = normalizeRelayfileMountPaths(input.relayfileMountPaths);
  const workspaceToken = input.workspaceToken?.trim();
  const relayAuthApiKey = input.useRelayAuthApiKey ? config.relayAuthApiKey.trim() : "";
  let relayfileToken: string | null = null;
  let relayfileTokenExpiresAt: string | null = null;
  let relayfileRefreshToken: string | null = null;
  let relayfileRefreshTokenExpiresAt: string | null = null;
  let relayfileScopes: string[] = [];
  const requestedRelayfileScopes = input.relayfileScopes ?? [];

  if (relayfileMountPaths.length > 0 && (workspaceToken || relayAuthApiKey)) {
    const tokenPair = relayAuthApiKey
      ? await mintWorkspacePathScopedRelayfileTokenPair({
          workspaceId: input.workspaceId,
          relayAuthUrl: config.relayAuthUrl,
          relayAuthApiKey,
          paths: relayfileMountPaths,
          scopes: requestedRelayfileScopes.length > 0
            ? requestedRelayfileScopes
            : relayfileMountPaths.flatMap((path) => [
                `relayfile:fs:read:${path}`,
                `relayfile:fs:write:${path}`,
              ]),
          ttlSeconds: input.ttlSeconds,
          delegationNotAfter: input.delegationNotAfter ?? undefined,
          agentName: input.agentName,
          agentId: input.agentId ?? input.agentName,
          auditLogger: input.auditLogger,
        })
      : await mintPathScopedRelayfileTokenPair({
          workspaceId: input.workspaceId,
          relayAuthUrl: config.relayAuthUrl,
          workspaceToken: workspaceToken || undefined,
          paths: relayfileMountPaths,
          ttlSeconds: input.ttlSeconds,
          delegationNotAfter: input.delegationNotAfter ?? undefined,
          agentName: input.agentName,
          agentId: input.agentId ?? input.agentName,
          auditLogger: input.auditLogger,
        });
    relayfileToken = tokenPair.accessToken;
    relayfileTokenExpiresAt = tokenPair.accessTokenExpiresAt;
    relayfileRefreshToken = tokenPair.refreshToken;
    relayfileRefreshTokenExpiresAt = tokenPair.refreshTokenExpiresAt;
    relayfileScopes = tokenPair.scopes;
  } else if (requestedRelayfileScopes.length > 0 && relayAuthApiKey) {
    const tokenPair = await mintWorkspaceScopedRelayfileTokenPair({
      workspaceId: input.workspaceId,
      relayAuthUrl: config.relayAuthUrl,
      relayAuthApiKey,
      scopes: requestedRelayfileScopes,
      ttlSeconds: input.ttlSeconds,
      delegationNotAfter: input.delegationNotAfter ?? undefined,
      agentName: input.agentName,
      agentId: input.agentId ?? input.agentName,
      auditLogger: input.auditLogger,
    });
    relayfileToken = tokenPair.accessToken;
    relayfileTokenExpiresAt = tokenPair.accessTokenExpiresAt;
    relayfileRefreshToken = tokenPair.refreshToken;
    relayfileRefreshTokenExpiresAt = tokenPair.refreshTokenExpiresAt;
    relayfileScopes = tokenPair.scopes;
  }

  return {
    relayfileUrl: config.relayfileUrl,
    relayauthUrl: config.relayAuthUrl,
    relayfileWorkspaceId: input.workspaceId,
    relayfileToken,
    relayfileTokenExpiresAt,
    relayfileRefreshToken,
    relayfileRefreshTokenExpiresAt,
    relayfileScopes,
    delegationNotAfter: input.delegationNotAfter ?? null,
    relayfileMountPaths,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRuntimeRelayfileMountPath(entry: string): string | null {
  const normalized = normalizeRelayfilePath(entry);
  if (!normalized || hasParentTraversalSegment(normalized)) {
    return null;
  }

  try {
    // Reuse the launchMember root guard as a detector: invalid roots drop to no
    // runtime token, while valid paths keep the normalized Relayfile shape.
    assertSafeMemberWritePath(normalized);
  } catch (error) {
    if (error instanceof MemberTokenScopeError) {
      if (hasParentTraversalSegment(normalized)) {
        throw error;
      }
      return null;
    }
    throw error;
  }

  return normalized;
}

function hasParentTraversalSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

function normalizeTriggerArray(value: unknown): RelayfileTriggerDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [...new Set(
    value
      .map((entry): RelayfileTriggerDescriptor | null => {
        if (typeof entry === "string") {
          const trimmed = entry.trim();
          return trimmed || null;
        }
        return isRecord(entry) ? entry : null;
      })
      .filter((entry): entry is RelayfileTriggerDescriptor => entry !== null),
  )];
  return normalized.length > 0 ? normalized : undefined;
}

function assertAgentTriggerProvidersHaveIntegrations(agent: unknown, integrations: unknown): void {
  if (!isRecord(agent) || !isRecord(agent.triggers)) {
    return;
  }
  const personaIntegrations = isRecord(integrations) ? integrations : {};
  for (const [provider, triggers] of Object.entries(agent.triggers)) {
    if (!Array.isArray(triggers) || triggers.length === 0) {
      continue;
    }
    if (!isRecord(personaIntegrations[provider])) {
      throw new RelayfilePathScopeError(
        `agent.triggers.${provider} requires a matching integrations.${provider} connection`,
      );
    }
  }
}
