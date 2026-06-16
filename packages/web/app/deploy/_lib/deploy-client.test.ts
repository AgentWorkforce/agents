import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelCredentialSelection,
  hasActiveSubscriptionCredential,
  providerCredentialConnectCommand,
} from "./deploy-client";
import type { HarnessSource, PersonaSummary } from "./types";

const persona = {
  name: "Test Persona",
  slug: "test-persona",
  harness: "claude",
  modelProvider: "anthropic",
} as unknown as PersonaSummary;

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string) => { status?: number; payload?: unknown }) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const result = handler(url);
      return new Response(JSON.stringify(result.payload ?? {}), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

function selection(harnessSource: HarnessSource, byokKey = "") {
  return createModelCredentialSelection({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    persona,
    harnessSource,
    byokKey,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createModelCredentialSelection — active credential default", () => {
  it("uses the active connected credential instead of minting a managed one", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              { id: "cred-inactive", modelProvider: "anthropic", isActive: false, status: "connected" },
              { id: "cred-active", modelProvider: "anthropic", isActive: true, status: "connected" },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-active" });
    expect(calls).toHaveLength(1); // no POST to /provider-credentials/managed
  });

  it("falls back to the managed endpoint when no active credential exists", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return { payload: { agents: [] } };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-managed" });
    expect(calls.map((call) => call.url)).toHaveLength(2);
  });

  it("ignores an active credential that is not connected", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{ id: "cred-dead", modelProvider: "anthropic", isActive: true, status: "failed" }],
          },
        };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-managed" });
  });

  it("byok with a typed key always mints new material, even with an active credential", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/provider-credentials/byok")) {
        return { status: 201, payload: { providerCredentialId: "cred-byok" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("byok", "sk-ant-explicit")).resolves.toEqual({ anthropic: "cred-byok" });
    // active lookup is skipped entirely for explicit byok material
    expect(calls.every((call) => !call.url.includes("/api/v1/cloud-agents"))).toBe(true);
  });

  it("oauth source uses the active credential when present", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-oauth",
              modelProvider: "anthropic",
              authType: "provider_oauth",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("oauth")).resolves.toEqual({ anthropic: "cred-oauth" });
  });

  it("oauth source ignores an active BYOK credential", async () => {
    const openaiPersona = {
      ...persona,
      harness: "codex",
      modelProvider: "openai",
      useSubscription: true,
    } as PersonaSummary;
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-byok",
                modelProvider: "openai",
                authType: "byo_api_key",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(createModelCredentialSelection({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      persona: openaiPersona,
      harnessSource: "oauth",
      byokKey: "",
    })).rejects.toThrow(/npx agent-relay cloud connect openai/);
  });

  it("oauth source stamps the active OpenAI subscription credential selection", async () => {
    const openaiPersona = {
      ...persona,
      harness: "codex",
      modelProvider: "openai",
      useSubscription: true,
    } as PersonaSummary;
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-oauth",
                modelProvider: "openai",
                authType: "provider_oauth",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(createModelCredentialSelection({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      persona: openaiPersona,
      harnessSource: "oauth",
      byokKey: "",
    })).resolves.toEqual({ openai: "cred-openai-oauth" });
  });

  it("oauth source without an active credential throws an actionable error", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return { payload: { agents: [] } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("oauth")).rejects.toThrow(/npx agent-relay cloud connect anthropic/);
  });

  it("reports whether an active subscription credential exists", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-oauth",
                modelProvider: "openai",
                authType: "provider_oauth",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(hasActiveSubscriptionCredential("openai")).resolves.toBe(true);
    await expect(hasActiveSubscriptionCredential("anthropic")).resolves.toBe(false);
  });

  it("builds the cloud connect command with a safe provider fallback", () => {
    expect(providerCredentialConnectCommand("openai")).toBe("npx agent-relay cloud connect openai");
    expect(providerCredentialConnectCommand("Bad Provider!")).toBe("npx agent-relay cloud connect openai");
  });

  it("falls through to the endpoint flow when the active lookup fails", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return { status: 500, payload: { error: "boom" } };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-managed" });
  });
});
