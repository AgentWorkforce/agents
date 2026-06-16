import { NextRequest } from "next/server";
import { getDeploymentRunEnvelope } from "@/lib/proactive-runtime/deployment-run-observability";

type RouteContext = {
  params: Promise<{ workspaceId: string; agentId: string; runId: string }>;
};

// GET /runs/:runId/envelope (cloud#1841): the byte-exact gateway envelope
// delivered to this run — the replayable `agentworkforce invoke --fixture`
// input (workforce#189). Persisted raw, redacted on read; see
// getDeploymentRunEnvelope for the redaction decision.
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workspaceId, agentId, runId } = await params;
  return getDeploymentRunEnvelope(request, {
    workspaceId,
    agentId,
    runId,
    requireWorkspaceAccess: true,
  });
}
