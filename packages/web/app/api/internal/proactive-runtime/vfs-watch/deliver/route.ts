import { NextRequest, NextResponse } from "next/server";
import { tryResourceValue } from "@/lib/env";
import {
  deliverDeploymentTrigger,
  DeploymentTriggerDeliveryError,
} from "@/lib/proactive-runtime/deployment-trigger-delivery";

type DeliverRequest = {
  workspaceId?: unknown;
  agentId?: unknown;
  payload?: unknown;
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

  const body = await request.json().catch(() => null) as DeliverRequest | null;
  const workspaceId = readString(body?.workspaceId);
  const agentId = readString(body?.agentId);
  if (!workspaceId || !agentId) {
    return NextResponse.json(
      { ok: false, error: "workspaceId and agentId are required" },
      { status: 400 },
    );
  }

  try {
    const result = await deliverDeploymentTrigger({
      workspaceId,
      agentId,
      payload: body?.payload ?? {},
    });
    return NextResponse.json({ ok: true, data: result }, { status: 202 });
  } catch (error) {
    if (error instanceof DeploymentTriggerDeliveryError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "delivery failed",
      },
      { status: 502 },
    );
  }
}
