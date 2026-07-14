#!/usr/bin/env node
/**
 * run-evals — dry-run the showcase agents as a repeatable eval suite.
 *
 * Two executors (pick with `--live`):
 *
 *   simulate (default)  Runs each case through the runtime's local simulation
 *                       API. The handler executes for real against an in-memory
 *                       VFS seeded from the case, but
 *                       `harness.run` / `llm.complete` are STUBBED (no model,
 *                       no tokens). We assert deterministic facts: the run
 *                       succeeded, it routed to the expected event source, and
 *                       the expected side effects / log lines appeared. Free,
 *                       fast, offline — the routing/plumbing regression gate.
 *
 *   live (`--live`)     Runs the real handler with `harness.run` + `llm.complete`
 *                       backed by a cheap opencode model (default
 *                       `opencode/gpt-5-nano`), so chat cases get an ACTUAL agent
 *                       reply and scheduled/triage cases get a real model
 *                       classification. Add `--judge` to score each reply against
 *                       the case rubric with the same cheap model (LLM-as-judge,
 *                       the relayfile/agent-assistant pattern). Needs opencode on
 *                       PATH + OPENCODE_API_KEY.
 *
 * Usage:
 *   node scripts/evals/run-evals.mjs                 # simulate, all cases
 *   node scripts/evals/run-evals.mjs --agent linear-slack
 *   node scripts/evals/run-evals.mjs --case linear-slack.chat
 *   node scripts/evals/run-evals.mjs --live --judge  # real cheap-model replies + judging
 *   node scripts/evals/run-evals.mjs --list
 *
 * Agents live at the repo root (flat: `linear-slack/agent.ts`) or nested under a
 * team dir (`competitor/market-competitor/agent.ts`); a case's `agent` field is
 * the dir path relative to the repo root, so both shapes just work.
 *
 * Artifacts: .evals/runs/<stamp>/{result.json,summary.md}
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SEEDS_DIR = path.join(ROOT, 'evals', 'seeds');
const CASES_FILE = path.join(ROOT, 'evals', 'cases.jsonl');
const RUNS_DIR = path.join(ROOT, '.evals', 'runs');
const OPENCODE = process.env.WD_EVAL_OPENCODE ?? `${process.env.HOME}/.opencode/bin/opencode`;
const MODEL = process.env.WD_EVAL_MODEL ?? 'opencode/gpt-5-nano';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

function parseArgs(argv) {
  const a = { live: false, judge: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--live') a.live = true;
    else if (k === '--judge') a.judge = true;
    else if (k === '--list') a.list = true;
    else if (k === '--agent') a.agent = argv[++i];
    else if (k === '--case') a.caseId = argv[++i];
    else if (k === '--suite') a.suite = argv[++i];
  }
  return a;
}

function loadCases() {
  return readFileSync(CASES_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Map a case `seeds` entry to { vfs, contents }. Shorthand "linear/projects"
 *  → /linear/projects/_index.json from seeds/linear-projects.json. */
function resolveSeed(seed) {
  if (typeof seed === 'string') {
    const file = `${seed.replace(/\//g, '-')}.json`;
    return { vfs: `/${seed}/_index.json`, contents: readFileSync(path.join(SEEDS_DIR, file), 'utf8') };
  }
  return { vfs: seed.vfs, contents: readFileSync(path.join(SEEDS_DIR, seed.file), 'utf8') };
}

/** Install deterministic HTTP responses for one eval case. Each entry is
 *  `{ match, file, status? }`; the first substring match wins. Cases that
 *  declare fixtures fail on an unmatched request instead of leaking to the
 *  network, which keeps feed/search evals repeatable on laptops and Mac minis. */
function withHttpFixtures(testCase, fn) {
  const fixtures = (testCase.http ?? []).map((fixture) => ({
    ...fixture,
    body: readFileSync(path.join(SEEDS_DIR, fixture.file), 'utf8'),
  }));
  if (fixtures.length === 0) return Promise.resolve().then(fn);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const fixture = fixtures.find((candidate) => url.includes(candidate.match));
    if (!fixture) throw new Error(`eval HTTP request had no fixture: ${url}`);
    return new Response(fixture.body, {
      status: fixture.status ?? 200,
      headers: { 'content-type': fixture.contentType ?? 'application/json' },
    });
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = originalFetch; });
}

