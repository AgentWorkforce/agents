import { describe, expect, it, vi } from "vitest";

import worker from "../index.js";

type StoredEntry = { value: string };

class MemoryKV {
  readonly store = new Map<string, StoredEntry>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, { value });
  }
}

function asKV(kv: MemoryKV): KVNamespace {
  return kv as unknown as KVNamespace;
}

type WorkerBinding = { fetch: ReturnType<typeof vi.fn> };

function makeBinding(): WorkerBinding {
  return {
    fetch: vi.fn(async () => new Response("ok", { status: 200 })),
  };
}

function buildEnv(opts: {
  webhookOriginFlag?: string;
  cloudWebWorker?: WorkerBinding;
  webhookWorker?: WorkerBinding;
}) {
  const routerConfig = new MemoryKV();
  if (opts.webhookOriginFlag !== undefined) {
    routerConfig.store.set("WEBHOOK_ORIGIN", { value: opts.webhookOriginFlag });
  }
  return {
    CLOUD_APP_ORIGIN: "https://origin.test.invalid",
    ROUTER_CONFIG: asKV(routerConfig),
    CLOUD_WEB_WORKER: opts.cloudWebWorker,
    WEBHOOK_WORKER: opts.webhookWorker,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function buildCtx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
}

describe("router webhook routing", () => {
  it("routes /api/v1/webhooks/nango to the webhook-worker binding when WEBHOOK_ORIGIN=worker", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "worker",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(webhookWorker.fetch).toHaveBeenCalledOnce();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();
  });

  it("bypasses webhook-worker when request carries x-cloud-webhook-worker-forwarded header (loop break)", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "worker",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-webhook-worker-forwarded": "webhook-worker",
          "x-cloud-webhook-worker-request-id": "req-loop-1",
        },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
  });

  it("ignores the loop-break header for an unrelated value (don't accidentally widen bypass)", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      webhookOriginFlag: "worker",
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cloud-webhook-worker-forwarded": "something-else",
        },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(webhookWorker.fetch).toHaveBeenCalledOnce();
    expect(cloudWebWorker.fetch).not.toHaveBeenCalled();
  });

  it("routes to cloud-web when WEBHOOK_ORIGIN flag is unset (regression: still works without flag)", async () => {
    const cloudWebWorker = makeBinding();
    const webhookWorker = makeBinding();
    const env = buildEnv({
      cloudWebWorker,
      webhookWorker,
    });

    const request = new Request(
      "https://origin.agentrelay.cloud/cloud/api/v1/webhooks/nango",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "forward", from: "github-app-oauth" }),
      },
    );

    await worker.fetch(request, env, buildCtx());

    expect(cloudWebWorker.fetch).toHaveBeenCalledOnce();
    expect(webhookWorker.fetch).not.toHaveBeenCalled();
  });
});
