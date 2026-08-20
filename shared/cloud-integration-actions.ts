import type { WorkforceCtx } from '@agentworkforce/runtime';

export type CloudIntegrationActionBackend = 'nango' | 'composio';

export interface CloudIntegrationActionRequest {
  provider: string;
  action: string;
  input?: unknown;
  integrationName?: string;
  requestedBackend?: CloudIntegrationActionBackend;
}

export interface CloudIntegrationActionAccess {
  credentialSource: 'user' | 'workspace' | 'managed';
  endpointHost?: string;
}

export interface CloudIntegrationActionSuccess<T = unknown> {
  ok: true;
  provider: string;
  action: string;
  backend: CloudIntegrationActionBackend;
  result: T;
  integrationName?: string | null;
  access?: CloudIntegrationActionAccess;
}

export interface CloudIntegrationActionUpstreamError {
  type?: string;
  code?: string;
  status?: number;
  message?: string;
}

type CloudIntegrationActionFailure = {
  ok: false;
  code: string;
  error: string;
  backend?: string;
  upstream?: CloudIntegrationActionUpstreamError;
};

export interface CloudIntegrationActionClient {
  status: 'configured' | 'blocked';
  invoke<T = unknown>(request: CloudIntegrationActionRequest): Promise<CloudIntegrationActionSuccess<T>>;
}

export const BLOCKED_CLOUD_INTEGRATION_ACTION_CLIENT_REASON =
  'Cloud API credentials or Relayfile workspace context are unavailable in this runtime';
export const CLOUD_INTEGRATION_ACTION_TIMEOUT_MS = 30_000;

export class CloudIntegrationActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: {
      backend?: string;
      upstream?: CloudIntegrationActionUpstreamError;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CloudIntegrationActionError';
  }
}

const BLOCKED_CLIENT: CloudIntegrationActionClient = {
  status: 'blocked',
  async invoke() {
    throw new Error(BLOCKED_CLOUD_INTEGRATION_ACTION_CLIENT_REASON);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readAccessMetadata(value: unknown): CloudIntegrationActionAccess | null {
  if (!isRecord(value)) {
    return null;
  }

  const credentialSource = asString(value.credentialSource);
  const endpointHost = asString(value.endpointHost);
  if (
    credentialSource !== 'user'
    && credentialSource !== 'workspace'
    && credentialSource !== 'managed'
  ) {
    return null;
  }

  const access = {
    credentialSource,
    ...(endpointHost ? { endpointHost } : {}),
  };
  return access;
}

function readSuccessBody<T>(value: unknown): CloudIntegrationActionSuccess<T> | null {
  if (!isRecord(value) || value.ok !== true || !('result' in value)) {
    return null;
  }

  const provider = asString(value.provider);
  const action = asString(value.action);
  const backend = asString(value.backend);
  const integrationName = value.integrationName;
  let access: CloudIntegrationActionAccess | undefined;
  if ('access' in value) {
    const parsedAccess = readAccessMetadata(value.access);
    if (!parsedAccess) {
      return null;
    }
    access = parsedAccess;
  }
  if (
    !provider
    || !action
    || (backend !== 'nango' && backend !== 'composio')
    || (integrationName !== undefined && integrationName !== null && typeof integrationName !== 'string')
  ) {
    return null;
  }

  return {
    ok: true,
    provider,
    action,
    backend,
    result: value.result as T,
    ...(integrationName !== undefined ? { integrationName } : {}),
    ...(access ? { access } : {}),
  };
}

function readFailureBody(value: unknown): CloudIntegrationActionFailure | null {
  if (!isRecord(value) || value.ok !== false) {
    return null;
  }

  const code = asString(value.code);
  const error = asString(value.error);
  if (!code || !error) {
    return null;
  }

  const upstream = isRecord(value.upstream)
    ? {
        ...(asString(value.upstream.type) ? { type: asString(value.upstream.type) } : {}),
        ...(asString(value.upstream.code) ? { code: asString(value.upstream.code) } : {}),
        ...(asInteger(value.upstream.status) !== undefined
          ? { status: asInteger(value.upstream.status) }
          : {}),
        ...(asString(value.upstream.message) ? { message: asString(value.upstream.message) } : {}),
      }
    : undefined;

  return {
    ok: false,
    code,
    error,
    ...(asString(value.backend) ? { backend: asString(value.backend) } : {}),
    ...(upstream && Object.keys(upstream).length > 0 ? { upstream } : {}),
  };
}

export function createCloudIntegrationActionClient(
  ctx: WorkforceCtx,
  fetchImpl: typeof fetch = fetch,
): CloudIntegrationActionClient {
  const credentials = ctx.credentials.tryRequire();
  const cloudApi = credentials?.cloudApi;
  const relayfile = credentials?.relayfile;
  if (!cloudApi || !relayfile?.workspaceId) {
    return BLOCKED_CLIENT;
  }

  const baseUrl = cloudApi.url.replace(/\/+$/u, '');

  return {
    status: 'configured',
    async invoke<T = unknown>(request: CloudIntegrationActionRequest): Promise<CloudIntegrationActionSuccess<T>> {
      const provider = request.provider.trim();
      const action = request.action.trim();
      if (!provider || !action) {
        throw new CloudIntegrationActionError(
          'invalid_request',
          'Provider and action are required',
        );
      }

      const url =
        `${baseUrl}/api/v1/workspaces/${encodeURIComponent(relayfile.workspaceId)}`
        + `/integrations/${encodeURIComponent(provider)}/actions/${encodeURIComponent(action)}`;
      const body = {
        ...(request.input !== undefined ? { input: request.input } : {}),
        ...(request.integrationName ? { integrationName: request.integrationName } : {}),
        ...(request.requestedBackend ? { requestedBackend: request.requestedBackend } : {}),
      };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cloudApi.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CLOUD_INTEGRATION_ACTION_TIMEOUT_MS),
        });
      } catch {
        throw new CloudIntegrationActionError(
          'request_failed',
          'Cloud integration action request failed',
        );
      }

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = readFailureBody(payload);
        if (failure) {
          throw new CloudIntegrationActionError(
            failure.code,
            failure.error,
            {
              ...(failure.backend ? { backend: failure.backend } : {}),
              ...(failure.upstream ? { upstream: failure.upstream } : {}),
              status: response.status,
            },
          );
        }

        throw new CloudIntegrationActionError(
          'request_failed',
          `Cloud integration action request failed (${response.status})`,
          { status: response.status },
        );
      }

      const success = readSuccessBody<T>(payload);
      if (!success) {
        throw new CloudIntegrationActionError(
          'invalid_response',
          'Cloud integration action response was invalid',
          { status: response.status },
        );
      }

      return success;
    },
  };
}
