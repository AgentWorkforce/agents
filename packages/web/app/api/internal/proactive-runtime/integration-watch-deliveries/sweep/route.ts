import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/auth/request-auth";
import { tryResourceValue } from "@/lib/env";
import {
  drainIntegrationWatchDeliveries,
  sweepCoalescedIssueDispatchRedispatches,
} from "@/lib/proactive-runtime/integration-watch-deliveries";

type SweepRequest = {
  limit?: unknown;
};

const DEFAULT_SWEEP_LIMIT = 3;
const MAX_SWEEP_LIMIT = 6;
// The default retry curve reaches terminal maxAttempts in under 15 minutes.
// One hour preserves transient inline-failure recovery while preventing a
// first deploy of this sweep from backfilling multi-hour-old webhook probes.
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
  // #1516 Bug 1 — cooldown trailing edge. Re-fire any PR-context dispatches that
  // were suppressed by the issue-dispatch cooldown and whose window has since
  // expired, enqueuing exactly one coalesced re-dispatch per (workspace, issue,
  // agent) so a reviewer who commented inside the window (e.g. cubic) isn't
  // permanently dropped. Runs BEFORE the drain so the re-enqueued deliveries are
  // claimed in this same relaycron tick. Best-effort: never blocks the drain.
  const coalescedRedispatched = await sweepCoalescedIssueDispatchRedispatches({});
  const result = await drainIntegrationWatchDeliveries({
    limit: readLimit(body),
    maxDeliveryAgeSeconds: SWEEP_MAX_DELIVERY_AGE_SECONDS,
    deliveryOptions: SWEEP_DELIVERY_OPTIONS,
    allowTeamLaunchN1: true,
  });

  return NextResponse.json({ ok: true, data: { ...result, coalescedRedispatched } });
}
