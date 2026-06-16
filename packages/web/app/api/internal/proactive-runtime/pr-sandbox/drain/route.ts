import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth/request-auth";
import { tryResourceValue } from "@/lib/env";
import { drainPrSandboxWarmPool } from "@/lib/proactive-runtime/deployment-sandbox-recycle";

type DrainRequest = {
  clearLeases?: unknown;
};

function hasRelaycronSecret(request: NextRequest): boolean {
  const expected =
    tryResourceValue("RelaycronApiKey") ??
    process.env.RELAYCRON_API_KEY?.trim();
  const provided = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  return Boolean(expected && provided && constantTimeEqual(provided, expected));
}

function readClearLeases(body: DrainRequest | null): boolean {
  return typeof body?.clearLeases === "boolean" ? body.clearLeases : true;
}

// One-call drain of the proactive PR warm pool: destroys every STARTED box
// carrying the warm-pool labels so subsequent fires re-provision fresh from the
// current Daytona snapshot. The release fallback for a RELAYFILE_MOUNT_VERSION
// bump when the snapshot-version-aware lease gate is not yet deployed. This is a
// DELIBERATE recycle — a mid-delivery box will be destroyed (acceptable for a
// release recycle; pre-fix runs are failing anyway). Authed with RelaycronApiKey
// (same gate as the integration-watch sweep route).
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasRelaycronSecret(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as DrainRequest | null;
  const result = await drainPrSandboxWarmPool({ clearLeases: readClearLeases(body) });

  return NextResponse.json({ ok: true, data: result });
}
