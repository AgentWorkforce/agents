import { NextRequest, NextResponse } from "next/server";
import { tryResourceValue } from "@/lib/env";
import { readInboxDeploymentCandidates } from "@/lib/proactive-runtime/inbox-dispatcher";

type CandidateRequest = {
  workspaceId?: unknown;
  selector?: unknown;
};

function hasInternalSecret(request: NextRequest): boolean {
  const expected = tryResourceValue("AgentGatewayInternalSecret")
    ?? process.env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
  const provided =
    request.headers.get("x-agent-gateway-secret")?.trim()
    ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return Boolean(expected && provided && expected === provided);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasInternalSecret(request)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as CandidateRequest | null;
  const workspaceId = readString(body?.workspaceId);
  const selector = readString(body?.selector);
  if (!workspaceId || !selector) {
    return NextResponse.json(
      { ok: false, error: "workspaceId and selector are required" },
      { status: 400 },
    );
  }

  const agents = await readInboxDeploymentCandidates({ workspaceId, selector });
  return NextResponse.json({
    ok: true,
    data: {
      agents: agents.map((agent) => ({
        agentId: agent.id,
        deployedName: agent.deployed_name,
        inboxSelectors: agent.inbox_selectors ?? [],
      })),
    },
  });
}
