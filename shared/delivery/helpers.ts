import type { WorkforceCtx } from '@agentworkforce/runtime';

/**
 * Resolve a persona input value from the runtime ctx.
 *
 * Resolution order (mirrors persona-kit): ctx.persona.inputs (already
 * resolved from agent value → env → default by the runtime) → fall back
 * to process.env directly when running outside the full runtime.
 */
export function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  // ctx.persona.inputs is already resolved by the runtime (agent value →
  // env → default). Check it first since it reflects the canonical value.
  const fromCtx = ctx.persona.inputs?.[name];
  if (fromCtx && String(fromCtx).trim()) return String(fromCtx).trim();
  // Fall back to raw process.env for local dev outside the full runtime.
  const fromEnv = process.env[spec?.env ?? name];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  // Last resort: the spec default.
  const def = spec?.default;
  if (def != null && String(def).trim()) return String(def).trim();
  return undefined;
}

/**
 * Split a comma-separated string into trimmed, non-empty entries.
 */
export function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Race a promise against a timeout. On timeout the timer rejects with an
 * Error so the caller can catch and fall back. Always clears the timer.
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Fetch with an AbortController timeout. Returns the response on success,
 * or undefined on timeout/network error (never throws). Preserves caller-
 * provided signal by racing our abort against it.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = 8_000
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? anySignal([controller.signal, init.signal])
    : controller.signal;
  try {
    return await fetch(url, { ...init, signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Combine multiple AbortSignals — any one firing aborts the fetch. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}
