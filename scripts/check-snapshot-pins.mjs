#!/usr/bin/env node
import { assertSnapshotPinsInSync, formatPins, readSnapshotPins } from "./snapshot-pins-lib.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const repoRoot = readArg("--repo-root") ?? process.cwd();
const expected = readArg("--expect");

try {
  if (process.argv.includes("--print-canonical")) {
    const pins = await readSnapshotPins(repoRoot);
    console.log(pins[0]?.snapshot ?? "");
    process.exit(0);
  }

  const result = await assertSnapshotPinsInSync(repoRoot, expected);
  if (!process.argv.includes("--quiet")) {
    console.log(`Snapshot pins in sync: ${result.expected}`);
    console.log(formatPins(result.pins));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
