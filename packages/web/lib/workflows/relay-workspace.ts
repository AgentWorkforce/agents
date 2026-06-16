/**
 * Resolve the relay workspace for a workflow run — or provision + bind one
 * automatically on first use.
 *
 * Background: the `workspaces` table uses UUID primary keys, but relay
 * workspaces use `rw_xxxxxxxx` IDs and live in the separate
 * `relay_workspaces` table. Previously there was no stored binding between
 * the two, so the run route silently generated a fresh `rw_` ID every call
 * when `auth.workspaceId` wasn't `rw_`-format. That orphan ID never had a
 * DB row or a minted API key, the launcher dropped the empty `RELAY_API_KEY`
 * from the sandbox env, and the broker rejected with
 * "--register requires an API key (pass --api-key or set RELAY_API_KEY)".
 *
 * PR #242 closed the empty-key hole with a user-scoped fallback: reuse
 * the user's first existing relay workspace. That was correct for MVP but
 * meant all of a user's app workspaces shared one relay workspace. This
 * resolver uses the explicit `workspaces.relay_workspace_id` binding instead:
 *
 *   1. If auth.workspaceId is already `rw_`-format (legacy/bootstrap case)
 *      and has a DB row with a minted API key, use it directly.
 *   2. Look up the app workspace row. If it has `relay_workspace_id` set
 *      AND that relay workspace has a minted key, use that.
 *   3. Otherwise provision a fresh relay workspace via the registry (mints
 *      a relaycast API key, inserts the DB row) and bind it to the app
 *      workspace by updating `workspaces.relay_workspace_id`.
 *
 * If provisioning fails, throw — the caller should 500 rather than spawn a
 * doomed sandbox.
 *
 * Race safety: two concurrent runs for the same app workspace could both
 * observe an empty binding and both provision. The loser's `UPDATE ... SET
 * relay_workspace_id` is a lost write but not a corruption — the winner's
 * binding survives and subsequent runs are stable. Accept the small orphan
 * cost for now.
 */
import { eq } from "drizzle-orm";
import { createCloudWorkspaceRegistry } from "@/lib/workspace-registry";
import {
  getRelayWorkspace,
  isValidWorkspaceId,
} from "@/lib/relay-workspaces";
import { getDb } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";

export type ResolvedRelayWorkspace = {
  id: string;
  relaycastApiKey: string;
  provisioned: boolean;
};

export async function resolveOrProvisionRelayWorkspace(input: {
  userId: string;
  appWorkspaceId: string;
  name?: string;
}): Promise<ResolvedRelayWorkspace> {
  const { userId, appWorkspaceId } = input;

  if (isValidWorkspaceId(appWorkspaceId)) {
    const record = await getRelayWorkspace(appWorkspaceId);
    if (record && record.relaycastApiKey.trim().length > 0) {
      return {
        id: record.id,
        relaycastApiKey: record.relaycastApiKey,
        provisioned: false,
      };
    }
  }

  const boundRelayWorkspaceId = await loadBoundRelayWorkspaceId(appWorkspaceId);
  if (boundRelayWorkspaceId) {
    const record = await getRelayWorkspace(boundRelayWorkspaceId);
    if (record && record.relaycastApiKey.trim().length > 0) {
      return {
        id: record.id,
        relaycastApiKey: record.relaycastApiKey,
        provisioned: false,
      };
    }
  }

  const { registry } = createCloudWorkspaceRegistry();
  const entry = await registry.create({
    createdBy: userId,
    name: input.name?.trim() || "default",
  });

  const apiKey = entry.relaycastApiKey?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      `Workspace registry provisioned ${entry.id} but returned no relaycastApiKey — ` +
        `the relaycast backend did not mint a key. Check RELAYCAST_URL and service credentials.`,
    );
  }

  await bindRelayWorkspaceToAppWorkspace(appWorkspaceId, entry.id);

  return {
    id: entry.id,
    relaycastApiKey: apiKey,
    provisioned: true,
  };
}

async function loadBoundRelayWorkspaceId(appWorkspaceId: string): Promise<string | null> {
  // Only app workspace IDs in the `workspaces` table have a binding column.
  // If appWorkspaceId isn't a valid UUID (e.g. service auth with workspaceId=""),
  // skip the lookup rather than pushing a malformed query at Postgres.
  if (!appWorkspaceId || !isUuid(appWorkspaceId)) return null;

  const db = getDb();
  const [row] = await db
    .select({ relayWorkspaceId: workspaces.relayWorkspaceId })
    .from(workspaces)
    .where(eq(workspaces.id, appWorkspaceId))
    .limit(1);

  const value = row?.relayWorkspaceId?.trim() ?? "";
  return value.length > 0 ? value : null;
}

async function bindRelayWorkspaceToAppWorkspace(
  appWorkspaceId: string,
  relayWorkspaceId: string,
): Promise<void> {
  if (!appWorkspaceId || !isUuid(appWorkspaceId)) return;

  const db = getDb();
  await db
    .update(workspaces)
    .set({ relayWorkspaceId, updatedAt: new Date() })
    .where(eq(workspaces.id, appWorkspaceId));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
