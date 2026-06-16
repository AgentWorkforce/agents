import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import {
  PersonaDeployError,
  destroyAgent,
} from "@/lib/proactive-runtime/persona-deploy";
import { jsonError, type ErrorResponse } from "../../sandboxes/sandbox-utils";

type DestroyRouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

type DestroyResponse = {
  agentId: string;
  status: "destroyed";
  destroyedAt: string;
  cancelledScheduleIds: string[];
};

function canDestroy(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

function errorResponse(
  error: unknown,
): NextResponse<ErrorResponse | { error: string; code: string; details?: unknown }> {
  if (error instanceof PersonaDeployError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }

  console.error(
    "[persona-bundle-destroy] request failed:",
    error instanceof Error ? error.message : String(error),
  );
  return NextResponse.json(
    { error: "Failed to destroy agent", code: "destroy_failed" },
    { status: 500 },
  );
}

export async function DELETE(
  request: NextRequest,
  context: DestroyRouteContext,
): Promise<
  NextResponse<
    DestroyResponse | ErrorResponse | { error: string; code: string; details?: unknown }
  >
> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canDestroy(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId, agentId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  if (!agentId) {
    return jsonError("Agent not found", "agent_not_found", 404);
  }
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  try {
    const result = await destroyAgent({
      workspaceId,
      agentId,
      userId: auth.userId,
    });
    if (!result) {
      return jsonError("Agent not found", "agent_not_found", 404);
    }

    return NextResponse.json<DestroyResponse>(
      {
        agentId: result.agentId,
        status: "destroyed",
        destroyedAt: result.destroyedAt.toISOString(),
        cancelledScheduleIds: result.cancelledScheduleIds,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
