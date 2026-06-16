import { resolveRelaycastUrl } from "@/lib/workspace-registry";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";

export type FactorySpawnCapability = "spawn:claude" | "spawn:codex" | "workflow:run";

export type FactorySpawnInput = {
  name: string;
  capability: FactorySpawnCapability;
  workspaceId: string;
  invocationId: string;
  task?: string;
  model?: string;
  persona?: string;
  repo?: string;
  clonePath?: string;
  channel?: string;
  recipe?: "single" | "workflow" | "team";
  issue?: {
    id: string;
    key: string;
    title: string;
    path: string;
  };
  workflow?: string;
  inputs?: Record<string, unknown>;
};

export type FactorySpawnResult = {
  name: string;
  invocationId: string;
  sessionRef?: string;
};

export interface FactoryFleetEmitter {
  spawn(input: FactorySpawnInput): Promise<FactorySpawnResult>;
}

type RelaycastInvokeResponse = {
  data?: {
    invocation_id?: unknown;
    invocationId?: unknown;
    session_ref?: unknown;
    sessionRef?: unknown;
  };
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function capabilityToCli(capability: FactorySpawnCapability): string | null {
  if (capability === "spawn:claude") return "claude";
  if (capability === "spawn:codex") return "codex";
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export class RelaycastFactoryFleetEmitter implements FactoryFleetEmitter {
  async spawn(input: FactorySpawnInput): Promise<FactorySpawnResult> {
    const relayWorkspace = await resolveOrProvisionRelayWorkspace({
      userId: input.inputs?.deployerUserId as string || "factory-cloud-worker",
      appWorkspaceId: input.workspaceId,
      name: "factory",
    });
    const action = input.capability === "workflow:run" ? "workflow:run" : "spawn";
    const response = await fetch(
      `${trimTrailingSlash(resolveRelaycastUrl())}/v1/actions/${encodeURIComponent(action)}/invoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${relayWorkspace.relaycastApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          invocation_id: input.invocationId,
          input: actionInput(input),
        }),
      },
    );
    const payload = (await response.json().catch(() => null)) as RelaycastInvokeResponse | null;
    const invocationId =
      readString(payload?.data?.invocation_id) ??
      readString(payload?.data?.invocationId) ??
      input.invocationId;
    if (!response.ok) {
      throw new Error(`RelayFleetClient.spawn failed: ${response.status} ${response.statusText}`);
    }

    return {
      name: input.name,
      invocationId,
      sessionRef: readString(payload?.data?.session_ref) ?? readString(payload?.data?.sessionRef),
    };
  }
}

function actionInput(input: FactorySpawnInput): Record<string, unknown> {
  if (input.capability === "workflow:run") {
    return {
      name: input.name,
      workflow: input.workflow,
      inputs: input.inputs ?? {},
      task: input.task,
      channel: input.channel,
      factory: factoryMetadata(input),
    };
  }

  return {
    name: input.name,
    cli: capabilityToCli(input.capability),
    task: input.task,
    model: input.model,
    channel: input.channel,
    persona: input.persona,
    repo: input.repo,
    clone_path: input.clonePath,
    factory: factoryMetadata(input),
  };
}

function factoryMetadata(input: FactorySpawnInput): Record<string, unknown> {
  return {
    recipe: input.recipe,
    issue: input.issue,
    workspaceId: input.workspaceId,
    invocationId: input.invocationId,
    capability: input.capability,
  };
}

type PackageRelayFleetClientCtor = new () => {
  spawn(input: FactorySpawnInput): Promise<{ name?: string; sessionRef?: string; invocationId?: string }>;
};

async function loadPackageRelayFleetClient(): Promise<PackageRelayFleetClientCtor | null> {
  try {
    const importer = Function("specifier", "return import(specifier)") as
      (specifier: string) => Promise<{ RelayFleetClient?: PackageRelayFleetClientCtor }>;
    return (await importer("@agent-relay/factory")).RelayFleetClient ?? null;
  } catch {
    return null;
  }
}

export async function createDefaultFactoryFleetEmitter(): Promise<FactoryFleetEmitter> {
  const PackageClient = await loadPackageRelayFleetClient();
  if (PackageClient) {
    const client = new PackageClient();
    return {
      async spawn(input) {
        const result = await client.spawn(input);
        return {
          name: result.name ?? input.name,
          invocationId: result.invocationId ?? input.invocationId,
          sessionRef: result.sessionRef,
        };
      },
    };
  }

  return new RelaycastFactoryFleetEmitter();
}
