import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const immutableTag = "ghcr.io/agentworkforce/relay-sandbox:0123456789abcdef0123456789abcdef01234567";

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

describe("sandbox image tag source", () => {
  it("keeps local Docker on the relay-sandbox tag source", () => {
    const output = execFileSync("bash", ["dev-stack/assert-sandbox-image-tag-parity.sh"], {
      cwd: root,
      encoding: "utf8",
    });

    assert.match(
      output,
      /^SANDBOX_IMAGE_TAG parity OK: ghcr\.io\/agentworkforce\/relay-sandbox:[0-9a-f]{40}$/m,
    );
  });

  it("accepts immutable SHA tags and rejects floating tag overrides", () => {
    const env = { ...process.env, SANDBOX_IMAGE_TAG: immutableTag };
    const parityOutput = execFileSync("bash", ["dev-stack/assert-sandbox-image-tag-parity.sh"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.match(parityOutput, new RegExp(`^SANDBOX_IMAGE_TAG parity OK: ${immutableTag}$`, "m"));

    const floating = spawnSync(
      "bash",
      ["-c", "SANDBOX_IMAGE_TAG=ghcr.io/agentworkforce/relay-sandbox:latest dev-stack/local-docker-provider.sh print-tag"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.notEqual(floating.status, 0);
    assert.match(floating.stderr, /SANDBOX_IMAGE_TAG must be ghcr\.io\/agentworkforce\/relay-sandbox:<40-char-git-sha>/);

    const snapshotBase = spawnSync(
      "npx",
      ["tsx", "scripts/create-snapshot.ts", "--print-base-image"],
      {
        cwd: root,
        env: { ...process.env, SANDBOX_IMAGE_TAG: "ghcr.io/agentworkforce/relay-sandbox:latest" },
        encoding: "utf8",
      },
    );
    assert.equal(snapshotBase.status, 0);
    assert.equal(snapshotBase.stdout.trim(), "daytonaio/sandbox:0.6.0");
  });

  it("wires relay-sandbox Docker consumers to dev-stack/SANDBOX_IMAGE_TAG", () => {
    const source = read("dev-stack/SANDBOX_IMAGE_TAG");
    const localDocker = read("dev-stack/local-docker-provider.sh");
    const createSnapshot = read("scripts/create-snapshot.ts");
    const buildWorkflow = read(".github/workflows/build-relay-sandbox.yml");
    const rebuildWorkflow = read(".github/workflows/rebuild-snapshot.yml");
    const smokeWorkflow = read(".github/workflows/smoke-sandbox-image.yml");
    const snapshotCheckWorkflow = read(".github/workflows/snapshot-check.yml");
    const snapshotPins = read("scripts/snapshot-pins-lib.mjs");
    const workerInfra = read("infra/web-worker.ts");
    const productionDockerfile = read("deploy/daytona/Dockerfile");
    const packageJson = read("package.json");
    const entrypoint = read("deploy/daytona/relay-sandbox-entrypoint.sh");
    const smokeScript = read("dev-stack/smoke-sandbox-image.sh");
    const smokeDockerfile = read("dev-stack/smoke-sandbox-image.Dockerfile");

    assert.match(source, /SANDBOX_IMAGE_REPOSITORY="\$\{SANDBOX_IMAGE_REPOSITORY:-ghcr\.io\/agentworkforce\/relay-sandbox\}"/);
    assert.match(source, /\[0-9a-f\]\{40\}/);
    assert.doesNotMatch(source, /:latest/);
    assert.match(productionDockerfile, /FROM daytonaio\/sandbox:0\.6\.0/);
    assert.doesNotMatch(productionDockerfile, /FROM daytonaio\/sandbox:latest/);
    assert.match(localDocker, /source "\$\{REPO_ROOT\}\/dev-stack\/SANDBOX_IMAGE_TAG"/);
    assert.match(createSnapshot, /const SNAPSHOT_BASE_IMAGE = ['"]daytonaio\/sandbox:0\.6\.0['"];/);
    assert.match(createSnapshot, /Image\.base\(SNAPSHOT_BASE_IMAGE\)/);
    assert.doesNotMatch(createSnapshot, /Image\.base\(SANDBOX_IMAGE_TAG\)/);
    assert.match(buildWorkflow, /source dev-stack\/SANDBOX_IMAGE_TAG/);
    assert.doesNotMatch(rebuildWorkflow, /source dev-stack\/SANDBOX_IMAGE_TAG/);
    assert.doesNotMatch(rebuildWorkflow, /SANDBOX_IMAGE_TAG: \$\{\{ steps\.sandbox-image\.outputs\.tag \}\}/);
    assert.match(snapshotCheckWorkflow, /npm run sandbox-image:parity:test/);
    assert.match(smokeWorkflow, /npm run sandbox-image:parity:test/);
    assert.match(smokeWorkflow, /SANDBOX_IMAGE_SMOKE_DOCKERFILE: dev-stack\/smoke-sandbox-image\.Dockerfile/);
    assert.match(smokeScript, /SANDBOX_IMAGE_SMOKE_DOCKERFILE/);
    assert.match(smokeScript, /SANDBOX_IMAGE_BUILD_HEARTBEAT_SECONDS/);
    assert.match(smokeScript, /docker build still running/);
    assert.match(entrypoint, /cd \/opt\/relay-smoke/);
    assert.doesNotMatch(entrypoint, /cd \/home\/daytona/);
    assert.match(smokeDockerfile, /mkdir -p \/opt\/relay-smoke/);
    assert.doesNotMatch(smokeDockerfile, /cd \/home\/daytona/);
    assert.match(smokeDockerfile, /curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20/);
    assert.match(smokeDockerfile, /COPY deploy\/daytona\/relay-sandbox-entrypoint\.sh/);
    assert.match(snapshotPins, /id: "worker-env"/);
    assert.match(snapshotPins, /path: "infra\/web-worker\.ts"/);
    assert.match(snapshotPins, /RELAY_SANDBOX_SNAPSHOT/);
    assert.match(workerInfra, /RELAY_SANDBOX_SNAPSHOT:\s*"relay-orchestrator-sdk-/);
    assert.match(packageJson, /"sandbox-image:parity:test": "npx tsx --test tests\/sandbox-image-tag-source\.test\.ts"/);
  });

  it("runs parity workflows for every file that can affect the sandbox image contract", () => {
    const buildWorkflow = read(".github/workflows/build-relay-sandbox.yml");
    const smokeWorkflow = read(".github/workflows/smoke-sandbox-image.yml");

    for (const requiredPath of [
      "dev-stack/SANDBOX_IMAGE_TAG",
      "package.json",
      "package-lock.json",
    ]) {
      assert.match(buildWorkflow, new RegExp(requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    for (const requiredPath of [
      "dev-stack/SANDBOX_IMAGE_TAG",
      "dev-stack/local-docker-provider.sh",
      "dev-stack/smoke-sandbox-image.Dockerfile",
      "dev-stack/assert-sandbox-image-tag-parity.sh",
      "scripts/create-snapshot.ts",
      "tests/sandbox-image-tag-source.test.ts",
      "package.json",
      "package-lock.json",
    ]) {
      assert.match(smokeWorkflow, new RegExp(requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const snapshotCheckWorkflow = read(".github/workflows/snapshot-check.yml");
    for (const requiredPath of [
      "dev-stack/SANDBOX_IMAGE_TAG",
      "dev-stack/assert-sandbox-image-tag-parity.sh",
      "dev-stack/local-docker-provider.sh",
      "dev-stack/smoke-sandbox-image.Dockerfile",
      "dev-stack/smoke-sandbox-image.sh",
      "tests/sandbox-image-tag-source.test.ts",
    ]) {
      assert.match(snapshotCheckWorkflow, new RegExp(requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
