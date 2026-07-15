import type {
  PersonaInputSpec,
  PersonaSpec,
  PersonaMemoryScope
} from '@agentworkforce/persona-kit';

/**
 * Source of an event delivered to a persona's `onEvent` handler. The
 * runtime narrows the rest of the envelope based on this discriminator.
 *
 * Sources today: `cron` (schedule tick), the Tier-1 Relayfile providers
 * (`github`, `linear`, `slack`, `notion`, `jira`). Additional sources land
 * as cloud proactive-runtime milestones M2/M3 ship.
 */
export type WorkforceEventSource =
  | 'cron'
  | 'github'
  | 'linear'
  | 'slack'
  | 'notion'
  | 'jira';

/** Common envelope fields every event carries, regardless of source. */
interface WorkforceEventBase {
  /** Stable, idempotency-safe identifier; the runtime dedupes on this. */
  id: string;
  /** ISO timestamp the event fired at the source (not at delivery). */
  occurredAt: string;
  /** Delivery attempt count, 1 for first delivery. */
  attempt: number;
  /** Workspace this event is scoped to. */
  workspaceId: string;
}

export interface WorkforceCronEvent extends WorkforceEventBase {
  source: 'cron';
  /** Schedule name as declared in the persona's `schedules[].name`. */
  name: string;
  /** The persona's resolved cron expression for the schedule. */
  cron: string;
}

/** Provider-specific event payload — kept loose for v1. */
export interface WorkforceProviderEvent extends WorkforceEventBase {
  source: Exclude<WorkforceEventSource, 'cron'>;
  /** Provider-normalized event name (e.g. `pull_request.opened`). */
  type: string;
  /** Raw provider payload, normalized by the Relayfile adapter. */
  payload: unknown;
  /** Optional summary the gateway computed (M2). Missing on M1. */
  summary?: {
    title?: string;
    status?: string;
    actor?: string;
    [key: string]: unknown;
  };
}

export function unwrapResourceRecord<T = unknown>(payload: unknown): T | unknown {
  const resource = isRecord(payload) && 'resource' in payload ? payload.resource : payload;
  return isRecord(resource) && 'payload' in resource ? resource.payload : resource;
}

export interface LinearIssueReference {
  id: string;
  identifier?: string;
  title?: string;
  url?: string;
}

export interface LinearAgentSession {
  id: string;
  issue?: LinearIssueReference;
  [key: string]: unknown;
}

export type LinearAgentActivityType =
  | 'action'
  | 'elicitation'
  | 'error'
  | 'response'
  | 'thought';

export interface LinearAgentActivity {
  type?: LinearAgentActivityType | string;
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
}

