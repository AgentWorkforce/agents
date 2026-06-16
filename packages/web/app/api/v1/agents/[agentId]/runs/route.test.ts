import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getDb: vi.fn(),
  db: {
    execute: vi.fn(),
  },
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: (auth: { source?: string }) => auth.source === "session",
  requireAuthScope: (auth: { scopes?: string[] }, scope: string) => auth.scopes?.includes(scope) ?? false,
  requireAuthRunAccess: (auth: { source?: string; runId?: string | null } | null, runId: string) =>
    auth?.source === "session" || auth?.runId == null || auth.runId === runId,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

import { GET as GET_LEGACY_DEPLOYMENT_RUN } from "./[runId]/route";
import { GET as GET_LEGACY_DEPLOYMENT_RUNS } from "./route";
import { GET as GET_WORKSPACE_DEPLOYMENT_RUNS } from "../../../workspaces/[workspaceId]/deployments/[agentId]/runs/route";
import { GET as GET_WORKSPACE_DEPLOYMENT_RUN } from "../../../workspaces/[workspaceId]/deployments/[agentId]/runs/[runId]/route";
import { GET as GET_WORKSPACE_DEPLOYMENT_RUN_ENVELOPE } from "../../../workspaces/[workspaceId]/deployments/[agentId]/runs/[runId]/envelope/route";

const workspaceId = "00000000-0000-0000-0000-000000000001";
const otherWorkspaceId = "00000000-0000-0000-0000-000000000099";
const agentId = "00000000-0000-0000-0000-000000000002";
const runId = "00000000-0000-0000-0000-000000000003";
const deploymentId = "00000000-0000-0000-0000-000000000004";

const auth = {
  source: "token" as const,
  userId: "00000000-0000-0000-0000-000000000005",
  workspaceId,
  scopes: ["deployments:read"],
};

function request(path: string) {
  return new NextRequest(`https://cloud.test${path}`);
}

function legacyListContext() {
  return { params: Promise.resolve({ agentId }) };
}

function legacyDetailContext() {
  return { params: Promise.resolve({ agentId, runId }) };
}

function workspaceListContext(overrides: Partial<{ workspaceId: string; agentId: string }> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: overrides.workspaceId ?? workspaceId,
      agentId: overrides.agentId ?? agentId,
    }),
  };
}

function workspaceDetailContext(
  overrides: Partial<{ workspaceId: string; agentId: string; runId: string }> = {},
) {
  return {
    params: Promise.resolve({
      workspaceId: overrides.workspaceId ?? workspaceId,
      agentId: overrides.agentId ?? agentId,
      runId: overrides.runId ?? runId,
    }),
  };
}

function sqlText(value: unknown): string {
  if (value && typeof value === "object" && "toQuery" in value && typeof value.toQuery === "function") {
    return value.toQuery({
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (_index: number, param: unknown) => String(param),
      escapeString: (text: string) => `'${text}'`,
    }).sql;
  }
  if (!value || typeof value !== "object" || !("queryChunks" in value)) {
    return "";
  }
  return ((value as { queryChunks: unknown[] }).queryChunks)
    .map((chunk) => {
      if (typeof chunk === "string") {
        return chunk;
      }
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value);
      }
      return String(chunk);
    })
    .join("");
}

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: runId,
    deployment_id: deploymentId,
    agent_id: agentId,
    trigger_kind: "clock",
    event_source: "cron:weekly:sched_123",
    sandbox_id: "sbx_123",
    sandbox_name: "weekly-digest",
    stdout_truncated: true,
    stderr_truncated: false,
    exit_code: 0,
    cleanup_status: { scriptCompleted: true, flushExitCode: 0 },
    started_at: new Date("2026-05-22T10:00:00.000Z"),
    ended_at: new Date("2026-05-22T10:00:03.000Z"),
    duration_ms: 3000,
    status: "succeeded",
    error: null,
    summary: null,
    compressed_at: null,
    input_tokens: "1200",
    output_tokens: "340",
    cache_read_tokens: "50",
    cache_write_tokens: "10",
    total_tokens: "1600",
    agent_total_tokens: "1900",
    ...overrides,
  };
}

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    ...listRow({
      trigger_kind: "inbox",
      event_source: "linear:issue.updated",
      sandbox_name: "triage",
      exit_code: 1,
      status: "failed",
      error: "runtime failed",
      duration_ms: 2000,
      started_at: "2026-05-22T11:00:00.000Z",
      ended_at: "2026-05-22T11:00:02.000Z",
      stdout_truncated: false,
      stderr_truncated: true,
      cleanup_status: { scriptCompleted: true, flushExitCode: 1 },
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      agent_total_tokens: 0,
    }),
    stdout: "stdout tail",
    stderr: "stderr tail",
    mount_log_tail: "mount diagnostics",
    ...overrides,
  };
}

