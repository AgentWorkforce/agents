const DEFAULT_RELAYFILE_BASE_URL = "https://api.relayfile.dev";

type TokenProvider = string | (() => string | Promise<string>);

export type RelayFileClientOptions = {
  baseUrl?: string;
  token: TokenProvider;
  fetchImpl?: typeof fetch;
};

export type RelayFileApiErrorPayload = {
  code?: string;
  message?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
};

export class RelayFileApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, payload: RelayFileApiErrorPayload = {}) {
    super(payload.message ?? `RelayFile API error: ${status}`);
    this.name = "RelayFileApiError";
    this.status = status;
    this.code = payload.code ?? "unknown_error";
    this.correlationId = payload.correlationId;
    this.details = payload.details;
  }
}

export type FileReadResponse = {
  path: string;
  revision: string;
  contentType: string;
  content: string;
  contentHash?: string;
};

export type FileQueryItem = {
  path: string;
  revision: string;
  contentType: string;
  size: number;
  lastEditedAt: string;
};

export type FileQueryResponse = {
  items: FileQueryItem[];
  nextCursor: string | null;
};

export type EventFeedResponse = {
  events: FilesystemEvent[];
  nextCursor: string | null;
};

export type FilesystemEvent = {
  eventId: string;
  type: string;
  path: string;
  revision: string;
  timestamp: string;
  provider?: string;
  origin?: string;
  correlationId?: string;
};

export type ResourceAtEventResult = {
  path: string;
  data: unknown;
  digest?: string;
  url?: string;
};

export type ChangeLogQueryResult = {
  events: any[];
};

export type WriteQueuedResponse = {
  opId?: string;
  status?: string;
};

export type QueryFilesOptions = {
  path?: string;
  provider?: string;
  relation?: string;
  permission?: string;
  comment?: string;
  cursor?: string;
  limit?: number;
  forkId?: string;
  properties?: Record<string, string>;
};

export type WriteFileInput = {
  workspaceId: string;
  path: string;
  baseRevision?: string;
  content: string;
  contentType?: string;
  encoding?: string;
  semantics?: unknown;
  contentIdentity?: string | { kind: string; key: string };
  forkId?: string;
};

export type DeleteFileInput = {
  workspaceId: string;
  path: string;
  baseRevision?: string;
  forkId?: string;
};

export type ProactiveRequestContext = {
  workspace?: string;
  workspaceId?: string;
  token?: string;
};

export type WebSocketConnection = {
  on(event: "error" | "close", handler: (event: unknown) => void): void;
  close(): void;
  unsubscribe(): void;
};

