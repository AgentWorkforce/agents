import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SNAPSHOT_NAME_PATTERN =
  /relay-orchestrator-sdk-[A-Za-z0-9._-]+-relayfile-v?[A-Za-z0-9._-]+-runtime-[A-Za-z0-9._-]+/;
export const SNAPSHOT_SDK_VERSION_PATTERN =
  /^relay-orchestrator-sdk-(?<sdk>[A-Za-z0-9._-]+)-relayfile-/;

export const SNAPSHOT_PIN_SOURCES = [
  {
    id: "core-default",
    path: "packages/core/src/config/snapshot.ts",
    regex:
      /export const DEFAULT_SNAPSHOT = ['"](?<snapshot>relay-orchestrator-sdk-[^'"]+)['"]/,
    replacement: (snapshot) => `export const DEFAULT_SNAPSHOT = '${snapshot}'`,
  },
  {
    id: "worker-env",
    path: "infra/web-worker.ts",
    regex:
      /RELAY_SANDBOX_SNAPSHOT:\s*["'](?<snapshot>relay-orchestrator-sdk-[^"']+)["']/,
    replacement: (snapshot) => `RELAY_SANDBOX_SNAPSHOT: "${snapshot}"`,
  },
  {
    id: "ssm-initial-value",
    path: "infra/sandbox-snapshot.ts",
    regex: /value:\s*["'](?<snapshot>relay-orchestrator-sdk-[^"']+)["']/,
    replacement: (snapshot) => `value: "${snapshot}"`,
  },
  {
    id: "docs-current",
    path: "SNAPSHOT.md",
    regex:
      /Current snapshot: `(?<snapshot>relay-orchestrator-sdk-[^`]+)`/,
    replacement: (snapshot) => `Current snapshot: \`${snapshot}\``,
  },
];

export function repoPath(repoRoot, relativePath) {
  return path.join(repoRoot, relativePath);
}

export function validateSnapshotName(snapshot) {
  if (!SNAPSHOT_NAME_PATTERN.test(snapshot) || snapshot.match(SNAPSHOT_NAME_PATTERN)?.[0] !== snapshot) {
    throw new Error(
      `Invalid snapshot name "${snapshot}". Expected relay-orchestrator-sdk-<sdk>-relayfile-<version>-runtime-<version>.`,
    );
  }
}

export function snapshotSdkVersion(snapshot) {
  validateSnapshotName(snapshot);
  const match = snapshot.match(SNAPSHOT_SDK_VERSION_PATTERN);
  if (!match?.groups?.sdk) {
    throw new Error(`Could not parse SDK version from snapshot name "${snapshot}".`);
  }
  return match.groups.sdk;
}

function parseVersion(version) {
  const normalized = String(version).trim().replace(/^v/, "");
  const prereleaseStart = normalized.indexOf("-");
  const core = prereleaseStart === -1 ? normalized : normalized.slice(0, prereleaseStart);
  const prerelease = prereleaseStart === -1 ? "" : normalized.slice(prereleaseStart + 1);
  const parts = core.split(".").map((part) => {
    if (!/^\d+$/.test(part)) {
      return Number.NaN;
    }
    return Number.parseInt(part, 10);
  });
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Invalid SDK version "${version}" in snapshot name.`);
  }
  while (parts.length < 3) parts.push(0);
  return { parts, prerelease };
}

function comparePrerelease(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const aParts = a.split(".");
  const bParts = b.split(".");
  const count = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < count; index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumber = /^\d+$/.test(left) ? Number.parseInt(left, 10) : null;
    const rightNumber = /^\d+$/.test(right) ? Number.parseInt(right, 10) : null;
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export function compareSnapshotSdkVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const count = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = a.parts[index] ?? 0;
    const rightPart = b.parts[index] ?? 0;
    if (leftPart !== rightPart) {
      return Math.sign(leftPart - rightPart);
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function assertSnapshotDoesNotDowngradeSdk(candidateSnapshot, currentSnapshot, options = {}) {
  const candidateSdk = snapshotSdkVersion(candidateSnapshot);
  const currentSdk = snapshotSdkVersion(currentSnapshot);
  if (options.allowDowngrade || compareSnapshotSdkVersions(candidateSdk, currentSdk) >= 0) {
    return { candidateSdk, currentSdk };
  }

  throw new Error(
    [
      "Refusing to promote Daytona snapshot with older Agent Relay SDK line.",
      `Current snapshot:   ${currentSnapshot} (SDK ${currentSdk})`,
      `Candidate snapshot: ${candidateSnapshot} (SDK ${candidateSdk})`,
      "If this is an intentional reviewed rollback, rerun with allow_sdk_downgrade=true.",
    ].join("\n"),
  );
}

export async function readSnapshotPins(repoRoot = process.cwd()) {
  const pins = [];
  for (const source of SNAPSHOT_PIN_SOURCES) {
    const absolutePath = repoPath(repoRoot, source.path);
    const content = await readFile(absolutePath, "utf8");
    const match = content.match(source.regex);
    if (!match?.groups?.snapshot) {
      throw new Error(
        `Could not find snapshot pin "${source.id}" in ${source.path}. Update scripts/snapshot-pins-lib.mjs if the file format changed.`,
      );
    }
    pins.push({ ...source, snapshot: match.groups.snapshot });
  }
  return pins;
}

export async function assertSnapshotPinsInSync(repoRoot = process.cwd(), expectedSnapshot = null) {
  const pins = await readSnapshotPins(repoRoot);
  const expected = expectedSnapshot ?? pins[0]?.snapshot;
  if (!expected) {
    throw new Error("No snapshot pins found.");
  }
  validateSnapshotName(expected);

  const mismatches = pins.filter((pin) => pin.snapshot !== expected);
  if (mismatches.length > 0) {
    const lines = pins.map((pin) => {
      const marker = pin.snapshot === expected ? " " : "!";
      return `${marker} ${pin.id.padEnd(17)} ${pin.path} -> ${pin.snapshot}`;
    });
    throw new Error(
      [
        `Snapshot pins are not in lockstep. Expected: ${expected}`,
        "",
        ...lines,
        "",
        "Run: node scripts/set-snapshot-pins.mjs --snapshot <snapshot-name>",
      ].join("\n"),
    );
  }

  return { expected, pins };
}

export async function setSnapshotPins(snapshot, repoRoot = process.cwd()) {
  validateSnapshotName(snapshot);

  const changed = [];
  for (const source of SNAPSHOT_PIN_SOURCES) {
    const absolutePath = repoPath(repoRoot, source.path);
    const content = await readFile(absolutePath, "utf8");
    if (!source.regex.test(content)) {
      throw new Error(
        `Could not find snapshot pin "${source.id}" in ${source.path}. Update scripts/snapshot-pins-lib.mjs if the file format changed.`,
      );
    }
    const next = content.replace(source.regex, source.replacement(snapshot));
    if (next !== content) {
      await writeFile(absolutePath, next);
      changed.push(source.path);
    }
  }

  return changed;
}

export function formatPins(pins) {
  return pins.map((pin) => `${pin.id.padEnd(17)} ${pin.path} -> ${pin.snapshot}`).join("\n");
}
