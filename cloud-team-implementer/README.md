<img src="./banner.png" alt="Cloud Team Implementer">

Cloud Team Implementer
======================

The implementation member of a teamSolve roster. When a team lead's trigger
fires (for example an issue labeled `team`), the cloud team dispatcher launches
each roster member into its own sandbox — this persona is what steers the
implementation member: codex harness, high reasoning, and a working agreement
tuned for turning an issue spec into one focused branch and pull request.

How it runs
-----------

This persona is **launched by a team lead, never by events**. It declares no
triggers and no schedules; deploying it simply makes the slug available for a
`team.json` roster to reference (roster binding fails closed if a member slug
is not deployed). The handler only logs a warning if cloud ever routes an
event to it directly.

What the member does on launch
------------------------------

1. Reads the assigned issue spec and the surrounding code.
2. Implements the smallest complete change that satisfies the spec — adjacent
   problems are noted in the PR body, not fixed.
3. Writes or updates tests that pin the changed behavior.
4. Runs the repository's checks and reports their real results.
5. Opens exactly one branch and one pull request, with assumptions and
   verification steps recorded in the body.

Deploy
------

```bash
agentworkforce deploy ./cloud-team-implementer/persona.ts
```

Then reference it from a roster:

```json
{
  "name": "implementer",
  "persona": { "slug": "cloud-team-implementer" },
  "role": "implementer"
}
```

Pairs with [`cloud-team-reviewer`](../cloud-team-reviewer/), the review member
of the same roster.
