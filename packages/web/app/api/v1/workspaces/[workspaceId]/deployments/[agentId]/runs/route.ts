import { NextRequest } from "next/server";
import { listDeploymentRuns } from "@/lib/proactive-runtime/deployment-run-observability";

type RouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workspaceId, agentId } = await params;
  return listDeploymentRuns(request, {
    workspaceId,
    agentId,
    requireWorkspaceAccess: true,
  });
}
