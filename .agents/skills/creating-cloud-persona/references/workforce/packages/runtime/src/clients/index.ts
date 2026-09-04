import {
  writeJsonFile as coreWriteJsonFile,
  normalizeWritebackStatus,
  WritebackError,
  type IntegrationClientOptions,
  type WritebackResult
} from '@relayfile/adapter-core/vfs-client';

// Shared VFS-backed transport surface. All provider interactions go through
// these helpers — no per-provider client code lives in the runtime.
//
// The transport itself now lives in the relayfile layer
// (`@relayfile/adapter-core/vfs-client`) — it's the generic Relayfile
// draft-write protocol, not anything workforce-specific. The runtime re-exports
// it so existing handlers that `import … from '@agentworkforce/runtime/clients'`
// keep working unchanged. The ergonomic per-provider clients live in
// `@relayfile/relay-helpers`.
export {
  draftFile,
  encodeSegment,
  listDirectoryEntries,
  listJsonFiles,
  readJsonFile,
  readTextFile,
  resolveMountRoot,
  RelayfileWritebackError,
  WritebackError,
  normalizeWritebackStatus,
  type RelayfileWritebackErrorOptions,
  type IntegrationClientOptions,
  type NormalizedWritebackState,
  type NormalizedWritebackStatus,
  type WritebackReceipt,
  type WritebackResult
} from '@relayfile/adapter-core/vfs-client';

export {
  WorkforceIntegrationError,
  type WorkforceIntegrationErrorOptions,
  SandboxNotAvailableError
} from '../errors.js';

export async function writeJsonFile(
  client: IntegrationClientOptions,
  provider: string,
  operation: string,
  relayPath: string,
  body: unknown
): Promise<WritebackResult> {
  const result = await coreWriteJsonFile(client, provider, operation, relayPath, body);
  const normalized = normalizeWritebackStatus(result);
  if (normalized.state !== 'succeeded') {
    if (client.writebackTimeoutMs === 0 && normalized.state === 'no_receipt') {
      return result;
    }
    throw new WritebackError(normalized);
  }
  return result;
}
