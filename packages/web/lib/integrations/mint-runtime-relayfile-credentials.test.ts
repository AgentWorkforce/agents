import { describe, expect, it } from "vitest";
import {
  normalizePersonaIntegrationConfigs,
  normalizeRelayfileMountPaths,
  resolveRuntimeRelayfileMountPaths,
} from "./mint-runtime-relayfile-credentials";

describe("resolveRuntimeRelayfileMountPaths", () => {
  it("drops degenerate root paths while keeping normal mount paths", () => {
    expect(
      resolveRuntimeRelayfileMountPaths({
        relayfileMountPaths: [
          "/",
          "//",
          "///",
          "/**",
          "/*",
          "*",
          "",
          " ",
          "////**",
          "/github/repos/acme/cloud/issues",
        ],
      }),
    ).toEqual(["/github/repos/acme/cloud/issues"]);
  });

  it("drops parent traversal segments while keeping similarly named path segments", () => {
    expect(
      resolveRuntimeRelayfileMountPaths({
        relayfileMountPaths: [
          "/..",
          "/github/../pulls",
          "/packages/..foo",
          "/github/repos/acme/cloud/pulls/",
        ],
      }),
    ).toEqual(["/github/repos/acme/cloud/pulls/**", "/packages/..foo"]);
  });

  it("normalizes relayfile mount paths idempotently", () => {
    const normalized = normalizeRelayfileMountPaths([
      "/github/repos/acme/cloud/pulls/",
      "/github/repos/acme/cloud/pulls/**",
    ]);

    expect(normalized).toEqual(["/github/repos/acme/cloud/pulls/**"]);
    expect(normalizeRelayfileMountPaths(normalized)).toEqual(normalized);
  });

  it("rejects malformed falsy integration source payloads instead of defaulting", () => {
    for (const source of [0, ""]) {
      expect(
        normalizePersonaIntegrationConfigs({
          github: { source },
        }),
      ).toBeNull();
    }
  });
});
