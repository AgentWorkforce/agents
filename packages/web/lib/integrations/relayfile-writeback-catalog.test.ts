import { describe, expect, it, vi } from "vitest";

import {
  CLOUD_ONLY_WRITEBACK_MOUNTS,
  catalogProviders,
  inferWritebackProviderForPath,
  isCatalogProvider,
} from "./relayfile-writeback-catalog";
import {
  compareCatalogs,
  findCatalogSource,
} from "../../../../scripts/check-relayfile-writeback-catalog.mjs";

// The bridge module transitively imports Nango/workspace-integration modules;
// mock them the same way relayfile-writeback-bridge.test.ts does so importing
// BRIDGE_WRITEBACK_PROVIDERS stays side-effect free.
vi.mock("./nango-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nango-service")>()),
  getNangoClient: vi.fn(),
  getProviderConfigKey: vi.fn(),
}));
vi.mock("./workspace-integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspace-integrations")>()),
  getWorkspaceIntegrationByProviderAlias: vi.fn(),
}));

/**
 * Catalog providers the cloud bridge intentionally does not execute
 * writebacks for (yet). Every entry needs a reason; remove the entry when the
 * bridge gains an executor so the test starts enforcing it.
 */
const CATALOG_PROVIDERS_NOT_BRIDGED: Record<string, string> = {
  asana: "No cloud writeback executor yet; reads only",
  "azure-blob": "Storage adapter; cloud has no Azure Blob integration",
  box: "No cloud Box integration",
  calendly: "No cloud Calendly integration",
  clickup: "No cloud writeback executor yet",
  daytona: "No cloud Daytona writeback executor yet",
  gcs: "Storage adapter; cloud has no GCS integration",
  gmail:
    "Adapters-repo gmail adapter mounts /gmail (drafts/threads/watches); cloud bridges Gmail via its own /google-mail mount instead",
  "google-drive": "No cloud writeback executor yet",
  granola: "Granola is read/ingest-only in cloud",
  intercom: "No cloud Intercom integration",
  mailgun: "No cloud Mailgun integration",
  mixpanel: "No cloud Mixpanel integration",
  onedrive: "No cloud OneDrive integration",
  pipedrive: "No cloud Pipedrive integration",
  postgres: "Infra adapter; not a Nango-bridged provider",
  recall: "Recall is call-recording ingest/read-only in cloud",
  reddit: "No cloud writeback executor yet",
  redis: "Infra adapter; not a Nango-bridged provider",
  s3: "Storage adapter; not bridged through the writeback path",
  salesforce: "No cloud Salesforce integration",
  sendgrid: "No cloud SendGrid integration",
  sharepoint: "No cloud SharePoint integration",
  teams: "No cloud Microsoft Teams integration",
  zendesk: "No cloud writeback executor yet",
};

async function loadBridgeProviders(): Promise<readonly string[]> {
  const bridge = await import("./relayfile-writeback-bridge");
  return bridge.BRIDGE_WRITEBACK_PROVIDERS;
}

describe("relayfile writeback catalog drift", () => {
  it("every bridge provider is in the adapters catalog or documented as cloud-only", async () => {
    const bridgeProviders = await loadBridgeProviders();
    const undocumented = bridgeProviders.filter(
      (provider) =>
        !isCatalogProvider(provider) &&
        !Object.hasOwn(CLOUD_ONLY_WRITEBACK_MOUNTS, provider),
    );
    expect(undocumented).toEqual([]);
  });

  it("every catalog provider is bridged or explicitly allowlisted with a reason", async () => {
    const bridgeProviders = new Set(await loadBridgeProviders());
    const unaccounted = catalogProviders().filter(
      (provider) =>
        !bridgeProviders.has(provider) &&
        !Object.hasOwn(CATALOG_PROVIDERS_NOT_BRIDGED, provider),
    );
    expect(unaccounted).toEqual([]);
  });

  it("the not-bridged allowlist contains no stale or contradictory entries", async () => {
    const bridgeProviders = new Set(await loadBridgeProviders());
    for (const provider of Object.keys(CATALOG_PROVIDERS_NOT_BRIDGED)) {
      // Stale: the catalog no longer has the provider.
      expect(isCatalogProvider(provider), `allowlist entry "${provider}" is not in the catalog`).toBe(true);
      // Contradictory: the bridge now executes it, so the entry must go.
      expect(
        bridgeProviders.has(provider),
        `allowlist entry "${provider}" is now bridged; remove it from CATALOG_PROVIDERS_NOT_BRIDGED`,
      ).toBe(false);
    }
  });

  it("documented cloud-only mounts stay absent from the catalog", () => {
    for (const mount of Object.keys(CLOUD_ONLY_WRITEBACK_MOUNTS)) {
      expect(
        isCatalogProvider(mount),
        `"${mount}" is now in the adapters catalog; drop it from CLOUD_ONLY_WRITEBACK_MOUNTS`,
      ).toBe(false);
    }
  });

  it("infers providers from mount paths via the catalog", () => {
    expect(inferWritebackProviderForPath("/github/repos/o/r/issues/1.json")).toBe("github");
    expect(inferWritebackProviderForPath("/asana/tasks/123.json")).toBe("asana");
    expect(inferWritebackProviderForPath("/google-mail/labels/Label_1.json")).toBe("google-mail");
    expect(inferWritebackProviderForPath("/not-a-provider/x.json")).toBeNull();
    expect(inferWritebackProviderForPath("relative/path.json")).toBeNull();
  });

  it("vendored catalog matches the adapters-repo source when one is available", async () => {
    const source = findCatalogSource();
    if (!source) {
      // No installed @relayfile/adapter-core ships the catalog and no local
      // relayfile-adapters checkout is present in this environment;
      // scripts/check-relayfile-writeback-catalog.mjs documents the lookup.
      console.warn(
        "relayfile-writeback-catalog: no catalog source available; skipping vendored-copy drift check",
      );
      return;
    }
    expect(compareCatalogs(await source.load()), `drift against ${source.label}`).toEqual([]);
  });
});
