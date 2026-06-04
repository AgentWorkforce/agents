# Teams

Team specs for multi-agent issue solving. Each `teams/<id>/team.json` defines a
team roster the cloud team-binding API materializes into `teams` /
`team_members` rows.

## Contract

The schema is owned by cloud (`packages/core/src/proactive-runtime/team-spec.ts`,
`loadTeamSpec`) and enforced at bind time by `bindTeam`
(`packages/web/lib/proactive-runtime/team-deploy.ts`):

- `id` — team slug; must match the directory name. Binding upserts on
  `(workspace, slug)`, so re-binding the same id updates the roster in place.
- `lead` — a member `name`, or (when not a member) the `deployedName` of an
  already-deployed agent in the workspace. Binding fails closed
  (`409 team_lead_not_deployed`) if neither resolves.
- `members[]` — `{ name, persona, role?, owns? }`. Member names are unique.
  Persona refs are deployed-persona slugs (string or `{ "slug": … }`); Phase-1
  binding rejects `inline` personas, and `path` refs resolve to their basename
  slug. Every referenced persona must already be deployed in the workspace.
- `owns[]` selectors must not be claimed by two different members.
- `tokenBudget` / `timeBudgetSeconds` — positive 32-bit integers.

`npm test` validates every spec here against these rules
(`tests/team-spec.test.mjs`), so contract drift fails in CI instead of as a
4xx at bind time.

## Binding

POST the spec to the workspace teams route:

```bash
curl -sS -X POST "$CLOUD_API_BASE/api/v1/workspaces/$WORKSPACE_ID/teams" \
  -H "Authorization: Bearer $CLOUD_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @teams/cloud-team-issue/team.json
```

## cloud-team-issue

Multi-member roster for the deployed `cloud-team-issue` teamSolve agent
(lead-outside-member-list shape: the lead is the deployed agent, the members
are the launchable workers). Both members reference the `cloud-team-issue`
persona slug — the only deployed teamSolve persona — and are distinguished by
`name`/`role`.

Binding this roster is one of **three** levers for team N>1 go-live; the other
two live in cloud and the roster stays dormant until they flip:

1. This roster bound (creates the `team_members` rows the delivery drain reads).
2. The `cloud-team-issue` persona's `capabilities.teamSolve.maxMembers` raised
   from 1 (the drain re-derives the cap from the persona spec and truncates the
   roster to it, logging dropped members).
3. `CLOUD_TEAM_LAUNCH_MULTI_ENABLED` flipped (cloud PR #1893's dispatcher
   flag, default off).
