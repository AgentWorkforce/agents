import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getAgentDeploymentTickTarget: vi.fn(),
  enqueueDeploymentTickDelivery: vi.fn(),
  readCloudflareWaitUntil: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
  requireAuthScope: mocks.requireAuthScope,
}));
vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));
vi.mock("@/lib/proactive-runtime/persona-deploy", () => ({
  getAgentDeploymentTickTarget: mocks.getAgentDeploymentTickTarget,
}));
vi.mock("@/lib/proactive-runtime/deployment-tick-deliveries", () => ({
  enqueueDeploymentTickDelivery: mocks.enqueueDeploymentTickDelivery,
}));
vi.mock("@/lib/proactive-runtime/cloudflare-waituntil", () => ({
  readCloudflareWaitUntil: mocks.readCloudflareWaitUntil,
}));

import { POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const agentId = "00000000-0000-0000-0000-000000000002";

function request(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/deployments/${agentId}/trigger`,
    { method: "POST" },
  );
}

function routeContext() {
  return { params: Promise.resolve({ workspaceId, agentId }) };
}

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    deployedName: "hn-monitor",
    deployedByUserId: "user-1",
    spec: null,
    agentSpec: { schedules: [{ name: "weekly", cron: "0 9 * * 1" }] },
    inputValues: {},
    credentialSelections: {},
    specHash: "hash",
    bundleSha256: "sha",
    personaSlug: "hn-monitor",
    status: "active",
    webhookSecretHash: "secret-hash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestAuth.mockResolvedValue({ userId: "user-1", workspaceId });
  mocks.requireSessionAuth.mockReturnValue(true);
  mocks.requireAuthScope.mockReturnValue(false);
  mocks.hasWorkspaceAccess.mockReturnValue(true);
  mocks.getAgentDeploymentTickTarget.mockResolvedValue(activeTarget());
  mocks.readCloudflareWaitUntil.mockReturnValue(() => {});
  let seq = 0;
  mocks.enqueueDeploymentTickDelivery.mockImplementation(async () => ({
    agentId,
    workspaceId,
    deploymentId: `deployment-${++seq}`,
    status: "starting" as const,
  }));
});

describe("POST /deployments/:agentId/trigger", () => {
  it("rejects unauthenticated callers", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(401);
    expect(mocks.enqueueDeploymentTickDelivery).not.toHaveBeenCalled();
  });

  it("rejects tokens without the write gate (session || cli:auth || deployments:write)", async () => {
    mocks.requireSessionAuth.mockReturnValueOnce(false);
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(403);
    expect(mocks.enqueueDeploymentTickDelivery).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace access", async () => {
    mocks.hasWorkspaceAccess.mockReturnValueOnce(false);
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(403);
    expect(mocks.getAgentDeploymentTickTarget).not.toHaveBeenCalled();
  });

  it("404s when the deployment target does not exist", async () => {
    mocks.getAgentDeploymentTickTarget.mockResolvedValueOnce(null);
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(404);
  });

  it("409s when the target is not active", async () => {
    mocks.getAgentDeploymentTickTarget.mockResolvedValueOnce(activeTarget({ status: "stopped" }));
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(409);
    expect(mocks.enqueueDeploymentTickDelivery).not.toHaveBeenCalled();
  });

  it("502s when the Cloudflare waitUntil context is unavailable", async () => {
    mocks.readCloudflareWaitUntil.mockReturnValueOnce(undefined);
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(502);
    expect(mocks.enqueueDeploymentTickDelivery).not.toHaveBeenCalled();
  });

  it("fires with an honest manual payload (contract-frozen: metadata rides in the payload)", async () => {
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      agentId,
      workspaceId,
      deploymentId: "deployment-1",
      status: "starting",
    });

    expect(mocks.enqueueDeploymentTickDelivery).toHaveBeenCalledOnce();
    const call = mocks.enqueueDeploymentTickDelivery.mock.calls[0][0];
    expect(call.payload).toMatchObject({
      type: "cron.tick",
      scheduleName: "manual",
      // first declared schedule name → runs table shows cron:manual:weekly
      scheduleId: "weekly",
      manual: true,
      triggeredByUserId: "user-1",
    });
    expect(typeof call.payload.occurredAt).toBe("string");
    // NO top-level envelope-field additions: the manual markers ride inside
    // the payload (→ envelope.resource via the payload fallback), so
    // ENVELOPE_FIELDS / the workforce contract copy stay frozen.
    expect(Object.keys(call.payload).sort()).toEqual(
      ["manual", "occurredAt", "scheduleId", "scheduleName", "triggeredByUserId", "type"],
    );
  });

  it("allows active-but-unscheduled agents with scheduleId 'manual' (server stance pinned)", async () => {
    mocks.getAgentDeploymentTickTarget.mockResolvedValueOnce(activeTarget({ agentSpec: { triggers: {} } }));
    const response = await POST(request(), routeContext());
    expect(response.status).toBe(202);
    expect(mocks.enqueueDeploymentTickDelivery.mock.calls[0][0].payload.scheduleId).toBe("manual");
  });

  it("double-fire negative control: two triggers enqueue two DISTINCT deployments", async () => {
    const first = await POST(request(), routeContext());
    const second = await POST(request(), routeContext());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const firstBody = await first.json();
    const secondBody = await second.json();
    // Each enqueue mints its own deployment row → unique
    // deployment-tick:<deploymentId> deliveryId → no ON CONFLICT merge with
    // each other or with scheduler fires.
    expect(firstBody.deploymentId).not.toBe(secondBody.deploymentId);
    expect(mocks.enqueueDeploymentTickDelivery).toHaveBeenCalledTimes(2);
  });
});
