<img src="./banner.png" alt="Cloud Team Reviewer">

Cloud Team Reviewer
===================

The review member of a teamSolve roster. When a team lead's trigger fires, the
cloud team dispatcher launches each roster member into its own sandbox — this
persona steers the review member: claude harness, high reasoning, and a review
discipline built around verifiable, actionable findings.

How it runs
-----------

This persona is **launched by a team lead, never by events**. It declares no
triggers and no schedules; deploying it simply makes the slug available for a
`team.json` roster to reference (roster binding fails closed if a member slug
is not deployed). The handler only logs a warning if cloud ever routes an
event to it directly.

What the member does on launch
------------------------------

1. Reviews the teammate's diff against the issue spec — not the description
   of the diff.
2. Verifies the tests actually pin the changed behavior (a test that passes
   with the fix reverted is a finding).
3. Classifies every finding blocking / non-blocking with file, line, and the
   observable failure.
4. Proposes the smallest concrete fix for each blocking finding.
5. Lists the edge cases checked AND the ones it could not exercise, so
   silence is never mistaken for coverage.

Deploy
------

```bash
agentworkforce deploy ./cloud-team-reviewer/persona.ts
```

Then reference it from a roster:

```json
{
  "name": "reviewer",
  "persona": { "slug": "cloud-team-reviewer" },
  "role": "reviewer"
}
```

Pairs with [`cloud-team-implementer`](../cloud-team-implementer/), the
implementation member of the same roster.
