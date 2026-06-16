#!/usr/bin/env node
/**
 * Guard the vendored relayfile writeback-path catalog against drift.
 *
 * The source of truth is the generated catalog in the relayfile-adapters
 * monorepo (packages/core/src/writeback-paths/catalog.generated.json,
 * published since @relayfile/adapter-core@0.3.x as the
 * `@relayfile/adapter-core/writeback-paths` export). packages/web cannot
 * import that export directly yet: the hoisted root install is
 * @relayfile/adapter-core@0.1.8 (which predates the catalog) and only
 * packages/core carries the ^0.3.35 workspace-local install. Until the
 * dependency is unified — the better end-state, at which point the vendored
 * JSON in packages/web/lib/integrations should be replaced by a direct
 * package import — this script diffs the vendored copy against the first
 * source it can find:
 *
 *   1. an installed @relayfile/adapter-core that ships the catalog
 *      (root node_modules or the packages/core workspace-local install)
 *   2. $RELAYFILE_ADAPTERS_DIR (explicit relayfile-adapters checkout)
 *   3. ../relayfile-adapters (sibling checkout, the usual dev layout)
 *
 * Exit codes: 0 = in sync or no source available (reported), 1 = drift.
 * Run with --require-source to also fail when no source is available.
 *
 * The same comparison is wired into vitest via
 * packages/web/lib/integrations/relayfile-writeback-catalog.test.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VENDORED_CATALOG_PATH = path.join(
  repoRoot,
  "packages/web/lib/integrations/relayfile-writeback-paths.catalog.json",
);

const SOURCE_RELATIVE_PATH = "packages/core/src/writeback-paths/catalog.generated.json";
const PACKAGE_CATALOG_MODULE = "dist/src/writeback-paths/index.js";

/**
 * Find the first available catalog source. Returns
 * `{ label, load: () => Promise<object> }` or null when nothing is available
 * (e.g. CI before the adapter-core dependency is unified and without an
 * adapters checkout).
 */
export function findCatalogSource() {
  const packageRoots = [
    path.join(repoRoot, "node_modules/@relayfile/adapter-core"),
    path.join(repoRoot, "packages/core/node_modules/@relayfile/adapter-core"),
  ];
  for (const packageRoot of packageRoots) {
    const moduleFile = path.join(packageRoot, PACKAGE_CATALOG_MODULE);
    if (existsSync(moduleFile)) {
      return {
        label: `installed @relayfile/adapter-core (${path.relative(repoRoot, packageRoot)})`,
        load: async () => {
          const module = await import(pathToFileURL(moduleFile).href);
          if (!module.WRITEBACK_PATH_CATALOG) {
            throw new Error(`${moduleFile} does not export WRITEBACK_PATH_CATALOG`);
          }
          return module.WRITEBACK_PATH_CATALOG;
        },
      };
    }
  }

  const checkouts = [
    ...(process.env.RELAYFILE_ADAPTERS_DIR
      ? [
          {
            label: `RELAYFILE_ADAPTERS_DIR (${process.env.RELAYFILE_ADAPTERS_DIR})`,
            file: path.join(process.env.RELAYFILE_ADAPTERS_DIR, SOURCE_RELATIVE_PATH),
          },
        ]
      : []),
    {
      label: "sibling relayfile-adapters checkout",
      file: path.join(repoRoot, "..", "relayfile-adapters", SOURCE_RELATIVE_PATH),
    },
  ];
  for (const checkout of checkouts) {
    if (existsSync(checkout.file)) {
      return {
        label: checkout.label,
        load: async () => JSON.parse(readFileSync(checkout.file, "utf8")),
      };
    }
  }
  return null;
}

function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}

/**
 * Compare the vendored catalog against a source catalog object. Returns a
 * list of human-readable drift findings; empty means in sync.
 */
export function compareCatalogs(source, vendoredFile = VENDORED_CATALOG_PATH) {
  const vendored = JSON.parse(readFileSync(vendoredFile, "utf8"));
  const findings = [];

  const sourceProviders = new Set(Object.keys(source));
  const vendoredProviders = new Set(Object.keys(vendored));
  for (const provider of sourceProviders) {
    if (!vendoredProviders.has(provider)) {
      findings.push(`provider "${provider}" exists in source but not in vendored copy`);
    }
  }
  for (const provider of vendoredProviders) {
    if (!sourceProviders.has(provider)) {
      findings.push(`provider "${provider}" exists in vendored copy but not in source`);
    }
  }
  for (const provider of sourceProviders) {
    if (!vendoredProviders.has(provider)) continue;
    if (stableStringify(source[provider]) !== stableStringify(vendored[provider])) {
      findings.push(
        `provider "${provider}" resources/templates differ between source and vendored copy`,
      );
    }
  }
  return findings;
}

async function main() {
  const requireSource = process.argv.includes("--require-source");
  const source = findCatalogSource();
  if (!source) {
    const message =
      "check-relayfile-writeback-catalog: no catalog source available " +
      "(no installed @relayfile/adapter-core ships the catalog and no relayfile-adapters checkout was found); skipping drift check.";
    if (requireSource) {
      console.error(message);
      process.exit(1);
    }
    console.warn(message);
    return;
  }

  const findings = compareCatalogs(await source.load());
  if (findings.length === 0) {
    console.log(`check-relayfile-writeback-catalog: vendored catalog matches ${source.label}.`);
    return;
  }

  console.error(
    `check-relayfile-writeback-catalog: vendored catalog drifted from ${source.label}:`,
  );
  for (const finding of findings) {
    console.error(`  - ${finding}`);
  }
  console.error(
    "Refresh the vendored copy from the adapters catalog (see scripts/check-relayfile-writeback-catalog.mjs header) " +
      `and update ${VENDORED_CATALOG_PATH}.`,
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