export class RelayFileClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RelayFileClientOptions) {
    this.baseUrl = normalizeRelayfileUrl(options.baseUrl);
    this.tokenProvider = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async getToken(): Promise<string> {
    const token =
      typeof this.tokenProvider === "function"
        ? await this.tokenProvider()
        : this.tokenProvider;
    return token.trim();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async readFile(
    workspaceOrInput: string | { workspaceId: string; path: string; token?: string },
    path?: string,
  ): Promise<FileReadResponse> {
    const input =
      typeof workspaceOrInput === "string"
        ? { workspaceId: workspaceOrInput, path: path ?? "" }
        : workspaceOrInput;
    const query = buildQuery({ path: input.path });
    return this.request({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/fs/file${query}`,
      tokenOverride: input.token,
    });
  }

  async queryFiles(
    workspaceId: string,
    options: QueryFilesOptions = {},
  ): Promise<FileQueryResponse> {
    return this.request({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/query${buildQuery({
        path: options.path,
        provider: options.provider,
        relation: options.relation,
        permission: options.permission,
        comment: options.comment,
        cursor: options.cursor,
        limit: options.limit,
        forkId: options.forkId,
        properties: options.properties,
      })}`,
    });
  }

  async writeFile(input: WriteFileInput): Promise<WriteQueuedResponse> {
    return this.request({
      method: "PUT",
      path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/fs/file${buildQuery({
        path: input.path,
        forkId: input.forkId,
      })}`,
      headers: input.baseRevision ? { "If-Match": input.baseRevision } : undefined,
      body: {
        contentType: input.contentType ?? "text/markdown",
        content: input.content,
        encoding: input.encoding,
        semantics: input.semantics,
        ...(input.contentIdentity ? { contentIdentity: input.contentIdentity } : {}),
      },
    });
  }

  async deleteFile(input: DeleteFileInput): Promise<WriteQueuedResponse> {
    return this.request({
      method: "DELETE",
      path: `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/fs/file${buildQuery({
        path: input.path,
        forkId: input.forkId,
      })}`,
      headers: input.baseRevision ? { "If-Match": input.baseRevision } : undefined,
    });
  }

  async getEvents(
    workspaceId: string,
    options: { provider?: string; cursor?: string; limit?: number } = {},
  ): Promise<EventFeedResponse> {
    return this.request({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/events${buildQuery(options)}`,
    });
  }

  async getResourceAtEvent(
    eventId: string,
    context: ProactiveRequestContext = {},
  ): Promise<ResourceAtEventResult> {
    const workspaceId = resolveContextWorkspace(context);
    return this.request({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/changes/resource${buildQuery({ eventId })}`,
      tokenOverride: context.token,
    });
  }

  async listChangesSince(
    since: string,
    context: ProactiveRequestContext = {},
  ): Promise<ChangeLogQueryResult> {
    const workspaceId = resolveContextWorkspace(context);
    return this.request({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/changes${buildQuery({ since })}`,
      tokenOverride: context.token,
    });
  }

  async listLastNChanges(
    last: number,
    context: ProactiveRequestContext = {},
  ): Promise<ChangeLogQueryResult> {
    const workspaceId = resolveContextWorkspace(context);
    return this.request({
      method: "GET",
      path: `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/changes${buildQuery({ last })}`,
      tokenOverride: context.token,
    });
  }

  connectWebSocket(
    workspaceId: string,
    options: { token?: string; onEvent?: (event: unknown) => void } = {},
  ): WebSocketConnection {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/ws`,
      `${this.baseUrl}/`,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", options.token ?? resolveSyncToken(this.tokenProvider));

    const socket = new WebSocket(url.toString());
    if (options.onEvent) {
      socket.addEventListener("message", (event) => {
        try {
          options.onEvent?.(JSON.parse(String(event.data)));
        } catch {
          options.onEvent?.(event.data);
        }
      });
    }

    return {
      on(event, handler) {
        socket.addEventListener(event, handler as EventListener);
      },
      close() {
        socket.close();
      },
      unsubscribe() {
        socket.close();
      },
    };
  }

  private async request<T>(params: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    tokenOverride?: string;
  }): Promise<T> {
    const headers = new Headers(params.headers);
    headers.set("Authorization", `Bearer ${params.tokenOverride ?? await this.getToken()}`);
    if (params.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await this.fetchImpl(`${this.baseUrl}${params.path}`, {
      method: params.method,
      headers,
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      throwRelayFileApiError(response.status, payload);
    }
    return payload as T;
  }
}

export function isRelayFileApiError(
  error: unknown,
): error is RelayFileApiError {
  return (
    error instanceof RelayFileApiError
    || (
      error instanceof Error
      && error.name === "RelayFileApiError"
      && typeof (error as { status?: unknown }).status === "number"
      && typeof (error as { code?: unknown }).code === "string"
    )
  );
}

function normalizeRelayfileUrl(relayfileUrl?: string): string {
  const trimmed = relayfileUrl?.trim();
  return (trimmed || DEFAULT_RELAYFILE_BASE_URL).replace(/\/+$/, "");
}

function buildQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "properties" && typeof value === "object" && !Array.isArray(value)) {
      for (const [propertyKey, propertyValue] of Object.entries(value as Record<string, unknown>)) {
        if (propertyKey && propertyValue !== undefined) {
          params.set(`property.${propertyKey}`, String(propertyValue));
        }
      }
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

function resolveContextWorkspace(context: ProactiveRequestContext): string {
  const workspace = context.workspaceId?.trim() || context.workspace?.trim();
  if (!workspace) {
    throw new Error("RelayFile proactive-runtime APIs require a workspace-scoped JWT with a workspace_id claim.");
  }
  return workspace;
}

function resolveSyncToken(tokenProvider: TokenProvider): string {
  if (typeof tokenProvider !== "function") {
    return tokenProvider.trim();
  }
  const token = tokenProvider();
  if (typeof token !== "string") {
    throw new Error("RelayFile websocket token provider must be synchronous");
  }
  return token.trim();
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
  return { message: await response.text() };
}

function throwRelayFileApiError(status: number, payload: unknown): never {
  const data =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  throw new RelayFileApiError(status, {
    code: typeof data.code === "string" ? data.code : "api_error",
    message: typeof data.message === "string" ? data.message : `HTTP ${status}`,
    correlationId:
      typeof data.correlationId === "string" ? data.correlationId : undefined,
    details:
      data.details && typeof data.details === "object" && !Array.isArray(data.details)
        ? data.details as Record<string, unknown>
        : undefined,
  });
}
