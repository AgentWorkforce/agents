import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWN_TRIGGER_PROVIDER_ALIASES,
  lintTriggers,
  type AgentSpec
} from '@agentworkforce/persona-kit';
import { compileAgentSource } from './compile-agent.js';
import type { DeployPreflight } from './types.js';

/**
 * Load + parse + validate a persona AND its agent for the deploy surface.
 * Returns the frozen-shape preflight on success, throws with a field-pointed
 * error on validation failure.
 *
 * Deploy preflight is stricter than the persona-kit parser: the parser
 * accepts any persona, valid or not for deploy; this function enforces
 * the deploy-specific cross-field rules (cloud:true, onEvent on disk, the
 * agent declares at least one listener, and every provider the agent triggers
 * on is also declared as a persona integration connection) so the
 * orchestrator never gets a half-valid spec.
 */
export async function preflightPersona(personaPath: string): Promise<DeployPreflight> {
  const absPath = path.resolve(personaPath);
  const personaDir = path.dirname(absPath);
  // One compiler entry point handles both single-file presets and the
  // established split persona/agent form. Source modules are evaluated once.
  const compiled = await compileAgentSource(absPath);
  const persona = compiled.persona;

  if (persona.cloud !== true) {
    throw new Error(
      `persona "${persona.id}" is not opted into deploy (set "cloud": true to enable workforce deploy)`
    );
  }

  if (!persona.onEvent) {
    throw new Error(
      `persona "${persona.id}" declares cloud:true but is missing "onEvent" (path to the agent file)`
    );
  }

  const onEventPath = compiled.handlerEntry;
  const onEventStat = await stat(onEventPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new Error(
        `persona "${persona.id}" onEvent file not found at ${onEventPath} (relative to ${personaDir})`
      );
    }
    throw err;
  });
  if (!onEventStat.isFile()) {
    throw new Error(`onEvent path ${onEventPath} is not a regular file`);
  }

  const agent = compiled.agent;

  const hasTriggers = !!agent.triggers && Object.values(agent.triggers).some((t) => (t?.length ?? 0) > 0);
  const hasSchedules = (agent.schedules?.length ?? 0) > 0;
  const hasWatch = (agent.watch?.length ?? 0) > 0;
  const hasDispatcherLaunch = agent.launchedBy === 'team-dispatcher';
  if (!hasTriggers && !hasSchedules && !hasWatch && !hasDispatcherLaunch) {
    throw new Error(
      `agent "${persona.id}" (${persona.onEvent}) declares no listeners — add at least one trigger, schedule, or watch rule, ` +
        `or set launchedBy: "team-dispatcher" for dispatcher-launched team members`
    );
  }

  // Every provider the agent triggers on must have a matching integration
  // *connection* on the persona, so the deploy CLI can connect it.
  if (agent.triggers) {
    const declared = new Set(Object.keys(persona.integrations ?? {}));
    const missing = Object.keys(agent.triggers).filter((provider) => !declared.has(provider));
    if (missing.length > 0) {
      throw new Error(
        `agent "${persona.id}" triggers on provider(s) [${missing.join(', ')}] that the persona does not connect — ` +
          `add ${missing.map((p) => `integrations.${p}`).join(', ')} to the persona (connection config: { source?, scope? }).`
      );
    }
  }

  for (const [provider, integration] of Object.entries(persona.integrations ?? {})) {
    const enabledByInput = integration.enabledByInput;
    if (enabledByInput && !Object.prototype.hasOwnProperty.call(persona.inputs ?? {}, enabledByInput)) {
      throw new Error(
        `persona "${persona.id}" integration "${provider}" is enabled by input "${enabledByInput}", ` +
          `but persona.inputs does not declare ${enabledByInput}`
      );
    }
  }

  // Normalize trigger provider aliases to canonical names so the cloud API
  // receives e.g. 'gmail' instead of 'google-mail'. The integration-provider
  // check above runs against the raw (alias) form — the persona and agent can
  // both use 'google-mail' and the check still passes. Only the outbound
  // agent spec sent to the cloud needs canonical names.
  const normalizedAgent = normalizeTriggerProviderAliases(agent);

  const triggerLint = lintTriggers(normalizedAgent);
  const warnings = triggerLint.map(
    (issue) => `${issue.path}: ${issue.message}`
  );

  return {
    persona,
    agent: normalizedAgent,
    personaPath: absPath,
    personaDir,
    onEventPath,
    schedules: (agent.schedules ?? []).map((s) => s.name),
    integrations: persona.integrations ? Object.keys(persona.integrations) : [],
    warnings,
    ...(compiled.sourceKind === 'single-file' ? { compiledAgent: compiled } : {})
  };
}

/**
 * Replace alias trigger provider names with their canonical counterparts so
 * the cloud API never sees a name it doesn't recognise. E.g. 'google-mail'
 * (the integration provider id) → 'gmail' (the trigger catalog name).
 * The persona's `integrations` map is left untouched — the cloud resolves
 * integrations and triggers under different namespaces.
 */
function normalizeTriggerProviderAliases(agent: AgentSpec): AgentSpec {
  const { triggers } = agent;
  if (!triggers) return agent;
  const aliases = KNOWN_TRIGGER_PROVIDER_ALIASES as Record<string, string>;
  const normalized: NonNullable<AgentSpec['triggers']> = {};
  for (const [provider, list] of Object.entries(triggers)) {
    normalized[aliases[provider] ?? provider] = list;
  }
  return { ...agent, triggers: normalized };
}
