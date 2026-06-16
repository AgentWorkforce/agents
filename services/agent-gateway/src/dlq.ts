import type { AgentEvent } from "./envelope-builder.js";
import { RelayFileClient } from "./relayfile-client.js";

const DEFAULT_RELAYFILE_URL = "https://api.relayfile.dev";

export type DlqWriteInput = {
  workspace: string;
  agentId: string;
  event: AgentEvent;
  errorMessage?: string;
  relayfileAccessToken: string;
  relayfileUrl?: string;
};

export type DlqRecord = {
  path: string;
  workspace: string;
  agentId: string;
  event: AgentEvent;
  error: string;
  failedAt: string;
};

export async function writeGatewayDlqRecord(
  input: DlqWriteInput,
): Promise<DlqRecord> {
  const path = buildDlqPath(input.workspace, input.event.id);
  const record: DlqRecord = {
    path,
    workspace: input.workspace,
    agentId: input.agentId,
    event: input.event,
    error: input.errorMessage ?? "delivery failed",
    failedAt: new Date().toISOString(),
  };

  const client = new RelayFileClient({
    baseUrl: normalizeRelayfileUrl(input.relayfileUrl),
    token: input.relayfileAccessToken,
  });
  await client.writeFile({
    workspaceId: input.workspace,
    path,
    baseRevision: "*",
    content: JSON.stringify(record, null, 2),
    contentType: "application/json",
  });

  return record;
}

export function buildDlqPath(workspace: string, eventId: string): string {
  return `/_dlq/${encodePathSegment(workspace, "workspace")}/${encodePathSegment(eventId, "eventId")}.json`;
}

function normalizeRelayfileUrl(relayfileUrl?: string): string {
  const trimmed = relayfileUrl?.trim();
  if (!trimmed) {
    return DEFAULT_RELAYFILE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function encodePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return encodeURIComponent(trimmed);
}