describe("agent deployment run observability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.getDb.mockReturnValue(mocks.db);
  });

  it("keeps legacy run-list responses byte-identical to the canonical workspace default shape", async () => {
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [listRow()] })
      .mockResolvedValueOnce({ rows: [listRow()] });

    const legacyResponse = await GET_LEGACY_DEPLOYMENT_RUNS(
      request(`/api/v1/agents/${agentId}/runs?limit=250`),
      legacyListContext(),
    );
    const workspaceResponse = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs?limit=250`),
      workspaceListContext(),
    );

    expect(legacyResponse.status).toBe(200);
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toEqual(await legacyResponse.json());

    const query = sqlText(mocks.db.execute.mock.calls[0][0]);
    expect(query).toContain("a.workspace_id");
    expect(query).toContain("a.status != 'destroyed'");
    expect(query).toContain("harness_spend_events");
    expect(query).toContain("ORDER BY adr.started_at DESC");
    expect(query).toContain("LIMIT 100");
  });

  it("lists recent deployment runs with the existing UI-friendly payload", async () => {
    mocks.db.execute.mockResolvedValueOnce({ rows: [listRow()] });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs?limit=50`),
      workspaceListContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentId,
      runs: [{
        id: runId,
        deploymentId,
        agentId,
        eventSource: "cron:weekly:sched_123",
        sandboxId: "sbx_123",
        sandboxName: "weekly-digest",
        stdoutTruncated: true,
        stderrTruncated: false,
        exitCode: 0,
        cleanupStatus: { scriptCompleted: true, flushExitCode: 0 },
        startedAt: "2026-05-22T10:00:00.000Z",
        endedAt: "2026-05-22T10:00:03.000Z",
        durationMs: 3000,
        status: "succeeded",
        error: null,
        summary: null,
        compressedAt: null,
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        totalTokens: 1600,
      }],
      totalTokens: 1900,
    });
  });

  it("supports compact agent-consumable list responses and filters", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [
        listRow({
          exit_code: 1,
          status: "failed",
          error: "agent has no persisted bundle; redeploy under cold-start runtime",
        }),
      ],
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(
        `/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs?format=compact&status=failed&from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z&triggerKind=clock&eventSource=cron:weekly:sched_123`,
      ),
      workspaceListContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      agentId,
      origin: "hosted",
      runs: [{
        runId,
        deploymentId,
        agentId,
        status: "failed",
        exitCode: 1,
        summary: null,
        error: "agent has no persisted bundle; redeploy under cold-start runtime",
        startedAt: "2026-05-22T10:00:00.000Z",
        endedAt: "2026-05-22T10:00:03.000Z",
        durationMs: 3000,
        trigger: {
          kind: "clock",
          eventSource: "cron:weekly:sched_123",
        },
        sandbox: {
          id: "sbx_123",
          name: "weekly-digest",
        },
        failureClass: "bundle_unavailable",
        origin: "hosted",
      }],
    });
    const query = sqlText(mocks.db.execute.mock.calls[0][0]);
    expect(query).toContain("adr.status =");
    expect(query).toContain("d.trigger_kind =");
    expect(query).toContain("adr.event_source =");
    expect(query).toContain("adr.started_at >=");
    expect(query).toContain("adr.started_at <=");
  });

  it("keeps legacy run-detail responses byte-identical to canonical workspace default shape", async () => {
    mocks.db.execute
      .mockResolvedValueOnce({ rows: [detailRow()] })
      .mockResolvedValueOnce({ rows: [detailRow()] });

    const legacyResponse = await GET_LEGACY_DEPLOYMENT_RUN(
      request(`/api/v1/agents/${agentId}/runs/${runId}`),
      legacyDetailContext(),
    );
    const workspaceResponse = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}`),
      workspaceDetailContext(),
    );

    expect(legacyResponse.status).toBe(200);
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toEqual(await legacyResponse.json());
    expect(sqlText(mocks.db.execute.mock.calls[0][0])).toContain("AND adr.id");
  });

  it("returns compact run details with logs and failure class", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [detailRow({
        cleanup_status: { scriptCompleted: true, flushExitCode: 0 },
        mount_log_tail: "relayfile-mount diagnostics",
      })],
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}?format=compact`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      run: {
        runId,
        deploymentId,
        agentId,
        status: "failed",
        exitCode: 1,
        summary: null,
        error: "runtime failed",
        startedAt: "2026-05-22T11:00:00.000Z",
        endedAt: "2026-05-22T11:00:02.000Z",
        durationMs: 2000,
        trigger: {
          kind: "inbox",
          eventSource: "linear:issue.updated",
        },
        sandbox: {
          id: "sbx_123",
          name: "triage",
        },
        failureClass: "mount_failure",
        origin: "hosted",
        entries: [],
        logs: {
          stdout: "stdout tail",
          stderr: "stderr tail",
          mountLogTail: "relayfile-mount diagnostics",
          stdoutTruncated: false,
          stderrTruncated: true,
        },
      },
    });
  });

  it("returns parsed structured stdout entries on run details", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [detailRow({
        stdout: [
          "plain handler noise",
          JSON.stringify({
            t: "2026-06-03T22:21:09.773Z",
            level: "info",
            message: "runner.started",
            source: "system",
            durationMs: 915,
          }),
          JSON.stringify({
            t: "2026-06-03T22:21:09.782Z",
            level: "error",
            message: "runner.handler.error",
            source: "handler",
            error: "boom",
          }),
        ].join("\n"),
      })],
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        entries: [
          {
            id: `${runId}:0`,
            timestamp: "2026-06-03T22:21:09.773Z",
            level: "info",
            source: "system",
            message: "runner.started",
            durationMs: 915,
            stream: "runner",
            payload: {
              workspace: workspaceId,
              agentId,
              deploymentId,
              eventSource: "linear:issue.updated",
              sandboxId: "sbx_123",
              source: "system",
              durationMs: 915,
            },
          },
          {
            id: `${runId}:1`,
            timestamp: "2026-06-03T22:21:09.782Z",
            level: "error",
            source: "handler",
            message: "runner.handler.error",
            durationMs: null,
            stream: "runner",
            payload: {
              workspace: workspaceId,
              agentId,
              deploymentId,
              eventSource: "linear:issue.updated",
              sandboxId: "sbx_123",
              source: "handler",
              error: "boom",
            },
          },
        ],
      },
    });
  });

  it("returns the retention summary as visible output for compressed runs", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [detailRow({
        stdout: null,
        stderr: null,
        mount_log_tail: null,
        stdout_truncated: true,
        stderr_truncated: true,
        summary: "failed (exit 1) in 2.0 s - error: runtime failed",
        compressed_at: "2026-05-23T00:00:00.000Z",
      })],
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      run: {
        stdout: "failed (exit 1) in 2.0 s - error: runtime failed",
        stderr: "",
        mountLogTail: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        summary: "failed (exit 1) in 2.0 s - error: runtime failed",
        compressedAt: "2026-05-23T00:00:00.000Z",
      },
    });
  });

  it("rejects unauthenticated run list requests", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs`),
      workspaceListContext(),
    );

    expect(response.status).toBe(401);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("rejects tokens that lack deployment read scopes", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({ ...auth, scopes: [] });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs`),
      workspaceListContext(),
    );

    expect(response.status).toBe(403);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("rejects workspace route access outside the authenticated workspace", async () => {
    mocks.hasWorkspaceAccess.mockReturnValueOnce(false);

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(`/api/v1/workspaces/${otherWorkspaceId}/deployments/${agentId}/runs`),
      workspaceListContext({ workspaceId: otherWorkspaceId }),
    );

    expect(response.status).toBe(403);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("allows session-authenticated run list requests without token scopes", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({ ...auth, source: "session", scopes: [] });
    mocks.db.execute.mockResolvedValueOnce({ rows: [] });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs`),
      workspaceListContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.db.execute).toHaveBeenCalledOnce();
  });

  it("returns not found when the run id is outside the workspace or agent", async () => {
    mocks.db.execute.mockResolvedValueOnce({ rows: [] });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(404);
  });

  it("rejects detail reads from tokens bound to a different run id", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      runId: "00000000-0000-0000-0000-000000000099",
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });

  it("allows detail reads from tokens bound to the requested run id", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      runId,
    });
    mocks.db.execute.mockResolvedValueOnce({ rows: [detailRow()] });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.db.execute).toHaveBeenCalledOnce();
  });

  it("returns captured run envelopes parsed and redacted on read", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [{
        envelope: JSON.stringify({
          id: "evt_123",
          type: "github.pull_request.opened",
          resource: {
            cloneUrl: "https://x-access-token:ghp_123456789012345678901234567890123456@github.com/acme/cloud.git",
          },
        }),
        envelope_omitted: false,
      }],
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN_ENVELOPE(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}/envelope`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      captured: true,
      omitted: false,
      envelope: {
        id: "evt_123",
        type: "github.pull_request.opened",
        resource: {
          cloneUrl: "https://x-access-token:[REDACTED]@github.com/acme/cloud.git",
        },
      },
    });
    expect(sqlText(mocks.db.execute.mock.calls[0][0])).toContain("adr.envelope");
  });

  it("reports omitted run envelopes without fabricating a fixture", async () => {
    mocks.db.execute.mockResolvedValueOnce({
      rows: [{
        envelope: null,
        envelope_omitted: true,
      }],
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN_ENVELOPE(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}/envelope`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      captured: false,
      omitted: true,
      envelope: null,
    });
  });

  it("rejects envelope reads from tokens bound to a different run id", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      ...auth,
      runId: "00000000-0000-0000-0000-000000000099",
    });

    const response = await GET_WORKSPACE_DEPLOYMENT_RUN_ENVELOPE(
      request(`/api/v1/workspaces/${workspaceId}/deployments/${agentId}/runs/${runId}/envelope`),
      workspaceDetailContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });
});
