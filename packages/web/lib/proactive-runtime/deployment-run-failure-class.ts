export type DeploymentRunFailureClass =
  | "success"
  | "bootstrap_failed"
  | "bundle_unavailable"
  | "dep_install_failed"
  | "runner_error"
  | "mount_failure"
  | "writeback_undelivered"
  | "cleanup_warning";

export type DeploymentRunFailureInput = {
  status: string | null | undefined;
  exitCode: number | null | undefined;
  error: string | null | undefined;
  stdout?: string | null | undefined;
  stderr?: string | null | undefined;
  mountLogTail?: string | null | undefined;
  cleanupStatus?: unknown;
};

function textIncludesAny(text: string, needles: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

/**
 * A writeback was DROPPED, not delivered — the cloud-side twin of the local
 * durable-ack guarantee (cloud#2029). Fires ONLY on the conjunction:
 *
 *   (this run wrote a command-root draft)
 *     AND (pendingWriteback > 0 OR states.hasPendingWriteback OR states.outboxNeedsAttention)
 *
 * The conjunction is what keeps this from false-alarming. A read-only run that
 * drafted nothing stays silent even on a backlog-poisoned mount (so it composes
 * with cloud#2013's "a teardown flush timeout must not fail a clean run"). All
 * pending signals are read from the canonical `<mount>/.relay/state.json` the
 * mount/outbox writes — never inferred from a stamped sync `revision`, which is
 * NOT proof of delivery (live repro rev_160432: synced-but-undispatched).
 *
 * The pending signal is widened beyond the legacy `pendingWriteback` count so it
 * survives the relayfile #264 mount upgrade (v0.8.20), which moves the durable-
 * outbox backlog into `states.hasPendingWriteback` / `states.outboxNeedsAttention`
 * (top-level `outbox.pending`). `hasPendingWriteback` already covers local pending
 * on v0.8.19, so this is backward-safe: absent flags → false, never throws, and
 * a pre-#264 run behaves identically to the pendingWriteback-only gate.
 *
 * The pending signals widen PENDING (upload/sync-layer) coverage. They are
 * ORTHOGONAL to the synced-but-not-adapter-dispatched DISPATCH gap (a draft can
 * clear pending yet never reach Slack — live repro rev_160432). That gap is
 * closed by the POSITIVE adapter-dispatch-receipt signal `commandDraftsUndeliverable`
 * (cloud#2029 #1b): when a receipt-aware mount (relayfile PR2) emits it, the gate
 * fires on a this-run draft that has no terminal-good receipt. It's feature-
 * detected — a pre-receipt mount emits `null` and the gate falls back to the
 * pending signals, so pre/post-receipt runs both behave correctly.
 */
export function cleanupIndicatesWritebackUndelivered(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = value as Record<string, unknown>;
  if (status.mountConfigured !== true) {
    return false;
  }
  const wroteCommandDraft = status.commandDraftWrittenThisRun === true;
  if (!wroteCommandDraft) {
    return false;
  }
  const pendingWriteback =
    typeof status.pendingWriteback === "number" ? status.pendingWriteback : 0;
  const hasPendingWriteback = status.hasPendingWriteback === true;
  const outboxNeedsAttention = status.outboxNeedsAttention === true;
  const writebackPending =
    pendingWriteback > 0 || hasPendingWriteback || outboxNeedsAttention;
  // cloud#2029 #1b: POSITIVE adapter-dispatch-receipt gate (feature-detected).
  // A receipt-aware mount (relayfile PR2) emits `commandDraftsUndeliverable` —
  // the count of this-run drafts with no positive dispatch receipt
  // (failed/dead-lettered, never-uploaded, or never-enqueued; benign in-flight
  // with a committed opId is excluded — the server owns delivery past teardown).
  // When present, fire on it directly: this CLOSES the synced-but-undispatched
  // DISPATCH gap (rev_160432) that the pending (upload/sync-layer) signals are
  // blind to. The pending signals are kept as a secondary catch. A pre-receipt
  // mount emits `null` → fall back to the pending gate, identical to before.
  const undeliverable =
    typeof status.commandDraftsUndeliverable === "number"
      ? status.commandDraftsUndeliverable
      : null;
  if (undeliverable !== null) {
    return undeliverable > 0 || writebackPending;
  }
  return writebackPending;
}

function cleanupHasWarning(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = value as Record<string, unknown>;
  const mountConfigured = status.mountConfigured === true;
  const flushExitCode = typeof status.flushExitCode === "number" ? status.flushExitCode : null;
  const killExitCode = typeof status.killExitCode === "number" ? status.killExitCode : null;
  const scriptCompleted = status.scriptCompleted === true;

  return (
    (mountConfigured && !scriptCompleted) ||
    (flushExitCode !== null && flushExitCode !== 0) ||
    (killExitCode !== null && killExitCode !== 0)
  );
}

function isSuccessStatus(status: string): boolean {
  return status === "succeeded" || status === "success";
}

function isFailureStatus(status: string): boolean {
  return ["failed", "failure", "error", "errored", "cancelled", "canceled"].includes(status);
}

export function deriveDeploymentRunFailureClass(
  input: DeploymentRunFailureInput,
): DeploymentRunFailureClass {
  const status = input.status?.toLowerCase() ?? "";
  const hasError = typeof input.error === "string" && input.error.trim().length > 0;
  const combinedText = [
    input.error,
    input.stdout,
    input.stderr,
    input.mountLogTail,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  const hasCleanupWarning = cleanupHasWarning(input.cleanupStatus);

  // A dropped writeback must be LOUD even when the run otherwise looks clean.
  // The teardown flush can be rescued to exit 0 (the `-newer` pending probe is
  // blind to a backlog older than the run's flush marker), so this is checked
  // BEFORE the success short-circuit — never let a "succeeded" status bury a
  // command-root draft that never delivered (cloud#2029).
  if (cleanupIndicatesWritebackUndelivered(input.cleanupStatus)) {
    return "writeback_undelivered";
  }

  if (!hasError && (isSuccessStatus(status) || (input.exitCode === 0 && !isFailureStatus(status)))) {
    return hasCleanupWarning ? "cleanup_warning" : "success";
  }

  if (textIncludesAny(combinedText, ["bundle_unavailable", "persisted bundle", "redeploy under cold-start runtime"])) {
    return "bundle_unavailable";
  }

  if (
    textIncludesAny(combinedText, [
      "npm install",
      "runtime load failed",
      "cannot find package",
      "module not found",
      "enoent: no such file or directory, open 'package.json'",
    ])
  ) {
    return "dep_install_failed";
  }

  if (
    textIncludesAny(combinedText, [
      "relayfile mount",
      "relayfile-mount",
      "relayfile_mount",
      "mount token",
      "failed to flush relayfile mount",
    ])
  ) {
    return "mount_failure";
  }

  if (
    textIncludesAny(combinedText, [
      "tick_delivery_failed",
      "deployment_run_",
      "sandbox terminal",
      "sandbox missing",
      "provisioning",
      "start_unsupported",
      "poll_unsupported",
    ])
  ) {
    return "bootstrap_failed";
  }

  return "runner_error";
}
