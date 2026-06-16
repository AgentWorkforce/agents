import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenRow: null as null | {
    id: string;
    tokenHash: string;
    relayWorkspaceId: string;
    requestedName: string | null;
    capabilities: string[];
    maxAgents: number;
    tags: string[];
  },
  claimRows: [] as Array<null | {
    id: string;
    tokenHash: string;
    relayWorkspaceId: string;
    requestedName: string | null;
    capabilities: string[];
    maxAgents: number;
    tags: string[];
  }>,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({ kind: "and" })),
  eq: vi.fn(() => ({ kind: "eq" })),
  gt: vi.fn(() => ({ kind: "gt" })),
  isNull: vi.fn(() => ({ kind: "isNull" })),
  lt: vi.fn((column: unknown, value: unknown) => ({ kind: "lt", column, value })),
  or: vi.fn((...conditions: unknown[]) => ({ kind: "or", conditions })),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mocks.tokenRow ? [mocks.tokenRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updates.push(values);
        return {
          where: () => ({
            returning: async () => {
              if (values.claimNonce && values.claimedAt) {
                const claimed = mocks.claimRows.length > 0 ? mocks.claimRows.shift() : mocks.tokenRow;
                return claimed ? [claimed] : [];
              }
              if (Object.prototype.hasOwnProperty.call(values, "usedAt")) {
                return [{ id: mocks.tokenRow?.id ?? "enr_1" }];
              }
              return [{ id: mocks.tokenRow?.id ?? "enr_1" }];
            },
            then: (resolve: (value: { rowCount: number }) => void, reject: (reason?: unknown) => void) =>
              Promise.resolve({ rowCount: 1 }).then(resolve, reject),
          }),
        };
      },
    }),
  }),
}));

vi.mock("@/lib/db/schema", () => ({
  nodeEnrollmentTokens: {
    id: "node_enrollment_tokens.id",
    tokenHash: "node_enrollment_tokens.token_hash",
    expiresAt: "node_enrollment_tokens.expires_at",
    usedAt: "node_enrollment_tokens.used_at",
    claimNonce: "node_enrollment_tokens.claim_nonce",
    claimedAt: "node_enrollment_tokens.claimed_at",
  },
  workspaces: {
    id: "workspaces.id",
    relayWorkspaceId: "workspaces.relay_workspace_id",
  },
}));

vi.mock("@/lib/relay-workspaces", () => ({
  getRelayWorkspace: vi.fn(async () => ({
    id: "rw_test",
    relaycastApiKey: "rk_live_workspace",
  })),
}));

vi.mock("@/lib/workflows/relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: vi.fn(),
}));

vi.mock("@/lib/workspace-registry", () => ({
  resolveRelaycastUrl: () => "https://relaycast.test/",
}));

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("fleet node enrollment helpers", () => {
  afterEach(() => {
    mocks.tokenRow = null;
    mocks.claimRows = [];
    mocks.updates = [];
    vi.unstubAllGlobals();
  });

  it("builds an agent-relay fleet serve command with shell-safe arguments", async () => {
    const { buildFleetEnrollCommand } = await import("./nodes");

    expect(buildFleetEnrollCommand({
      enrollmentToken: "ocl_node_enr_abc'123",
      enrollmentUrl: "https://cloud.test/api/v1/fleet/register",
      name: "daytona node",
    })).toBe(
      "agent-relay fleet serve --enrollment-token 'ocl_node_enr_abc'\\''123' --enrollment-url 'https://cloud.test/api/v1/fleet/register' --name 'daytona node'",
    );
  });

  it("redeems a one-time enrollment token into a relaycast node token", async () => {
    const enrollmentToken = "ocl_node_enr_testtoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      relayWorkspaceId: "rw_test",
      requestedName: "requested-node",
      capabilities: ["spawn"],
      maxAgents: 4,
      tags: ["daytona"],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://relaycast.test/v1/nodes");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rk_live_workspace");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "runtime-node",
        capabilities: ["spawn", "github.pr.review"],
        max_agents: 6,
        tags: ["sandbox"],
        version: "agent-relay-test",
      });
      return Response.json({
        ok: true,
        data: {
          id: "node_1",
          name: "runtime-node",
          token: "nt_live_node_token",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");

    await expect(redeemNodeEnrollmentToken({
      enrollmentToken,
      name: "runtime-node",
      capabilities: ["spawn", "github.pr.review"],
      maxAgents: 6,
      tags: ["sandbox"],
      version: "agent-relay-test",
      ip: "203.0.113.4",
    })).resolves.toEqual({
      nodeId: "node_1",
      nodeName: "runtime-node",
      nodeToken: "nt_live_node_token",
      relayWorkspaceId: "rw_test",
      relaycastUrl: "https://relaycast.test",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.updates[0]?.claimNonce).toEqual(expect.any(String));
    expect(mocks.updates[0]?.claimedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.usedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.usedFromIp).toBe("203.0.113.4");
    expect(mocks.updates.at(-1)?.claimNonce).toBeNull();
  });

  it("only lets one concurrent redeem claim and mint a node token", async () => {
    const enrollmentToken = "ocl_node_enr_racetoken";
    const tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      relayWorkspaceId: "rw_test",
      requestedName: "race-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    mocks.tokenRow = tokenRow;
    mocks.claimRows = [tokenRow, null];
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { id: "node_1", name: "race-node", token: "nt_live_node_token" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    const results = await Promise.allSettled([
      redeemNodeEnrollmentToken({ enrollmentToken }),
      redeemNodeEnrollmentToken({ enrollmentToken }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the enrollment claim when relaycast minting fails", async () => {
    const enrollmentToken = "ocl_node_enr_retrytoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      relayWorkspaceId: "rw_test",
      requestedName: "retry-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503, statusText: "Unavailable" })));

    const { redeemNodeEnrollmentToken } = await import("./nodes");

    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).rejects.toThrow("Relaycast node enrollment failed");
    expect(mocks.updates.at(-1)).toMatchObject({ claimNonce: null, claimedAt: null });
  });

  it("guards the claim with a TTL-based stale-reclaim condition so a crash mid-mint cannot brick the token", async () => {
    const enrollmentToken = "ocl_node_enr_staletoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      relayWorkspaceId: "rw_test",
      requestedName: "stale-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true, data: { id: "node_1", name: "stale-node", token: "nt_live_node_token" } }),
      ),
    );

    const { lt, or, isNull } = await import("drizzle-orm");
    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await redeemNodeEnrollmentToken({ enrollmentToken });

    // The claim CAS must allow EITHER an unclaimed token OR one whose prior claim
    // has gone stale — otherwise a redeemer that crashed after claiming but before
    // burning would brick the token permanently (claim_nonce stays set forever).
    expect(or).toHaveBeenCalled();
    expect(isNull).toHaveBeenCalledWith("node_enrollment_tokens.claim_nonce");
    expect(lt).toHaveBeenCalledWith("node_enrollment_tokens.claimed_at", expect.any(Date));
  });
});
