import {
  resolveRelayfileInternalHmacSecret,
  signRelayfileInternalRequest,
} from "./relayfile-writeback-auth";
import { resolveRelayfileConfig } from "../relayfile";
import {
  isAppWorkspaceId,
  isRelayWorkspaceId,
  readBoundRelayWorkspaceId,
} from "../workspaces/relay-workspace-binding";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

type RelayfileWritebackProvider =
  | "confluence"
  | "github"
  | "google-mail"
  | "jira"
  | "linear"
  | "notion"
  | "slack";

const DEFAULT_RELAYFILE_CREDENTIAL_PUSH_TIMEOUT_MS = 5000;

export type RelayfileIntegrationPushResult =
  | { ok: true; provider: RelayfileWritebackProvider; status: number }
  | {
      ok: false;
      provider: RelayfileWritebackProvider | null;
      status?: number;
      error: string;
      responseSnippet?: string;
    };

export async function pushRelayfileIntegrationCredential(
  integration: WorkspaceIntegrationRecord,
  options: { revoked?: boolean; updatedAt?: Date; timeoutMs?: number } = {},
): Promise<RelayfileIntegrationPushResult> {
  const provider = normalizeWritebackProvider(integration.provider);
  if (!provider) {
    return {
      ok: false,
      provider: null,
      error: `unsupported writeback provider: ${integration.provider}`,
    };
  }
  const relayWorkspaceId = await resolveRelayfileCredentialWorkspaceId(
    integration.workspaceId,
  );
  const credential = await resolveRelayfileCredentialPayload(
    integration,
    provider,
    options.revoked ?? false,
  );

  const body = JSON.stringify({
    provider,
    providerConfigKey: credential.providerConfigKey,
    connectionId: credential.connectionId,
    aliasFields: integration.metadata,
    revoked: options.revoked ?? false,
    updatedAt: (options.updatedAt ?? integration.updatedAt).toISOString(),
    writebackDispatchVia: integration.writebackDispatchVia ?? "bridge",
  });
  const timestamp = new Date().toISOString();
  const signature = signRelayfileInternalRequest(
    timestamp,
    body,
    resolveRelayfileInternalHmacSecret(),
  );
  const { relayfileUrl } = resolveRelayfileConfig();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_RELAYFILE_CREDENTIAL_PUSH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(
      `${relayfileUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(
        relayWorkspaceId,
      )}/integrations/${encodeURIComponent(provider)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signature,
          "X-Correlation-Id": crypto.randomUUID(),
        },
        body,
        signal: controller.signal,
      },
    );
  } catch (error) {
    const message = sanitizeLogSnippet(
      error instanceof Error ? error.message : String(error),
    );
    console.error("[relayfile] failed to push integration credential", {
      workspaceId: integration.workspaceId,
      relayWorkspaceId,
      provider,
      error: message,
    });
    return { ok: false, provider, error: message };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const responseSnippet = sanitizeLogSnippet(
      await safeResponseText(response),
    );
    console.error("[relayfile] failed to push integration credential", {
      workspaceId: integration.workspaceId,
      relayWorkspaceId,
      provider,
      status: response.status,
      responseSnippet,
    });
    return {
      ok: false,
      provider,
      status: response.status,
      error: `relayfile credential push returned ${response.status}`,
      responseSnippet,
    };
  }

  return { ok: true, provider, status: response.status };
}

async function resolveRelayfileCredentialPayload(
  integration: WorkspaceIntegrationRecord,
  provider: RelayfileWritebackProvider,
  revoked: boolean,
): Promise<{ providerConfigKey: string; connectionId: string }> {
  if (
    provider === "github" &&
    !revoked
  ) {
    const { isGithubInstallationCentricEnabled } = await import(
      "./github-installation-centric-flag"
    );
    if (isGithubInstallationCentricEnabled()) {
      const { resolveGithubConnectionForWorkspace } = await import(
        "./github-installation-connection"
      );
      const connection = await resolveGithubConnectionForWorkspace(
        integration.workspaceId,
      );
      if (connection) {
        return {
          providerConfigKey: connection.providerConfigKey,
          connectionId: connection.connectionId,
        };
      }
    }
  }

  return {
    providerConfigKey:
      integration.providerConfigKey?.trim() || integration.provider,
    connectionId: integration.connectionId,
  };
}

export function normalizeWritebackProvider(
  provider: string,
): RelayfileWritebackProvider | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized.startsWith("github")) return "github";
  if (
    normalized === "google-mail" ||
    normalized === "google-mail-relay" ||
    normalized === "gmail"
  ) {
    return "google-mail";
  }
  if (normalized.startsWith("slack")) return "slack";
  if (
    normalized === "confluence" ||
    normalized === "jira" ||
    normalized === "linear" ||
    normalized === "notion"
  ) {
    return normalized;
  }
  return null;
}

export async function resolveRelayfileCredentialWorkspaceId(
  workspaceId: string,
): Promise<string> {
  const normalized = workspaceId.trim();
  if (isRelayWorkspaceId(normalized)) {
    return normalized;
  }
  if (isAppWorkspaceId(normalized)) {
    const relayWorkspaceId = await readBoundRelayWorkspaceId(normalized);
    if (relayWorkspaceId) {
      return relayWorkspaceId;
    }
  }
  return normalized;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "unavailable response body";
  }
}

function sanitizeLogSnippet(value: string): string {
  return value
    .replace(
      /authorization\s*:\s*bearer\s+[^\s,;]+/gi,
      "authorization: Bearer [REDACTED]",
    )
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/token[=:]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .slice(0, 512);
}
