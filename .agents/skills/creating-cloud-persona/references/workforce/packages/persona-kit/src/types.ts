import type {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  PERMISSION_MODES,
  PERSONA_INTENTS,
  SIDECAR_MD_MODES,
  SKILL_SOURCE_KINDS
} from './constants.js';

export type Harness = (typeof HARNESS_VALUES)[number];
export type PersonaIntent = (typeof PERSONA_INTENTS)[number];
/**
 * Runtime persona tag — intentionally an open `string`. The CLI uses this for
 * arbitrary-tag catalog filtering (`--filter-tag`), and `parseTags` accepts any
 * string for forward-compatibility, so this is NOT a closed enum.
 *
 * For *authoring*, {@link KnownPersonaTag} (constants.ts) is the closed
 * vocabulary the cloud enforces — `definePersona` types `tags` against it so an
 * off-vocabulary tag is a compile error. Two distinct types on purpose:
 * runtime-open here, authoring-closed there.
 */
export type PersonaTag = string;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number];
export type SidecarMdMode = (typeof SIDECAR_MD_MODES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

export interface HarnessSettings {
  reasoning: 'low' | 'medium' | 'high';
  timeoutSeconds: number;
  /**
   * Codex CLI sandbox mode for model-generated shell commands. Prefer
   * `workspace-write` with `workspaceWriteNetworkAccess` when network is the only
   * missing capability; `danger-full-access` is the fully unsandboxed fallback.
   */
  sandboxMode?: CodexSandboxMode;
  /**
   * @deprecated
   * @description `--ask-for-approval` was removed in codex 0.1.77+. Use `dangerouslyBypassApprovalsAndSandbox` or `sandboxMode` instead. Setting this field emits a warning and has no effect.
   */
  approvalPolicy?: CodexApprovalPolicy;
  /**
   * Allow outbound network access inside Codex's workspace-write sandbox
   * (`sandbox_workspace_write.network_access`).
   */
  workspaceWriteNetworkAccess?: boolean;
  /** Enable the Codex live web-search tool for this runtime. */
  webSearch?: boolean;
  /**
   * Emit codex's single `--dangerously-bypass-approvals-and-sandbox` flag,
   * which collapses "no sandbox + never ask for approval" and also
   * suppresses codex's interactive "are you sure?" startup confirmation.
   * Mutually exclusive with `sandboxMode`, `approvalPolicy`, and
   * `workspaceWriteNetworkAccess` — those translate to the two-flag form
   * which still prompts.
   */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** Consumer-defined harness settings are forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * A skill is a named, reusable capability attached to a persona.
 * `source` points to canonical guidance the persona should apply
 * (e.g. a prpm.dev package URL, an internal runbook, a docs page).
 */
export interface PersonaSkill {
  id: string;
  source: string;
  description: string;
  /** Consumer-defined skill metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * Prompt-visible runtime input declared by a persona. Inputs are for
 * non-secret run configuration such as output paths, target package names, or
 * mode switches. Launchers resolve each input from explicit values, the
 * process environment, or `default`, then substitute `$NAME` / `${NAME}` in
 * the system prompt before spawning the harness.
 */
export interface PersonaInputSpec {
  /** Human-readable explanation shown in docs/catalog UIs. */
  description?: string;
  /**
   * Environment variable to read when the launcher did not provide an
   * explicit value. Defaults to the input key itself.
   */
  env?: string;
  /** Literal fallback used when neither an explicit value nor env var exists. */
  default?: string;
  /**
   * When true, the input is allowed to resolve to an empty string. The
   * launcher substitutes `$NAME` with `''` rather than throwing
   * `MissingPersonaInputError`. Use for inputs whose absence is meaningful
   * — e.g. an upstream task description that may or may not be forwarded —
   * and prefer non-optional inputs with a `default` for everything else so
   * misconfigured launches surface loudly.
   */
  optional?: boolean;
  /**
   * Declares that this input's value is an id chosen from a live list backed
   * by an integration connection (e.g. a Slack user id, a Linear team id).
   * When set, the deploy CLI offers the operator a picker right after the
   * provider's OAuth connect — fetching the options through the cloud and
   * writing the chosen id into this input — instead of making them paste a
   * raw id. Purely an onboarding affordance: the runtime still resolves the
   * value the usual way (explicit value → env → default), so a `picker` can
   * coexist with `env`/`default`/`optional`.
   */
  picker?: PersonaInputPicker;
  /** Consumer-defined input metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * How the deploy CLI sources a picker's options for a {@link PersonaInputSpec}.
 * `provider` must be one the persona declares under `integrations` (so it is
 * connected before the picker runs). `resource` names what to list from that
 * provider — known values today are `users`, `channels` (Slack), and `teams`
 * (Linear); the value is passed through to the cloud, so new resources don't
 * require a persona-kit release.
 */
export interface PersonaInputPicker {
  /** Integration provider whose connection backs the option list (e.g. `slack`, `linear`). */
  provider: string;
  /** Resource to list from that provider (e.g. `users`, `channels`, `teams`). */
  resource: string;
  /** Consumer-defined picker metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * Persona-level permission policy for the harness session. Translates to the
 * harness's native allow/deny/mode flags at spawn time. Tool-pattern syntax is
 * passed through verbatim — `"mcp__posthog"` to allow every posthog MCP tool,
 * `"mcp__posthog__projects-get"` for a specific one, `"Bash(git *)"` for a
 * shell pattern. See the target harness's docs for the exact grammar.
 */
export interface PersonaPermissions {
  /** Tool names/patterns to auto-approve. */
  allow?: string[];
  /** Tool names/patterns to always block. */
  deny?: string[];
  /** Permission mode for the session. */
  mode?: PermissionMode;
  /** Consumer-defined permission metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * Relayfile mount policy for interactive sessions. Patterns use gitignore
 * syntax. `ignoredPatterns` are omitted from the mount entirely;
 * `readonlyPatterns` are copied into the mount but edits do not sync back.
 * Launchers may merge these with project-level `.agentignore` /
 * `.agentreadonly` dotfiles.
 */
export interface PersonaMount {
  /**
   * Whether launchers should create a Relayfile mount for this persona.
   * Defaults to true when omitted so existing mount policies keep working.
   */
  enabled?: boolean;
  ignoredPatterns?: string[];
  readonlyPatterns?: string[];
  /** Consumer-defined mount metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * MCP server config, structured to match Claude Code's `--mcp-config` JSON
 * verbatim so the whole object can be passed through untouched. Values inside
 * `headers` / `env` / `args` / `url` / `command` may be literal strings or
 * `$VAR` / `${VAR}` references. Resolution happens in the runner/CLI at spawn
 * time — this package only defines the shape, not the interpolation policy.
 */
export type McpServerSpec =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      [key: string]: unknown;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      [key: string]: unknown;
    };

/**
 * A single event trigger declared by an **agent** (`agent.ts`). `on` is a
 * Relayfile-adapter-normalized event name (e.g. `pull_request.opened`,
 * `issue.create`, `message.created`). `match` and `where` are filter sugars
 * the deploy CLI lints against a known registry; unknown values warn but
 * do not fail parse, so the cloud runtime stays the source of truth.
 *
 * Triggers live on the agent ({@link AgentSpec.triggers}), not the persona —
 * the persona only declares which providers it connects to
 * ({@link PersonaIntegrationConfig}). The deploy CLI joins the two: events
 * from `agent.triggers[provider]`, connection/scope from
 * `persona.integrations[provider]`.
 *
 * Examples:
 *   { on: "pull_request.opened" }
 *   { on: "pull_request_review_comment.created", match: "@mention" }
 *   { on: "check_run.completed", where: "conclusion=failure" }
 *   { on: "message.created", paths: ["/slack/channels/C_REVIEW/**"] }
 *   { on: "message.created", maxConcurrency: 1 }
 */
export interface PersonaIntegrationTrigger {
  on: string;
  match?: string;
  where?: string;
  /**
   * Optional Relayfile path globs used to scope wake routing before an agent is
   * provisioned. Paths are absolute (leading `/`) and provider-specific.
   */
  paths?: string[];
  /**
   * Optional delivery backpressure hint for this trigger. Positive integers are
   * preserved by the parser; invalid values are treated as unset so older or
   * malformed specs do not block delivery.
   */
  maxConcurrency?: number;
  /** Consumer-defined trigger fields are forwarded to the cloud unchanged. */
  [key: string]: unknown;
}

/**
 * Discriminator on how the cloud-side integration resolver should look up
 * the connection backing a persona's declared integration:
 *
 * - `deployer_user` — resolve via `user_integrations` keyed by the deploying
 *   user (the default; matches today's behavior).
 * - `workspace` — resolve via the workspace's default `workspace_integrations`
 *   row for this provider.
 * - `workspace_service_account` — resolve via a named workspace service
 *   account (e.g. `release-bot`), letting one workspace expose multiple
 *   provider identities.
 *
 * The persona-kit only validates the shape; the cloud resolver enforces
 * which sources are actually permitted at deploy time.
 */
export type IntegrationSource =
  | { kind: 'deployer_user'; [key: string]: unknown }
  | { kind: 'workspace'; [key: string]: unknown }
  | { kind: 'workspace_service_account'; name: string; [key: string]: unknown };

/**
 * Per-provider **connection** configuration for a RelayFile provider. The map
 * key is the provider slug (`github`, `linear`, `slack`, `notion`, `jira`).
 * `scope` is provider-specific filter metadata (e.g. `{ repo: "org/repo" }`
 * for github, `{ database: "<id>" }` for notion).
 *
 * This declares only *that the persona connects to the provider* and how the
 * connection resolves — **not** which events fire it. Event triggers live on
 * the agent ({@link AgentSpec.triggers}); the deploy CLI requires every
 * provider in `agent.triggers` to also appear here so the connection is set up.
 *
 * `source` discriminates the cloud-side resolver between `user_integrations`
 * and `workspace_integrations`; defaults to `{ kind: 'deployer_user' }` when
 * omitted so existing personas keep their pre-discriminator behavior.
 *
 * `config` is a forward-compatible adapter passthrough. Persona-kit validates
 * only that it is an object; provider adapters own the nested schema
 * (for example GitHub materialization policy).
 *
 * Optional integrations are deploy-time choices controlled by persona inputs:
 * set `optional: true` and `enabledByInput: "SLACK_CHANNEL"` to include this
 * provider only when that input resolves to a non-empty value. Inactive
 * optional providers are skipped before deploy connects integrations or
 * registers provider triggers.
 */
export interface PersonaIntegrationConfig {
  source?: IntegrationSource;
  scope?: Record<string, string>;
  config?: Record<string, unknown>;
  optional?: boolean;
  enabledByInput?: string;
  /** Consumer-defined connection fields are forwarded to the cloud unchanged. */
  [key: string]: unknown;
}

/**
 * Clock listener configuration declared by an **agent** ({@link AgentSpec.schedules}).
 * `name` is unique within the agent and surfaces to the handler as
 * `event.name`. `cron` is a standard 5-field expression. `tz` defaults to
 * `UTC` at the runtime layer (the parser keeps it optional so the spec stays
 * close to what the author wrote).
 */
export interface PersonaSchedule {
  name: string;
  cron: string;
  tz?: string;
  /** Consumer-defined schedule fields are forwarded to the cloud unchanged. */
  [key: string]: unknown;
}

export type WatchEvent = 'created' | 'updated' | 'deleted';

/**
 * Relayfile-change listener configuration declared by an **agent**
 * ({@link AgentSpec.watch}). `paths` are absolute Relayfile glob roots (for
 * example `/integrations/github/repos/acme/web/issues/*.json`). Runtime
 * matching is owned by the cloud trigger router; persona-kit only validates
 * the portable declaration shape.
 */
export interface WatchRule {
  paths: string[];
  events: WatchEvent[];
  debounceMs?: number;
  match?: string;
  /** Consumer-defined watch fields are forwarded to the cloud unchanged. */
  [key: string]: unknown;
}

/**
 * Runtime-parsed shape of an **agent** (`agent.ts`) — the "when/how it fires"
 * half of a deployed agent, authored via `defineAgent(...)` in the runtime
 * package and extracted from the bundle by the deploy CLI. The persona owns
 * "what the agent is" (model, harness, skills, mcp, integration *connections*);
 * the agent owns the listeners.
 *
 * `launchedBy: "team-dispatcher"` is the one listener-free exception: team
 * member agents are not event-listeners themselves; they are launched by a
 * dispatcher agent as part of a team run.
 *
 * Three listener kinds:
 *  - **radio** — {@link triggers}: a provider-keyed map of
 *    {@link PersonaIntegrationTrigger} arrays. Keys mirror
 *    `persona.integrations` so the deploy CLI can join events→connection.
 *  - **clock** — {@link schedules}: cron {@link PersonaSchedule}s.
 *  - **relayfile** — {@link watch}: {@link WatchRule}s.
 *
 * At least one listener is required for a cloud agent unless `launchedBy`
 * names a supported dispatcher launch mode (enforced at deploy).
 */
export interface AgentSpec {
  /** Declares that this agent is launched by another runtime path, not direct listeners. */
  launchedBy?: 'team-dispatcher';
  /** Radio listeners keyed by provider slug (`github`, `linear`, …). */
  triggers?: Record<string, PersonaIntegrationTrigger[]>;
  /** Cron-style clock listeners. Each `name` is unique within the agent. */
  schedules?: PersonaSchedule[];
  /** Relayfile-change listeners for proactive cloud agents. */
  watch?: WatchRule[];
  /** Consumer-defined agent fields are forwarded to the cloud unchanged. */
  [key: string]: unknown;
}

/**
 * Memory scope semantics, mirroring the agent-assistant memory adapter:
 * `workspace` memory persists across users in a workspace, `user` memory
 * follows an individual user's invocations, and `global` memory is shared
 * across every invocation of the deployed agent.
 */
export type PersonaMemoryScope = 'workspace' | 'user' | 'global';

/**
 * Long-form memory configuration. Defaults are applied by the runtime,
 * not the parser — the spec keeps only what the author actually wrote.
 * `enabled` defaults to true when the object form is present.
 */
export interface PersonaMemoryConfig {
  enabled?: boolean;
  scopes?: PersonaMemoryScope[];
  ttlDays?: number;
  autoPromote?: boolean;
  dedupMs?: number;
  /**
   * Opt into decision-trajectory recording (the "why"). **Off by default.**
   * When enabled, the runtime auto-records this persona's decisions per run and
   * writes a compacted contract artifact to
   * `<root>/<personaId>/compacted/<runId>.json` (root = `TRAJECTORY_ROOT` env or
   * the cloud workspace default). Object form lets you toggle compaction.
   */
  trajectories?: boolean | PersonaTrajectoryConfig;
  /**
   * Opt into ai-memory recall (the "how" + "why" retrieval). **Off by default.**
   * When enabled, the persona loads the ai-hist MCP so it can recall its own
   * compacted trajectories (the why) and cross-tool prompt/session history
   * (the how). Object form lets you override the history DB path.
   */
  aiMemory?: boolean | PersonaAiMemoryConfig;
  /** Consumer-defined memory metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * Decision-trajectory recording config (the "why"). `enabled` defaults to true
 * in object form, so `{ autoCompact: false }` means "record, don't compact".
 * The store root is never per-persona — it's resolved once from
 * `TRAJECTORY_ROOT` (or the cloud default) so the recorder's write-root always
 * matches the ai-hist MCP's read-root.
 */
export interface PersonaTrajectoryConfig {
  enabled?: boolean;
  /** Run mechanical+markdown compaction on completion. Defaults to true. */
  autoCompact?: boolean;
  /** Consumer-defined trajectory metadata is forwarded unchanged. */
  [key: string]: unknown;
}

/**
 * ai-memory recall config (the "how" + "why" retrieval via the ai-hist MCP).
 * `enabled` defaults to true in object form.
 */
export interface PersonaAiMemoryConfig {
  enabled?: boolean;
  /** Override the ai-hist history DB path; else `AI_HIST_DB` env / discovery. */
  dbPath?: string;
  /** Consumer-defined AI-memory metadata is forwarded unchanged. */
  [key: string]: unknown;
}

export type PersonaMemory = boolean | PersonaMemoryConfig;

/**
 * Relay (agent-relay / relaycast) participation config. Like {@link
 * PersonaMemoryConfig}, the persona declares **intent** only — the API key and
 * base URL are secrets that come from workforce env (`RELAY_API_KEY`,
 * `RELAY_BASE_URL`). When enabled, launchers inject the relaycast MCP server
 * (see `buildRelaycastMcpServer`) so the persona is a first-class chat
 * participant: it can post to channels, DM, and answer replies — the
 * human-in-the-loop surface a solo persona otherwise lacks.
 */
export interface PersonaRelayConfig {
  /** Master switch. Object form defaults to enabled (`{}` ⇒ on). */
  enabled?: boolean;
  /**
   * Agent identity registered on relay (`RELAY_AGENT_NAME`). Defaults to the
   * env value, then the persona id. Must match the broker's routing name.
   */
  agentName?: string;
  /**
   * Relaycast channels the persona participates in (names may omit the leading
   * `#`). Declarative intent consumed when wiring inbox triggers (Unit C);
   * does not affect MCP injection on its own.
   */
  channels?: string[];
  /**
   * Relaycast inbox selectors the persona subscribes to (e.g. `@self`, `#eng`),
   * mirroring the SDK `AgentDefinition.inbox` contract.
   */
  inbox?: string[];
  /** Default relay workspace (`RELAY_DEFAULT_WORKSPACE`); else env. */
  defaultWorkspace?: string;
  /** Consumer-defined relay metadata is forwarded unchanged. */
  [key: string]: unknown;
}

export type PersonaRelay = boolean | PersonaRelayConfig;

export type CapabilityValue =
  | boolean
  | { enabled?: boolean; [k: string]: unknown };

export interface PersonaHttpReadRule {
  method: 'GET' | 'HEAD';
  urlGlob: string;
}

export type PersonaHttpReadCapability = {
  enabled?: boolean;
  allow?: PersonaHttpReadRule[];
};

/**
 * Portable proactive capability declarations.
 *
 * A capability is enabled when its value is `true` or an object whose
 * `.enabled !== false` (`{}` is enabled; `{ enabled: false }` is disabled).
 * `pullRequest` is the legacy alias of `review`; both map to the review
 * capability.
 */
export interface ProactiveCapabilities {
  /** Review a PR/MR diff and post a review. */
  review?: CapabilityValue;
  /** Claim an issue and open a change request. */
  issueClaim?: CapabilityValue;
  /** Rebase a dirty PR/MR. */
  conflictAutofix?: CapabilityValue;
  /** Legacy alias of `review`. */
  pullRequest?: CapabilityValue;
  /** Declarative local live-read allowlist for GET/HEAD URLs. */
  httpRead?: PersonaHttpReadCapability;
  /**
   * Consumer-defined capabilities pass through the parser unchanged. persona-kit
   * is platform-agnostic and must not drop capability keys it does not model
   * directly - e.g. the cloud-only `teamSolve` capability that drives
   * `cloud-team-issue` team-launch (workforce#182 / cloud#1732).
   */
  [capability: string]: CapabilityValue | undefined;
}

/**
 * A persona describes *what an agent is* — its identity, runtime (harness,
 * model, system prompt), skills, MCP servers, inputs, and which providers it
 * *connects* to ({@link integrations}). It does **not** describe when the
 * agent fires: event triggers, cron schedules, and relayfile watch rules live
 * on the agent ({@link AgentSpec}, authored via `defineAgent` in `agent.ts`).
 */
export interface PersonaSpec {
  id: string;
  intent: string;
  /**
   * Catalog labels from the closed {@link PERSONA_TAGS} vocabulary (e.g.
   * `['documentation', 'review']`); they do NOT overlap with {@link intent}.
   * The cloud rejects off-vocabulary tags with `400 invalid_persona`, and
   * `definePersona` types `tags` against {@link KnownPersonaTag} to catch that
   * at compile time. This parsed shape stays `string[]` for runtime leniency.
   * Optional; omitted, `null`, and empty-array values are treated identically.
   */
  tags?: readonly string[];
  description: string;
  skills: PersonaSkill[];
  /**
   * Prompt-visible runtime inputs. Keys must be env-style names
   * (`OUTPUT_PATH`, `TARGET_DIR`, etc.). Never put secrets here; resolved
   * values are substituted into the persona's system prompt.
   */
  inputs?: Record<string, PersonaInputSpec>;
  /**
   * Harness binary used to run this persona (`claude`, `codex`, `opencode`, `grok`).
   * Required for interactive personas. Optional for handler-style personas
   * ({@link onEvent} set): only consumed when the handler calls
   * `ctx.harness.run(...)`; pure orchestrators omit it.
   */
  harness?: Harness;
  /** Model identifier passed to the harness. Optional for handler-style personas — see {@link harness}. */
  model?: string;
  /** System prompt body. `$NAME` / `${NAME}` references to inputs are substituted at spawn time. Optional for handler-style personas — see {@link harness}. */
  systemPrompt?: string;
  /** Harness-level knobs (reasoning, timeout, codex sandbox/approval policy, etc.). */
  harnessSettings: HarnessSettings;
  /**
   * Environment variables injected into the harness child process.
   * Values may be literal strings or `$VAR` references resolved from the
   * caller's environment at spawn time.
   */
  env?: Record<string, string>;
  /**
   * MCP servers to attach to the harness session.
   * - `claude`: passed via `--mcp-config`
   * - `codex`: translated into `--config mcp_servers.<name>...` overrides
   * - `opencode` / `grok`: currently warn and skip
   */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Permission policy (allow/deny lists, mode) for the harness session.
   * `claude` is wired for allow/deny/mode flags (via `--allowedTools`,
   * `--disallowedTools`, `--permission-mode`). `grok` maps
   * `mode: "bypassPermissions"` to `--always-approve`; other
   * fields/harnesses warn and skip.
   */
  permissions?: PersonaPermissions;
  /**
   * Sandbox boot policy for this persona. Controls whether the runtime boots
   * an isolated sandbox (Daytona/process) for harness execution and file ops.
   *
   * - **`true`** (default) — always boot a sandbox. The persona can use
   *   `ctx.sandbox.exec()` to shell out, `ctx.files.read/write`, and
   *   `ctx.harness.run()`.
   * - **`false`** — skip sandbox boot entirely. Handler code reads provider
   *   data via the runtime's VFS helpers (`listJsonFiles` / `readJsonFile`
   *   / `writeJsonFile`) against provider path conventions (e.g.
   *   `/linear/issues`, `/slack/channels`) instead of `ctx.sandbox.exec(find …)`
   *   + `ctx.files.read()` loops. `ctx.harness.run()` still works.
   *   `ctx.sandbox.exec()` rejects with `SandboxNotAvailableError`.
   *
   * Setting this to `false` dramatically reduces cold-start latency
   * (no sandbox boot ≈ milliseconds vs seconds) and is appropriate for
   * read-mostly handler agents that consume pre-synced VFS data directly
   * rather than shell-globbing JSON files.
   */
  sandbox?: boolean;
  /**
   * Relayfile mount policy for file visibility and writability. Applied by
   * launchers that run the harness inside `@relayfile/local-mount`.
   */
  mount?: PersonaMount;
  /**
   * Author-supplied path to a `CLAUDE.md` sidecar that should be applied
   * when the persona runs under the claude harness. The path is relative
   * to the JSON file that declared the field; the loader resolves it to
   * an already-absolute path on the parsed spec. Built-in personas inline
   * the content into {@link PersonaSpec.claudeMdContent} at build time.
   */
  claudeMd?: string;
  /** Defaults to `overwrite`. See {@link SidecarMdMode}. */
  claudeMdMode?: SidecarMdMode;
  /**
   * Author-supplied path to an `AGENTS.md` sidecar that should be applied
   * when the persona runs under the opencode/codex/grok harnesses. Same resolution
   * rules as {@link claudeMd}.
   */
  agentsMd?: string;
  /** Defaults to `overwrite`. See {@link SidecarMdMode}. */
  agentsMdMode?: SidecarMdMode;
  /**
   * Inlined `CLAUDE.md` content for built-in personas. The catalog generator
   * reads the sibling `.md` at build time and emits its body here so the
   * installed package does not need to ship the file separately. Runtime
   * code prefers this over `claudeMd` when both are set.
   */
  claudeMdContent?: string;
  /** Inlined `AGENTS.md` content for built-in personas. */
  agentsMdContent?: string;
  /**
   * Opt this persona into the `workforce deploy` cloud-agent surface.
   * When `true`, the deploy CLI considers this persona a deployable agent
   * (validates {@link integrations} / {@link schedules}, prompts for
   * integration connect, bundles {@link onEvent}, hands off to the runtime).
   * Local `workforce agent <id>` flows ignore this flag — non-deploy use
   * keeps working unchanged.
   */
  cloud?: boolean;
  /**
   * When `true`, inference for this agent uses the user's connected LLM
   * subscription via `@agent-relay/cloud`'s provider link, rather than
   * workforce-billed tokens. The deploy CLI calls `connectProvider({...})`
   * at deploy time. Only meaningful when {@link cloud} is `true`.
   */
  useSubscription?: boolean;
  /**
   * Per-provider integration **connection** declarations keyed by Relayfile
   * provider slug (`github`, `linear`, `slack`, `notion`, `jira`). At deploy
   * time the CLI runs `RelayfileSetup.connectIntegration({ allowedIntegrations:
   * [key] })` for each provider not yet connected to the active workspace.
   * Event triggers are declared on the agent ({@link AgentSpec.triggers}), not
   * here — every provider an agent triggers on must also appear in this map.
   */
  integrations?: Record<string, PersonaIntegrationConfig>;
  /**
   * Portable proactive capability declarations. A capability is enabled when
   * its value is `true` or an object whose `.enabled !== false` (`{}` is
   * enabled; `{ enabled: false }` is disabled). `pullRequest` is the legacy
   * alias of `review`; both map to the review capability.
   */
  capabilities?: ProactiveCapabilities;
  /**
   * Memory subsystem opt-in. Wires the agent-assistant memory adapter at
   * runtime; the persona spec only declares intent, not implementation
   * details (api keys, adapter type, etc. come from workforce env).
   */
  memory?: PersonaMemory;
  /**
   * Relay (agent-relay / relaycast) participation. Off unless declared. When
   * enabled, launchers inject the relaycast MCP so the persona can post to
   * channels, DM, and answer replies — see {@link PersonaRelayConfig}. Secrets
   * (`RELAY_API_KEY`, `RELAY_BASE_URL`) come from workforce env, not the spec.
   */
  relay?: PersonaRelay;
  /**
   * Relative POSIX path to the TypeScript (or compiled .js / .mjs) file
   * whose default export is the deploy-time event handler. Resolved
   * relative to the persona JSON's directory at deploy time. Required by
   * the JSON Schema whenever {@link cloud} is `true` (any cloud persona
   * needs an entrypoint, regardless of whether triggers are declared); the
   * deploy CLI enforces the same rule. The parser itself keeps the field
   * optional so partially-authored specs still parse.
   */
  onEvent?: string;
  /** Consumer-defined persona fields are forwarded to downstream runtimes unchanged. */
  [key: string]: unknown;
}

export interface PersonaSelection {
  personaId: string;
  harness: Harness;
  model: string;
  systemPrompt: string;
  harnessSettings: HarnessSettings;
  skills: PersonaSkill[];
  rationale: string;
  inputs?: Record<string, PersonaInputSpec>;
  inputValues?: Record<string, string>;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
  mount?: PersonaMount;
  /**
   * Carried through from {@link PersonaSpec.memory}. Launchers read its opt-in
   * facets: `memory.aiMemory` gates injecting the `ai-hist` MCP (recall), and
   * `memory.trajectories` gates runtime decision-trajectory recording. Both are
   * off unless declared. Use {@link resolveAiMemory} / {@link resolveTrajectoryRecording}.
   */
  memory?: PersonaMemory;
  /**
   * Effective sidecar config for the persona. Modes default to `overwrite`
   * when a path or inlined content exists; otherwise the mode field is omitted.
   */
  claudeMd?: string;
  claudeMdContent?: string;
  claudeMdMode?: SidecarMdMode;
  agentsMd?: string;
  agentsMdContent?: string;
  agentsMdMode?: SidecarMdMode;
}

/** Per-harness rules for where skills land on disk and how to ask prpm for them. */
export interface HarnessSkillTarget {
  /** Value passed to `prpm install --as <flag>`. */
  asFlag: string;
  /** Directory (relative to repo root) where prpm drops the skill package. */
  dir: string;
}

/**
 * Options for {@link materializeSkills} / {@link materializeSkillsFor}.
 *
 * `installRoot` stages skills under an out-of-repo directory (typically
 * `~/.agentworkforce/workforce/sessions/<id>/claude/plugin`) that doubles as a Claude
 * Code plugin root. The SDK generates the scaffold (`.claude-plugin/plugin.json`
 * and a `skills` symlink pointing at `.claude/skills/`), prpm installs into
 * `<installRoot>/.claude/skills/<name>/`, and post-run cleanup removes the
 * entire `installRoot` in one `rm -rf` — no files ever touch the repo.
 *
 * Only honored for `harness === 'claude'`. Passing `installRoot` with another
 * harness throws. The caller must supply an absolute path; when the generated
 * install command runs, it `mkdir -p`s `installRoot` and any missing parents
 * needed for the scaffold (`.claude-plugin/`, `.claude/skills/`).
 */
export interface SkillMaterializationOptions {
  installRoot?: string;
  /**
   * Filesystem root that relative `local`-kind skill sources are resolved
   * against. When set, the local provider absolute-ifies a source like
   * `.agentworkforce/workforce/skills/foo.md` to `<repoRoot>/.agentworkforce/...`
   * before embedding it into the install command, so the `cp` survives the
   * `cd <installRoot>` prefix that session-mode installs add. Has no effect on
   * `prpm` / `skill.sh` skills. When unset, local sources are embedded as-is
   * and resolve against whatever cwd the caller runs the install command in.
   */
  repoRoot?: string;
}

export interface SkillInstall {
  skillId: string;
  /** Original `source` string from the persona JSON. */
  source: string;
  sourceKind: SkillSourceKind;
  /** Normalized package reference (e.g. `@prpm/npm-trusted-publishing`, `vercel-labs/skills#find-skills`). */
  packageRef: string;
  harness: Harness;
  /** argv-style command — safer than a shell string for execFile/spawn callers. */
  installCommand: readonly string[];
  /** Directory the skill is expected to land in after install. */
  installedDir: string;
  /** Path to the installed SKILL.md manifest (for prompt injection fallback). */
  installedManifest: string;
  /**
   * Paths the installer scatters outside of a durable lockfile — safe to
   * `rm -rf` once the persona run has read what it needs from them. The
   * provider's lockfile (`prpm.lock`, `skills-lock.json`, etc.) is deliberately
   * omitted so repeat runs can stay fast and reproducible.
   */
  cleanupPaths: readonly string[];
}

export interface SkillMaterializationPlan {
  harness: Harness;
  installs: SkillInstall[];
  /**
   * Absolute path to the out-of-repo stage directory, when the plan was
   * produced with {@link SkillMaterializationOptions.installRoot}. When set,
   * the install artifacts emit plugin scaffolding at this root and cleanup
   * removes the whole directory instead of individual skill paths.
   */
  sessionInstallRoot?: string;
  /**
   * Echoed from {@link SkillMaterializationOptions.repoRoot} so downstream
   * artifact builders (`buildInstallArtifacts`) can re-resolve `local` skill
   * sources to the same absolute paths the per-install commands embedded.
   */
  repoRoot?: string;
}

export interface PersonaInstallContext {
  /** Pure install plan for the persona's skills. Describes what would be installed and where, with no side effects. */
  readonly plan: SkillMaterializationPlan;
  /** Full install command in argv form, suitable for `execFile`/`spawn` without shell escaping concerns. */
  readonly command: readonly string[];
  /** Shell-escaped form of the full install command, convenient for `spawn(..., { shell: true })`. */
  readonly commandString: string;
  /**
   * Post-run cleanup command (argv form) that removes the ephemeral artifact
   * paths the provider scatters during install, leaving the provider lockfile
   * in place. Callers running the install themselves should run this **after**
   * the agent step consumes the skills, never before. For empty plans this is
   * a shell no-op (`:`).
   */
  readonly cleanupCommand: readonly string[];
  /** Shell-escaped form of {@link cleanupCommand}. */
  readonly cleanupCommandString: string;
}

/**
 * Return value of {@link usePersona}. A side-effect-free bundle of "what this
 * persona is" plus grouped install metadata. Nothing is installed, spawned, or
 * written to disk by constructing this object — run `install.commandString`
 * yourself when you are ready to materialize the persona's skills.
 */
export interface PersonaContext {
  /** Resolved persona choice for this intent/profile: identity, runtime, skills, and routing rationale. */
  readonly selection: PersonaSelection;
  /** Grouped install metadata for the resolved persona's skills. */
  readonly install: PersonaInstallContext;
}
