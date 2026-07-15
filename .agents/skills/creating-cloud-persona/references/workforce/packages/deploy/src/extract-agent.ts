import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build, type Plugin } from 'esbuild';
import { parseAgentSpec, type AgentSpec } from '@agentworkforce/persona-kit';

import {
  NODE_EXTERNALS,
  RESOLVE_EXTENSIONS,
  assertReadableFile,
  extractDefaultExport,
  packageNodePaths,
  preserveLocalImportMetaUrlPlugin
} from './persona-source.js';

/**
 * A minimal stand-in for `@agentworkforce/runtime`, injected only while
 * extracting an agent's listener declarations at deploy time.
 *
 * Extraction must *evaluate* `defineAgent({...})` to read the triggers /
 * schedules / watch the author declared, but it must NOT run the real runtime
 * (sandbox/credentials/cloud wiring) or invoke the handler. So:
 *   - `defineAgent` returns the listener data verbatim,
 *   - `handler` is preserved only when the agent provided one,
 *   - every other named export (`writeJsonFile`, `resolveMountRoot`, …) is a
 *     harmless no-op — those are only referenced *inside* the handler closure,
 *     which extraction never calls.
 *
 * CommonJS (`module.exports = Proxy`) so esbuild's interop satisfies arbitrary
 * named imports without a static "no matching export" error.
 */
const RUNTIME_STUB = `
const hasOwn = Object.prototype.hasOwnProperty;
function defineAgent(input) {
  const out = {};
  if (input && hasOwn.call(input, 'launchedBy')) out.launchedBy = input.launchedBy;
  if (input && input.triggers) out.triggers = input.triggers;
  if (input && input.schedules) out.schedules = input.schedules;
  if (input && input.watch) out.watch = input.watch;
  // Preserve the handler so extraction can confirm a real defineAgent shape
  // (it is never invoked during extraction).
  if (input && typeof input.handler === 'function') out.handler = input.handler;
  return out;
}
function handler(fn) { return fn; }
const noop = function () {};
module.exports = new Proxy(
  { defineAgent, handler, __esModule: true },
  { get(target, prop) { return prop in target ? target[prop] : noop; } }
);
`;

function runtimeStubPlugin(): Plugin {
  return {
    name: 'agentworkforce-runtime-extract-stub',
    setup(b) {
      b.onResolve({ filter: /^@agentworkforce\/runtime(\/.*)?$/ }, (args) => ({
        path: args.path,
        namespace: 'agentworkforce-runtime-stub'
      }));
      b.onLoad({ filter: /.*/, namespace: 'agentworkforce-runtime-stub' }, () => ({
        contents: RUNTIME_STUB,
        loader: 'js'
      }));
    }
  };
}

export interface ExtractedAgent {
  /** Validated agent listener spec (triggers/schedules/watch). */
  agent: AgentSpec;
  /** Raw default export shape, for diagnostics. */
  raw: unknown;
}

/**
 * Compile an `agent.ts` (the persona's `onEvent` entrypoint) and extract its
 * `defineAgent(...)` listener declarations. Reuses the persona-source esbuild
 * machinery, but swaps the runtime for a no-op stub so extraction stays fast
 * and side-effect-free. The result is validated with `parseAgentSpec`.
 *
 * Throws if the file does not default-export a `defineAgent(...)` object (e.g.
 * a legacy bare `export default handler(...)`), so un-migrated agents surface
 * the move loudly.
 */
export async function extractAgentSpec(onEventPath: string): Promise<ExtractedAgent> {
  await assertReadableFile(onEventPath, 'agent onEvent');

  const tempDir = await mkdtemp(join(tmpdir(), 'agentworkforce-agent-'));
  const compiledPath = join(tempDir, `${randomUUID()}.mjs`);

  try {
    await build({
      entryPoints: [onEventPath],
      outfile: compiledPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'silent',
      banner: {
        js: [
          'import { createRequire as __agentworkforceCreateRequire } from "node:module";',
          'const require = __agentworkforceCreateRequire(import.meta.url);'
        ].join('\n')
      },
      external: NODE_EXTERNALS,
      resolveExtensions: RESOLVE_EXTENSIONS,
      plugins: [runtimeStubPlugin(), preserveLocalImportMetaUrlPlugin()],
      nodePaths: packageNodePaths(onEventPath)
    });

    const mod = await import(pathToFileURL(compiledPath).href);
    const def = extractDefaultExport(mod.default);

    if (!def || typeof def !== 'object' || typeof (def as { handler?: unknown }).handler !== 'function') {
      throw new Error(
        `agent "${onEventPath}" must default-export defineAgent({ triggers, schedules, watch, handler }). ` +
          'Bare `export default handler(...)` is no longer supported — wrap it in `defineAgent` and move triggers off the persona.'
      );
    }

    const source = def as {
      launchedBy?: unknown;
      triggers?: unknown;
      schedules?: unknown;
      watch?: unknown;
    };
    const raw = {
      ...(source.launchedBy !== undefined ? { launchedBy: source.launchedBy } : {}),
      ...(source.triggers !== undefined ? { triggers: source.triggers } : {}),
      ...(source.schedules !== undefined ? { schedules: source.schedules } : {}),
      ...(source.watch !== undefined ? { watch: source.watch } : {})
    };

    return { agent: parseAgentSpec(raw, `agent "${onEventPath}"`), raw: def };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