function buildEnvelope(testCase, turn, idx = 0) {
  const f = testCase.fixture ?? {};
  const type = f.type ?? turn?.type;
  const env = { id: `evt_${testCase.id}_${idx}`, workspace: 'ws-local', type, occurredAt: '2026-06-10T12:00:00.000Z' };
  if (f.name) env.name = f.name;
  if (f.cron) env.cron = f.cron;
  if (f.paths) env.paths = f.paths;
  // A multi-turn `turn` carries chat fields (text/channel/messageId) that ride in
  // `resource` (and channel/messageId are promoted to top-level for relaycast).
  if (turn) {
    env.resource = { ...(f.resource ?? {}), ...turn };
    // Promote routing fields from the MERGED resource so a turn that omits
    // channel/messageId still inherits them from fixture.resource.
    if (env.resource.channel) env.channel = env.resource.channel;
    if (env.resource.messageId) env.messageId = env.resource.messageId;
  } else if (f.resource) {
    env.resource = f.resource;
    if (f.resource.channel) env.channel = f.resource.channel;
    if (f.resource.messageId) env.messageId = f.resource.messageId;
  }
  return env;
}

/** Envelopes for a case: one per `turns` entry (multi-turn chat), else one. */
function buildEnvelopes(testCase) {
  if (Array.isArray(testCase.turns) && testCase.turns.length > 0) {
    return testCase.turns.map((turn, i) => buildEnvelope(testCase, turn, i));
  }
  return [buildEnvelope(testCase)];
}

/** Agent dir relative to repo root — supports flat (`linear-slack`) and nested
 *  team members (`competitor/market-competitor`). */
function agentDir(agent) {
  return path.join(ROOT, agent);
}
function personaPath(agent) {
  return path.join(agentDir(agent), 'persona.json');
}
function agentEntry(agent) {
  return path.join(agentDir(agent), 'agent.ts');
}

function resolveHandler(mod) {
  return mod.handler ?? mod.default?.handler ?? mod.default;
}

