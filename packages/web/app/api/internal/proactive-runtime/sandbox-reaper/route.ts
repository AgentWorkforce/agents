import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth/request-auth";
import { tryResourceValue } from "@/lib/env";
import { reapStoppedSandboxes } from "@/lib/proactive-runtime/deployment-sandbox-recycle";

type ReaperRequest = {
  minAgeHours?: unknown;
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

function readMinAgeHours(body: ReaperRequest | null): number | undefined {
  return typeof body?.minAgeHours === "number" && Number.isFinite(body.minAgeHours)
    ? Math.max(0, body.minAgeHours)
    : undefined;
}

function readClearLeases(body: ReaperRequest | null): boolean {
  return typeof body?.clearLeases === "boolean" ? body.clearLeases : true;
}

// Routine cleanup for old STOPPED proactive sandboxes. Unlike /pr-sandbox/drain,
// this never touches STARTED boxes; it only reaps stopped boxes older than the
// configured age threshold and skips boxes still protected by active PR leases.
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasRelaycronSecret(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as ReaperRequest | null;
  const result = await reapStoppedSandboxes({
    minAgeHours: readMinAgeHours(body),
    clearLeases: readClearLeases(body),
  });

  return NextResponse.json({ ok: true, data: result });
}
