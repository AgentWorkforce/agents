import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceScript = join(repoRoot, "scripts/patch-opennext-native-shims.mjs");
const handlerPath = "packages/web/.open-next-cf/server-functions/default/packages/web/handler.mjs";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "opennext-shims-"));
  const scriptPath = join(root, "scripts/patch-opennext-native-shims.mjs");
  const generatedHandler = join(root, handlerPath);

  mkdirSync(dirname(scriptPath), { recursive: true });
  mkdirSync(dirname(generatedHandler), { recursive: true });
  copyFileSync(sourceScript, scriptPath);

  return { root, scriptPath, generatedHandler };
}

function runPatch(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
  });
}

test("patch-opennext-native-shims patches Daytona ObjectStorage loader variants", () => {
  const { scriptPath, generatedHandler } = createFixture();
  writeFileSync(
    generatedHandler,
    [
      'const x={ObjectStorage:()=>import("../ObjectStorage.js"),Other:()=>import("../ObjectStorage.js")};',
      'const y={"ObjectStorage" : () => import(/* @vite-ignore */ \'../ObjectStorage.js\')};',
    ].join("\n"),
    "utf8",
  );

  const result = runPatch(scriptPath);
  assert.equal(result.status, 0, result.stderr);

  const patched = readFileSync(generatedHandler, "utf8");
  assert.match(patched, /Daytona ObjectStorage is unavailable in the Cloudflare Worker bundle/);
  assert.match(patched, /Other:\(\)=>import\("\.\.\/ObjectStorage\.js"\)/);
  assert.doesNotMatch(patched, /["']?ObjectStorage["']?\s*:\s*[^,;}]{0,160}\.\.\/ObjectStorage\.js/);
});

test("patch-opennext-native-shims fails loud on pretty-printed unpatched ObjectStorage loader", () => {
  const { scriptPath, generatedHandler } = createFixture();
  writeFileSync(
    generatedHandler,
    [
      "const x = {",
      "  ObjectStorage:",
      "    async () =>",
      "      import(\"../ObjectStorage.js\"),",
      "};",
    ].join("\n"),
    "utf8",
  );

  const result = runPatch(scriptPath);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unpatched Daytona ObjectStorage loader remains/);
});
