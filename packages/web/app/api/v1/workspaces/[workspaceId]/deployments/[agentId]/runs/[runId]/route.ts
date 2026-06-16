import { NextRequest } from "next/server";
import { getDeploymentRun } from "@/lib/proactive-runtime/deployment-run-observability";

type RouteContext = {
  params: Promise<{ workspaceId: string; agentId: string; runId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workspaceId, agentId, runId } = await params;
  return getDeploymentRun(request, {
    workspaceId,
    agentId,
    runId,
    requireWorkspaceAccess: true,
  });
}
