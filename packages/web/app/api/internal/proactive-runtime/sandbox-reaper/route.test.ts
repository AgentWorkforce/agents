import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reapStoppedSandboxes: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/proactive-runtime/deployment-sandbox-recycle", () => ({
  reapStoppedSandboxes: mocks.reapStoppedSandboxes,
}));

const REAPER_URL =
  "https://cloud.test/api/internal/proactive-runtime/sandbox-reaper";

describe("stopped sandbox reaper route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue("relaycron-key");
    mocks.reapStoppedSandboxes.mockResolvedValue({
      found: 3,
      eligible: 2,
      deleted: 2,
      failed: [],
      skippedTooYoung: 1,
      skippedMissingCreatedAt: 0,
      skippedActiveLease: 0,
      releasedFound: 0,
      releasedDeleted: 0,
      releasedFailed: [],
      releasedSkippedActiveRun: 0,
      leasesCleared: 2,
    });
  });

  it("authenticates relaycron and runs the stopped-box reaper", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(REAPER_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        found: 3,
        eligible: 2,
        deleted: 2,
        failed: [],
        skippedTooYoung: 1,
        skippedMissingCreatedAt: 0,
        skippedActiveLease: 0,
        releasedFound: 0,
        releasedDeleted: 0,
        releasedFailed: [],
        releasedSkippedActiveRun: 0,
        leasesCleared: 2,
      },
    });
    expect(mocks.reapStoppedSandboxes).toHaveBeenCalledWith({
      minAgeHours: undefined,
      clearLeases: true,
    });
  });

  it("forwards explicit options", async () => {
    const { POST } = await import("./route");

    await POST(
      new Request(REAPER_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ minAgeHours: 8, clearLeases: false }),
      }) as never,
    );

    expect(mocks.reapStoppedSandboxes).toHaveBeenCalledWith({
      minAgeHours: 8,
      clearLeases: false,
    });
  });

  it("rejects unauthenticated reaper requests", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(REAPER_URL, { method: "POST" }) as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.reapStoppedSandboxes).not.toHaveBeenCalled();
  });
});
