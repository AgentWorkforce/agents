import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSnapshotPinsInSync,
  assertSnapshotDoesNotDowngradeSdk,
  compareSnapshotSdkVersions,
  readSnapshotPins,
  setSnapshotPins,
  snapshotSdkVersion,
  SNAPSHOT_PIN_SOURCES,
} from "../scripts/snapshot-pins-lib.mjs";

const REPO_ROOT = new URL("..", import.meta.url);
const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT);

async function copyPinFilesIntoTempRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "snapshot-pins-"));
  for (const source of SNAPSHOT_PIN_SOURCES) {
    const sourcePath = new URL(source.path, REPO_ROOT);
    const destPath = path.join(root, source.path);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(path.dirname(destPath), { recursive: true }),
    );
    await writeFile(destPath, await readFile(sourcePath, "utf8"));
  }
  return root;
}

test("snapshot pin parser reads committed selectors", async () => {
  const pins = await readSnapshotPins(REPO_ROOT_PATH);

  assert.equal(pins.length, 4);
  assert.equal(new Set(pins.map((pin) => pin.snapshot)).size, 1);
});

test("snapshot pin setter updates all selector files", async () => {
  const root = await copyPinFilesIntoTempRepo();
  try {
    const snapshot = "relay-orchestrator-sdk-6.3.9-relayfile-v0.8.9-runtime-3.0.29";
    const changed = await setSnapshotPins(snapshot, root);
    const result = await assertSnapshotPinsInSync(root, snapshot);

    assert.deepEqual(changed.sort(), SNAPSHOT_PIN_SOURCES.map((source) => source.path).sort());
    assert.equal(result.expected, snapshot);
    assert.equal(new Set(result.pins.map((pin) => pin.snapshot)).size, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot pin check reports mismatches", async () => {
  const root = await copyPinFilesIntoTempRepo();
  try {
    const workerPath = path.join(root, "infra/web-worker.ts");
    const workerSource = await readFile(workerPath, "utf8");
    await writeFile(
      workerPath,
      workerSource.replace(
        /relay-orchestrator-sdk-[^"']+/,
        "relay-orchestrator-sdk-6.3.0-relayfile-v0.7.39-runtime-3.0.20",
      ),
    );

    await assert.rejects(
      () => assertSnapshotPinsInSync(root),
      /Snapshot pins are not in lockstep/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot SDK parser extracts semver and prerelease versions", () => {
  assert.equal(
    snapshotSdkVersion("relay-orchestrator-sdk-8.3.1-beta.0-relayfile-v0.8.15-runtime-3.0.50-r2"),
    "8.3.1-beta.0",
  );
  assert.equal(
    snapshotSdkVersion("relay-orchestrator-sdk-8.7.1-relayfile-v0.8.23-runtime-4.0.1"),
    "8.7.1",
  );
});

test("snapshot SDK version comparison handles prerelease ordering", () => {
  assert.equal(compareSnapshotSdkVersions("8.3.1", "8.3.1-beta.0"), 1);
  assert.equal(compareSnapshotSdkVersions("8.3.1-beta.1", "8.3.1-beta.0"), 1);
  assert.equal(compareSnapshotSdkVersions("8.3.1-beta-2", "8.3.1-beta-1"), 1);
  assert.equal(compareSnapshotSdkVersions("8.3.1-beta.0", "8.3.1"), -1);
  assert.equal(compareSnapshotSdkVersions("8.7.1", "8.3.1"), 1);
  assert.equal(compareSnapshotSdkVersions("8.3.1.4", "8.3.1.3"), 1);
  assert.equal(compareSnapshotSdkVersions("8.3.1", "8.3.1"), 0);
});

test("snapshot SDK version comparison rejects non-numeric core parts", () => {
  assert.throws(
    () => compareSnapshotSdkVersions("8.3a.1", "8.3.1"),
    /Invalid SDK version "8\.3a\.1"/,
  );
});

test("snapshot SDK downgrade guard rejects lower SDK candidates", () => {
  assert.throws(
    () =>
      assertSnapshotDoesNotDowngradeSdk(
        "relay-orchestrator-sdk-6.3.5-relayfile-v0.8.23-runtime-4.0.1",
        "relay-orchestrator-sdk-8.3.1-beta.0-relayfile-v0.8.15-runtime-3.0.50-r2",
      ),
    /Refusing to promote Daytona snapshot/,
  );
});

test("snapshot SDK downgrade guard allows equal, newer, and explicit rollback", () => {
  const current = "relay-orchestrator-sdk-8.3.1-beta.0-relayfile-v0.8.15-runtime-3.0.50-r2";
  assert.deepEqual(
    assertSnapshotDoesNotDowngradeSdk(
      "relay-orchestrator-sdk-8.3.1-beta.0-relayfile-v0.8.23-runtime-4.0.1",
      current,
    ),
    { candidateSdk: "8.3.1-beta.0", currentSdk: "8.3.1-beta.0" },
  );
  assert.deepEqual(
    assertSnapshotDoesNotDowngradeSdk(
      "relay-orchestrator-sdk-8.3.1-relayfile-v0.8.23-runtime-4.0.1",
      current,
    ),
    { candidateSdk: "8.3.1", currentSdk: "8.3.1-beta.0" },
  );
  assert.deepEqual(
    assertSnapshotDoesNotDowngradeSdk(
      "relay-orchestrator-sdk-6.3.5-relayfile-v0.8.23-runtime-4.0.1",
      current,
      { allowDowngrade: true },
    ),
    { candidateSdk: "6.3.5", currentSdk: "8.3.1-beta.0" },
  );
});
