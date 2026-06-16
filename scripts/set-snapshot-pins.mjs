#!/usr/bin/env node
import { assertSnapshotPinsInSync, setSnapshotPins } from "./snapshot-pins-lib.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

const snapshot = readArg("--snapshot");
const repoRoot = readArg("--repo-root") ?? process.cwd();

if (!snapshot) {
  console.error("Usage: node scripts/set-snapshot-pins.mjs --snapshot <snapshot-name>");
  process.exit(2);
}

try {
  const changed = await setSnapshotPins(snapshot, repoRoot);
  await assertSnapshotPinsInSync(repoRoot, snapshot);
  if (changed.length === 0) {
    console.log(`Snapshot pins already point at ${snapshot}`);
  } else {
    console.log(`Updated snapshot pins to ${snapshot}:`);
    for (const file of changed) console.log(`- ${file}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
