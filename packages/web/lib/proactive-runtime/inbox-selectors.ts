function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function translatePersonaRelayToInboxSelectors(input: {
  persona: unknown;
  agent?: unknown;
  rawPersona?: unknown;
  rawAgent?: unknown;
}): string[] {
  return dedupeInboxSelectors([
    ...readInboxSelectorsFromAgent(input.rawAgent),
    ...readInboxSelectorsFromAgent(input.agent),
    ...readInboxSelectorsFromPersonaRelay(input.rawPersona),
    ...readInboxSelectorsFromPersonaRelay(input.persona),
  ]);
}

function readInboxSelectorsFromPersonaRelay(persona: unknown): string[] {
  if (!isRecord(persona) || !isRecord(persona.relay)) {
    return [];
  }
  const relay = persona.relay;
  if (relay.enabled === false) {
    return [];
  }
  return normalizeInboxSelectors([relay.inbox, relay.channels]);
}

function readInboxSelectorsFromAgent(agent: unknown): string[] {
  if (!isRecord(agent)) {
    return [];
  }
  return normalizeInboxSelectors(agent.inbox);
}

function normalizeInboxSelectors(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    const selector = normalizeInboxSelector(value);
    return selector ? [selector] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeInboxSelectors(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  return normalizeInboxSelectors(
    value.selector
      ?? value.selectors
      ?? value.channel
      ?? value.channels,
  );
}

function normalizeInboxSelector(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "@self") {
    return "@self";
  }
  if (trimmed.startsWith("@")) {
    return null;
  }
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

function dedupeInboxSelectors(selectors: string[]): string[] {
  return [...new Set(selectors)].sort();
}
