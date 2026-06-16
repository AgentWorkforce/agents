import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import {
  mintRuntimeRelayfileCredentials,
  normalizeRelayfileMountPaths,
} from "@/lib/integrations/mint-runtime-relayfile-credentials";
import { logger } from "@/lib/logger";
import {
  parseRelayfileDelegatedTokenRequest,
  type RelayfileDelegatedTokenBody,
} from "@/lib/relayfile-delegated-token-contract";
import { resolveRelayAuthConfig } from "@/lib/relayfile";
import {
  createWorkspaceJoinAccess,
  isValidWorkspaceId,
} from "@/lib/relay-workspaces";
import { createCloudWorkspaceRegistry } from "@/lib/workspace-registry";
import { resolveAppWorkspaceByRelayWorkspaceId } from "@/lib/workspaces/relay-workspace-binding";
import type { WorkspacePermissions } from "@cloud/core/workspace/registry.js";

type DelegatedTokenRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ErrorResponse = {
  error: string;
  code: string;
};

const DEFAULT_WORKSPACE_PERMISSIONS: WorkspacePermissions = { ignored: [], readonly: [] };

function jsonError(
  error: string,
  code: string,
  status: number,
): NextResponse<ErrorResponse> {
  return NextResponse.json({ error, code }, { status });
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseBody(value: unknown, permissions: WorkspacePermissions): RelayfileDelegatedTokenBody | null {
  return parseRelayfileDelegatedTokenRequest(value, {
    permissions,
    normalizeRelayfileMountPaths,
  });
}

function delegationNotAfterFromNow(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

async function resolveRelayfileWorkspace(rawWorkspaceId: string): Promise<{
  relayfileWorkspaceId: string;
  permissions: WorkspacePermissions;
} | null> {
  const workspaceId = rawWorkspaceId.trim();
  if (!workspaceId) {
    return null;
  }
  if (!isValidWorkspaceId(workspaceId)) {
    return { relayfileWorkspaceId: workspaceId, permissions: DEFAULT_WORKSPACE_PERMISSIONS };
  }
  const { registry } = createCloudWorkspaceRegistry();
  const relayWorkspace = await registry.get(workspaceId);
  if (!relayWorkspace?.relayfileWorkspaceId) {
    return null;
  }
  return {
    relayfileWorkspaceId: relayWorkspace.relayfileWorkspaceId,
    permissions: relayWorkspace.permissions ?? DEFAULT_WORKSPACE_PERMISSIONS,
  };
}

async function hasWorkspaceAccess(rawWorkspaceId: string, auth: RequestAuth): Promise<boolean> {
  if (rawWorkspaceId === auth.workspaceId) {
    return true;
  }
  if (!isValidWorkspaceId(rawWorkspaceId)) {
    if (auth.source === "session") {
      return auth.context?.workspaces.some((workspace) => workspace.id === rawWorkspaceId) ?? false;
    }
    return false;
  }
  const binding = await resolveAppWorkspaceByRelayWorkspaceId(rawWorkspaceId).catch(() => ({
    appWorkspaceId: null,
    organizationId: null,
  }));
  if (!binding.appWorkspaceId) {
    return false;
  }
  if (auth.source === "session") {
    return auth.context?.workspaces.some((workspace) => workspace.id === binding.appWorkspaceId) ?? false;
  }
  return binding.appWorkspaceId === auth.workspaceId;
}

export async function POST(
  request: NextRequest,
  context: DelegatedTokenRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (
    auth.source === "relayfile" ||
    (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth"))
  ) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId: rawWorkspaceId } = await context.params;
  if (!await hasWorkspaceAccess(rawWorkspaceId, auth)) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  const relayfileWorkspace = await resolveRelayfileWorkspace(rawWorkspaceId);
  if (!relayfileWorkspace) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  const { relayfileWorkspaceId, permissions } = relayfileWorkspace;

  const body = parseBody(await readJsonBody(request), permissions);
  if (!body) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }
  if (!resolveRelayAuthConfig().relayAuthApiKey.trim()) {
    return jsonError(
      "RelayAuth API key is not configured",
      "relayauth_api_key_missing",
      500,
    );
  }

  try {
    let relayfileScopes = body.relayfileScopes;
    if (body.requestedScopes && body.relayfileMountPaths.length === 0) {
      const access = await createWorkspaceJoinAccess({
        workspaceId: relayfileWorkspaceId,
        agentName: body.agentName,
        requestedScopes: body.requestedScopes,
        permissions,
      });
      if (access.scopes.length === 0 || access.relayAuthTokenScopes.length === 0) {
        return jsonError("Invalid request body", "invalid_request", 400);
      }
      // Feed the strict RelayAuth `/v1/tokens/{workspace,agent}` chain the
      // 4-segment scopes (`relayfile:fs:read:*`, `relayfile:sync:trigger:*`,
      // …), NOT the daemon-vocabulary `tokenScopes` (bare `fs:read`, which
      // `parseScope` rejects → `insufficient_scope`).
      relayfileScopes = access.relayAuthTokenScopes;
    }

    const credentials = await mintRuntimeRelayfileCredentials({
      workspaceId: relayfileWorkspaceId,
      useRelayAuthApiKey: true,
      relayfileMountPaths: body.relayfileMountPaths,
      relayfileScopes,
      ttlSeconds: body.ttlSeconds,
      delegationNotAfter: delegationNotAfterFromNow(body.delegationTtlSeconds),
      agentName: body.agentName,
      agentId: body.agentId ?? body.agentName,
      auditLogger: logger,
    });

    return NextResponse.json(credentials);
  } catch (error) {
    const detail = errorMessage(error);
    logger.warn("Relayfile delegated token mint failed", {
      workspaceId: relayfileWorkspaceId,
      error: detail,
    });
    return jsonError(
      `RelayAuth mint failed: ${detail}`,
      "relayauth_mint_failed",
      502,
    );
  }
}