export interface LinearAgentSessionPayload {
  type: 'AgentSessionEvent';
  action: 'created' | 'prompted' | string;
  agentSession: LinearAgentSession;
  agentActivity?: LinearAgentActivity & {
    id?: string;
    agentSessionId?: string;
    content?: LinearAgentActivity;
    [key: string]: unknown;
  };
  issue?: LinearIssueReference;
  promptContext?: string;
  notification?: {
    issue?: LinearIssueReference;
    comment?: { id?: string; body?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LinearAppUserNotificationPayload {
  type: 'AppUserNotification';
  action: 'issueCommentMention' | string;
  issue?: LinearIssueReference;
  comment?: { id?: string; body?: string; [key: string]: unknown };
  notification?: {
    issue?: LinearIssueReference;
    comment?: { id?: string; body?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface LinearWrappedPayload<TRecord> {
  resource: {
    payload: TRecord;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type LinearAgentSessionEventPayload =
  LinearWrappedPayload<LinearAgentSessionPayload> & {
    agentSession?: LinearAgentSession;
    agentActivity?: LinearAgentSessionPayload['agentActivity'];
    issue?: LinearIssueReference;
    promptContext?: string;
  };

export type LinearAppUserNotificationEventPayload =
  LinearWrappedPayload<LinearAppUserNotificationPayload> & {
    issue?: LinearIssueReference;
    comment?: { id?: string; body?: string; [key: string]: unknown };
    notification?: LinearAppUserNotificationPayload['notification'];
  };

export type LinearAgentSessionEvent =
  | (Omit<WorkforceProviderEvent, 'payload' | 'source' | 'type'> & {
      source: 'linear';
      type: 'AgentSessionEvent.created' | 'AgentSessionEvent.prompted';
      payload: LinearAgentSessionEventPayload;
    })
  | (Omit<WorkforceProviderEvent, 'payload' | 'source' | 'type'> & {
      source: 'linear';
      type: 'AppUserNotification.issueCommentMention';
      payload: LinearAppUserNotificationEventPayload;
    });

export type WorkforceEvent = WorkforceCronEvent | LinearAgentSessionEvent | WorkforceProviderEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Result of a harness invocation. The runtime translates whatever the
 * underlying harness streamed into this minimal shape.
 */
export interface HarnessRunResult {
  /** Final stdout/output from the harness. */
  output: string;
  /** Process exit code; 0 on success. */
  exitCode: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Optional usage metadata emitted by a harness or launcher. */
  usage?: HarnessUsage;
}

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  provider?: string;
  costUsd?: number;
  raw?: unknown;
}

export interface HarnessRunArgs {
  /** Prompt or task description handed to the harness. */
  prompt: string;
  /** Working directory inside the sandbox; defaults to ctx.sandbox.cwd. */
  cwd?: string;
  /** Override or extend the persona's `inputs` for this run. */
  inputs?: Record<string, string>;
  /** Environment overrides merged on top of the persona's `env`. */
  env?: Record<string, string>;
}

export interface SandboxExecArgs {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SandboxExecResult {
  output: string;
  exitCode: number;
}

export interface SandboxContext {
  /** Absolute path the runner sees as its working tree. */
  cwd: string;
  exec(cmd: string, opts?: SandboxExecArgs): Promise<SandboxExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface FilesContext {
  /** Read a Relayfile/sandbox-visible file. */
  read(path: string): Promise<string>;
  /** Write a Relayfile/sandbox-visible file. */
  write(path: string, contents: string): Promise<void>;
}

export interface RelayfileCredentials {
  url: string;
  token: string;
  workspaceId: string;
}

export interface CloudApiCredentials {
  url: string;
  token: string;
}

export interface RequiredRuntimeCredentials {
  relayfile: RelayfileCredentials;
  cloudApi: CloudApiCredentials;
}

export interface CredentialsContext {
  readonly relayfile: RelayfileCredentials;
  readonly cloudApi: CloudApiCredentials;
  tryRequire(): RequiredRuntimeCredentials | null;
  require(): RequiredRuntimeCredentials;
}

export interface MemorySaveOptions {
  tags?: string[];
  scope?: PersonaMemoryScope;
  /** Optional expiry in seconds from now. */
  ttlSeconds?: number;
  /** Optional expiry in milliseconds from now. */
  expiresInMs?: number;
}

export interface MemoryRecallOptions {
  limit?: number;
  scope?: PersonaMemoryScope;
  scopes?: PersonaMemoryScope[];
  tags?: string[];
}

export interface MemoryItem {
  id: string;
  content: string;
  tags: string[];
  scope: PersonaMemoryScope;
  createdAt: string;
}

export interface MemoryContext {
  save(content: string, opts?: MemorySaveOptions): Promise<{ id: string } | void>;
  recall(query: string, opts?: MemoryRecallOptions): Promise<MemoryItem[]>;
}

export interface WorkflowRunHandle {
  runId: string;
  completion(): Promise<{ output: unknown; status: 'success' | 'failure' }>;
}

export interface WorkflowContext {
  run(name: string, args?: Record<string, unknown>): Promise<WorkflowRunHandle>;
  status(runId: string): Promise<{ status: 'pending' | 'running' | 'success' | 'failure'; output?: unknown; error?: string; patches?: unknown }>;
}

export interface ScheduleContext {
  at(when: Date, payload: unknown): Promise<void>;
  cancel(name: string): Promise<void>;
}

/**
 * Minimal LLM context for handlers that want raw inference (without
 * spawning the persona's full harness). Backed by either workforce-billed
 * tokens or the user's connected subscription, per the persona's
 * `useSubscription` flag.
 */
export interface LlmContext {
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
}

export interface WorkforcePersonaContext extends Omit<PersonaSpec, 'inputs'> {
  /** Resolved input values from the agent row and persona defaults. */
  readonly inputs: Record<string, string>;
  /** Raw persona input declarations for consumers that need metadata/defaults. */
  readonly inputSpecs: Record<string, PersonaInputSpec>;
}

export interface WorkforceAgentContext {
  readonly id: string;
  readonly deployedName: string;
  readonly spawnedByAgentId: string | null;
}

export interface WorkforceDeploymentContext {
  readonly id: string;
  readonly triggerKind: 'inbox' | 'clock' | 'radio';
  readonly parentDeploymentId: string | null;
}

/** A single decision in the compacted trajectory contract. */
export interface TrajectoryDecisionRecord {
  question: string;
  chosen: string;
  reasoning: string;
  alternatives: Array<{ option: string; reason?: string }>;
}

/** Retrospective subset carried in the compacted trajectory contract. */
export interface TrajectoryRetrospectiveRecord {
  summary: string;
  approach: string;
  learnings: string[];
  confidence: number;
}

/**
 * Compacted, contract-shaped trajectory artifact emitted once per completed
 * (or abandoned) run. This is the frozen A↔B interface consumed by the
 * ai-hist trajectory sync source — one JSON file per run at
 * `$TRAJECTORY_ROOT/<personaId>/compacted/<id>.json`. It deliberately omits
 * the `type:"compacted"` / `sourceTrajectories[]` markers of `trail compact`
 * aggregates so ai-hist's defensive ingest filter keeps it.
 */
export interface CompactedTrajectoryContract {
  id: string;
  version: number;
  personaId: string;
  projectId: string | null;
  task: { title: string; description: string | null };
  status: 'active' | 'completed' | 'abandoned' | string;
  startedAt: string;
  completedAt: string | null;
  decisions: TrajectoryDecisionRecord[];
  retrospective: TrajectoryRetrospectiveRecord | null;
}

/**
 * Auto-recording trajectory surface. Handlers narrate their decision
 * trajectory (the WHY) through these methods; the runtime opens a trajectory
 * around each run and emits the compacted contract on completion. Every method
 * is safe to call even when recording is disabled (no `memory.trajectories`
 * opt-in, or no resolvable `TRAJECTORY_ROOT`) — it then no-ops.
 */
export interface TrajectoryContext {
  /** Open a new logical phase of work within the run. */
  chapter(title: string): Promise<void>;
  /** Record a free-form observation. */
  note(content: string): Promise<void>;
  /** Record a structured decision and the alternatives considered. */
  decide(
    question: string,
    chosen: string,
    reasoning: string,
    alternatives?: Array<{ option: string; reason?: string }>
  ): Promise<void>;
  /** Record an error encountered while working. */
  error(content: string): Promise<void>;
  /**
   * Finish the run with a retrospective. Optional — when the handler does not
   * call it, the runner auto-finalizes on return. Idempotent: the first
   * `done`/auto-finalize wins.
   */
  done(summary: string, confidence: number): Promise<void>;
}

/**
 * The context object handlers receive on every event invocation.
 * Provider data is accessed via the VFS helpers exported from the runtime
 * (listJsonFiles / readJsonFile / writeJsonFile) using provider path
 * conventions (e.g. /linear/issues, /slack/channels).
 */
export interface WorkforceCtx {
  /** Read-only persona metadata plus resolved runtime inputs. */
  readonly persona: WorkforcePersonaContext;
  /** Agent row metadata for the agent handling this event. */
  readonly agent: WorkforceAgentContext;
  /** Deployment row metadata for the trigger that fired this handler. */
  readonly deployment: WorkforceDeploymentContext;
  /** Workspace the agent is deployed into. */
  readonly workspaceId: string;
  /** Logical agent name (defaults to `persona.id`). */
  readonly agentName: string;
  /** Raw inference, billed or subscription-backed per persona config. */
  llm: LlmContext;
  /** Spawn the persona's harness inside the sandbox. */
  harness: {
    run(args: HarnessRunArgs): Promise<HarnessRunResult>;
  };
  /** Sandbox shell + filesystem. */
  sandbox: SandboxContext;
  /** Relayfile/sandbox file helpers for handlers that should not shell out. */
  files: FilesContext;
  /** Runtime credentials populated by the cloud persona launcher. */
  credentials: CredentialsContext;
  /** Persistent memory (no-op when persona.memory is false or unset). */
  memory: MemoryContext;
  /** Cloud workflows invocation (HTTP). */
  workflow: WorkflowContext;
  /** Schedule one-off follow-up ticks. */
  schedule: ScheduleContext;
  /**
   * Auto-recorded decision trajectory (the WHY). No-op when recording is
   * disabled (no `persona.memory.trajectories` opt-in or no resolvable
   * `TRAJECTORY_ROOT`), so it is always safe to call from a handler.
   */
  trajectory: TrajectoryContext;
  /** Structured logger; every line is forwarded to the gateway. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, attrs?: Record<string, unknown>) => void;
}

/**
 * Default-export shape from a persona's `onEvent` file. The runtime calls
 * this with a fully-constructed ctx and the discriminated event.
 *
 * Errors thrown from `onEvent` are caught by the runtime, logged, and (per
 * persona `options.onError` defaults) retried with backoff.
 */
export type WorkforceHandler = (ctx: WorkforceCtx, event: WorkforceEvent) => Promise<void> | void;

/**
 * Public type returned by `handler(...)`. Identity at runtime; the wrapper
 * exists for type narrowing + future-proofing (we may add metadata, e.g.
 * declared capabilities, to the returned function later).
 */
export interface WorkforceHandlerExport {
  (ctx: WorkforceCtx, event: WorkforceEvent): Promise<void> | void;
  readonly __workforceHandler: true;
}