function withCaseEnv(persona, inputs, extraEnv, fn) {
  const updates = new Map(Object.entries(extraEnv ?? {}));
  for (const [key, spec] of Object.entries(persona.inputs ?? {})) {
    const envName = spec?.env ?? key;
    if (Object.prototype.hasOwnProperty.call(inputs ?? {}, key)) {
      updates.set(envName, String(inputs[key]));
    } else {
      updates.set(envName, undefined);
    }
  }

  const previous = new Map();
  for (const key of updates.keys()) previous.set(key, process.env[key]);
  for (const [key, value] of updates) {
    if (value === undefined || value === '') delete process.env[key];
    else process.env[key] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

// ── deterministic checks shared by both executors ─────────────────────────────
function checkExpectations(testCase, { status, eventSource, sideEffectKinds, logs, error, reply }) {
  const e = testCase.expect ?? {};
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  if (e.status) add(`status=${e.status}`, status === e.status, `got ${status}`);
  if (e.errorIncludes) add(`error~${e.errorIncludes}`, typeof error === 'string' && error.includes(e.errorIncludes), `got ${error ?? 'no error'}`);
  if (e.eventSource) add(`source=${e.eventSource}`, eventSource === e.eventSource, `got ${eventSource}`);
  for (const k of e.sideEffectsAll ?? []) add(`has ${k}`, sideEffectKinds.includes(k), sideEffectKinds.join(','));
  if (e.sideEffectsAny) add(`any of [${e.sideEffectsAny}]`, e.sideEffectsAny.some((k) => sideEffectKinds.includes(k)), sideEffectKinds.join(','));
  // Substring match: agents legitimately enrich a log message (e.g.
  // `inbox-buddy.context channel=… threadsLoaded=…`), so match a prefix/substring
  // rather than the whole line. Exact messages still match.
  if (e.logsAny) add(`log any [${e.logsAny}]`, e.logsAny.some((m) => logs.some((l) => l.includes(m))), logs.join(','));
  // Machine-checked grounding: assert the reply text actually contains the
  // required facts (case-insensitive substrings), so a hallucinated reply fails
  // without needing the LLM judge. Only enforced when a real reply was produced
  // (live runs); dry runs have no reply, so the check is skipped, not failed.
  if (e.replyContains) {
    const have = typeof reply === 'string' ? reply : '';
    if (have) {
      const missing = e.replyContains.filter((s) => !have.toLowerCase().includes(String(s).toLowerCase()));
      add(`reply ⊇ [${e.replyContains}]`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'ok');
    }
  }
  return checks;
}

// ── simulate executor (runtime local dry-run) ─────────────────────────────────
async function runSimulate(testCase) {
  const { tsImport } = await import('tsx/esm/api');
  const { simulateInvocation } = await import(pathToFileURL(path.join(ROOT, 'node_modules/@agentworkforce/runtime/dist/index.js')).href);
  const tmp = mkdtempSync(path.join(tmpdir(), 'wd-eval-'));
  try {
    const files = {};
    for (const seed of testCase.seeds ?? []) {
      const { vfs, contents } = resolveSeed(seed);
      files[vfs] = contents;
      // Also materialize on disk under the mount root: agents that read via a
      // relay-helpers client (e.g. linearClient().getIssue) hit the disk mount
      // (RELAYFILE_MOUNT_ROOT), not the in-memory ctx.files map.
      const abs = path.join(tmp, vfs.replace(/^\//, ''));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, contents);
    }
    const persona = JSON.parse(readFileSync(personaPath(testCase.agent), 'utf8'));
    const mod = await tsImport(pathToFileURL(agentEntry(testCase.agent)).href, import.meta.url);
    const rec = await withCaseEnv(persona, testCase.inputs ?? {}, { RELAYFILE_MOUNT_ROOT: tmp, WORKSPACE_ROOT: tmp }, () =>
      withHttpFixtures(testCase, () => simulateInvocation({
          persona,
          handler: resolveHandler(mod),
          // Multi-turn cases run every turn through ONE simulateInvocation so the
          // in-memory ctx.memory persists across turns — that shared state is how
          // we exercise conversational continuity end-to-end here.
          envelopes: buildEnvelopes(testCase),
          agent: { inputValues: testCase.inputs ?? {} },
          files,
          now: () => new Date('2026-06-10T12:00:00Z'),
        }))
    );
    // Aggregate side effects/logs across all turns; status/eventSource come from
    // the LAST turn (a multi-turn case is judged on where it ended up).
    const runs = rec.runs ?? [];
    const last = runs[runs.length - 1] ?? {};
    const sims = runs.map((r) => r.simulation ?? { sideEffects: [], capturedLogs: [] });
    return {
      status: last.status ?? 'failed',
      eventSource: last.trigger?.eventSource ?? runs[0]?.trigger?.eventSource ?? null,
      sideEffectKinds: sims.flatMap((s) => s.sideEffects.map((e) => e.kind)),
      logs: sims.flatMap((s) => s.capturedLogs.map((l) => l.message)),
      error: runs.find((r) => r.error)?.error ?? null,
      reply: null,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── live executor (real handler + opencode-backed model) ──────────────────────
function opencodeRun(prompt, cwd) {
  const res = spawnSync(OPENCODE, ['run', '-m', MODEL, prompt], {
    cwd: cwd ?? ROOT,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
  if (res.error) {
    throw new Error(`Failed to execute opencode: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`opencode exited with code ${res.status}: ${res.stderr || res.stdout}`);
  }
  const raw = (res.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  // Drop opencode's banner/status lines ("> build · model", "@ ...") and keep the reply.
  const lines = raw.split('\n').filter((l) => l.trim() && !/^[>@]/.test(l.trim()));
  return lines.join('\n').trim() || raw.trim();
}

async function runLive(testCase) {
  const { tsImport } = await import('tsx/esm/api');
  const runtime = await import(pathToFileURL(path.join(ROOT, 'node_modules/@agentworkforce/runtime/dist/index.js')).href);
  const { createSimulationSubsystems } = runtime;
  // v4 dropped the `shimEnvelope` export; the envelope→AgentEvent mapping now
  // lives in to-agent-event.js as `envelopeToAgentEvent` (wires `event.expand`).
  const { envelopeToAgentEvent } = await import(pathToFileURL(path.join(ROOT, 'node_modules/@agentworkforce/runtime/dist/to-agent-event.js')).href);

  // Materialize seeds: in-memory for ctx.files, and on disk for opencode to navigate.
  const files = {};
  const mount = mkdtempSync(path.join(tmpdir(), 'wd-live-'));
  for (const seed of testCase.seeds ?? []) {
    const { vfs, contents } = resolveSeed(seed);
    files[vfs] = contents;
    const abs = path.join(mount, vfs.replace(/^\//, ''));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }

  const subs = createSimulationSubsystems({ files, now: () => new Date('2026-06-10T12:00:00Z') });
  const sink = { sideEffects: [], logs: [] };
  subs.useSink(sink);

  let lastHarnessReply = null;
  // Every model output in order — for multi-turn chat we judge the LAST turn's
  // reply (single-turn keeps the existing lastHarnessReply semantics).
  const replies = [];
  const harness = {
    async run(args) {
      sink.sideEffects.push({ kind: 'harness.run', at: new Date().toISOString(), args: { promptChars: args.prompt.length } });
      const output = opencodeRun(args.prompt, mount);
      lastHarnessReply = output;
      replies.push(output);
      return { output, exitCode: 0, durationMs: 0 };
    },
  };
  const llm = {
    async complete(prompt) {
      sink.sideEffects.push({ kind: 'llm.complete', at: new Date().toISOString(), args: { promptChars: prompt.length } });
      const output = opencodeRun(prompt, mount);
      lastHarnessReply = lastHarnessReply ?? output;
      replies.push(output);
      return output;
    },
  };

  const personaSpec = JSON.parse(readFileSync(personaPath(testCase.agent), 'utf8'));
  const persona = { ...personaSpec, inputs: testCase.inputs ?? {}, inputSpecs: personaSpec.inputs ?? {} };
  const ctx = {
    persona,
    agent: { id: 'sim-agent', deployedName: testCase.agent, spawnedByAgentId: null },
    deployment: { id: 'sim-deployment', triggerKind: 'inbox', parentDeploymentId: null },
    workspaceId: 'ws-local',
    agentName: testCase.agent,
    llm,
    harness,
    sandbox: subs.sandbox,
    files: subs.files,
    credentials: {},
    memory: subs.memory,
    workflow: subs.workflow,
    schedule: subs.schedule,
    log: subs.log,
  };

  // Isolate any slackClient/linearClient draft writes to the temp mount. We pin
  // RELAYFILE_MOUNT_ROOT for the rest of the process and do NOT delete `mount`
  // here: the chat reply is a fire-and-forget draft whose writeback poll can
  // outlive the handler, and tearing the dir down mid-write makes the client
  // fall back to cwd and litter a `slack/` tree into the repo. /tmp is fine to
  // leave for the OS to reap.
  // One event per turn; multi-turn cases share `ctx` (and ctx.memory) so
  // continuity is exercised across turns.
  const events = buildEnvelopes(testCase).map((e) => envelopeToAgentEvent(e));
  const lastEvent = events[events.length - 1];
  // v4 events have no `.source`; derive it from the dotted type for the check.
  const eventSource = lastEvent?.type === 'cron.tick' ? 'cron' : (lastEvent?.type?.split('.')[0] ?? null);
  let status = 'succeeded';
  let error = null;
  // Reply count just before the FINAL turn ran, so we only judge a reply the
  // last turn actually produced (never silently reuse an earlier turn's output).
  let lastTurnReplyStart = 0;
  try {
    const mod = await tsImport(pathToFileURL(agentEntry(testCase.agent)).href, import.meta.url);
    const handler = resolveHandler(mod);
    process.env.RELAYFILE_MOUNT_ROOT = mount;
    process.env.WORKSPACE_ROOT = mount;
    await withCaseEnv(personaSpec, testCase.inputs ?? {}, {}, () =>
      withHttpFixtures(testCase, async () => {
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (!event) throw new Error(`envelopeToAgentEvent returned null for turn ${i} (unsupported envelope)`);
          lastTurnReplyStart = replies.length;
          await handler(ctx, event);
        }
      })
    );
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }
  // For multi-turn chat, judge ONLY a reply the final turn actually produced —
  // if the last turn emitted no output, return null rather than masking the
  // failure with an earlier turn's reply. Single-turn keeps prior semantics.
  const reply = Array.isArray(testCase.turns) && testCase.turns.length > 0
    ? (replies.length > lastTurnReplyStart ? replies[replies.length - 1] : null)
    : lastHarnessReply;
  return {
    status,
    eventSource,
    sideEffectKinds: sink.sideEffects.map((s) => s.kind),
    logs: sink.logs.map((l) => l.message),
    error,
    reply,
  };
}

function judge(testCase, reply) {
  if (!reply || !testCase.rubric) return null;
  const prompt = [
    'You are grading an AI agent reply against a rubric. Answer ONLY with compact JSON:',
    '{"pass": true|false, "reason": "one sentence"}',
    '',
    `Rubric: ${testCase.rubric}`,
    '',
    'Agent reply:',
    reply.slice(0, 4000),
  ].join('\n');
  const out = opencodeRun(prompt);
  try {
    const m = out.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { pass: null, reason: out.slice(0, 200) };
  } catch {
    return { pass: null, reason: out.slice(0, 200) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = loadCases();
  if (args.agent) cases = cases.filter((c) => c.agent === args.agent);
  if (args.caseId) cases = cases.filter((c) => c.id === args.caseId);
  if (args.suite) cases = cases.filter((c) => c.kind === args.suite);

  if (args.list) {
    for (const c of cases) console.log(`${c.id.padEnd(28)} ${c.agent.padEnd(28)} ${c.kind}`);
    return;
  }
  if (cases.length === 0) {
    console.log('No cases selected.');
    return;
  }

  const mode = args.live ? 'live' : 'simulate';
  console.log(`\nagents evals — ${mode} mode${args.live ? ` (${MODEL})` : ''} — ${cases.length} case(s)\n`);
  const results = [];
  for (const testCase of cases) {
    process.stdout.write(`• ${testCase.id.padEnd(28)} `);
    let outcome;
    try {
      outcome = args.live ? await runLive(testCase) : await runSimulate(testCase);
    } catch (err) {
      outcome = { status: 'failed', eventSource: null, sideEffectKinds: [], logs: [], error: err instanceof Error ? err.message : String(err), reply: null };
    }
    const checks = checkExpectations(testCase, outcome);
    // Judge only chat cases: there the model reply IS the user-facing deliverable
    // the rubric describes. For scheduled/triage/capture the "reply" is internal
    // JSON the handler post-processes, so its routing/side-effect checks are the
    // real gate, not an LLM grade of the raw completion.
    const verdict = args.judge && args.live && testCase.kind === 'chat' ? judge(testCase, outcome.reply) : null;
    // A case may deliberately expect a failure (e.g. a required-input guard throw);
    // only treat an unexpected failed status as an automatic fail.
    const expectsFailure = (testCase.expect?.status ?? null) === 'failed';
    const passed = checks.every((c) => c.pass) && (expectsFailure || outcome.status !== 'failed') && (verdict ? verdict.pass === true : true);
    results.push({ id: testCase.id, agent: testCase.agent, kind: testCase.kind, passed, checks, outcome, verdict });
    const tag = passed ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${checks.map((c) => `${c.pass ? '✓' : '✗'}${c.name}`).join(' ')}${verdict ? `  judge:${verdict.pass}` : ''}${outcome.error ? `  ERR:${outcome.error.slice(0, 80)}` : ''}`);
    if (args.live && outcome.reply) console.log(`    ↳ reply: ${outcome.reply.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  const pass = results.filter((r) => r.passed).length;
  console.log(`\n${pass}/${results.length} passed\n`);

  const outDir = path.join(RUNS_DIR, STAMP);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ mode, model: args.live ? MODEL : null, results }, null, 2));
  const md = [`# agents evals — ${mode}`, '', `${pass}/${results.length} passed`, '', ...results.map((r) => `- ${r.passed ? '✅' : '❌'} \`${r.id}\` (${r.agent})${r.verdict ? ` — judge: ${r.verdict.pass} (${r.verdict.reason})` : ''}`)].join('\n');
  writeFileSync(path.join(outDir, 'summary.md'), md);
  console.log(`artifacts: ${path.relative(ROOT, outDir)}/{result.json,summary.md}`);
  process.exitCode = pass === results.length ? 0 : 1;
}

main();
