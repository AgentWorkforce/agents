import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth/request-auth";
import { tryResourceValue } from "@/lib/env";
import {
  drainDeploymentTickDeliveries,
} from "@/lib/proactive-runtime/deployment-tick-deliveries";

type SweepRequest = {
  limit?: unknown;
};

const DEFAULT_SWEEP_LIMIT = 3;
const MAX_SWEEP_LIMIT = 6;
// Preserve the same bounded sweep window as the integration-watch queue: we
// want a fresh 202'd tick to drain, but not to backfill ancient rows forever.
const SWEEP_MAX_DELIVERY_AGE_SECONDS = 60 * 60;
const SWEEP_DELIVERY_OPTIONS = {
  sandboxCreateTimeoutSeconds: 120,
  runScriptTimeoutMs: 15_000,
  asyncRunScript: true,
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

function readLimit(body: SweepRequest | null): number {
  const limit = body?.limit;
  if (!Number.isInteger(limit) || typeof limit !== "number") {
    return DEFAULT_SWEEP_LIMIT;
  }
  return Math.min(Math.max(limit, 1), MAX_SWEEP_LIMIT);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!hasRelaycronSecret(request)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => null)) as SweepRequest | null;
  const result = await drainDeploymentTickDeliveries({
    limit: readLimit(body),
    maxDeliveryAgeSeconds: SWEEP_MAX_DELIVERY_AGE_SECONDS,
    deliveryOptions: SWEEP_DELIVERY_OPTIONS,
  });

  return NextResponse.json({ ok: true, data: result });
}
