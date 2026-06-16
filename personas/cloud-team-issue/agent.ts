import { defineAgent } from "@agentworkforce/runtime";

const agentHandler = async (ctx, event) => {
  ctx.log("info", "cloud-team-issue persona is dormant; web teamSolve N=1 adapter owns member launch", {
    eventId: event.id,
    source: event.source,
    type: event.type,
  });
};

export default defineAgent({
  triggers: {
    github: [
      {
        on: "issues.labeled",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        // Dispatch-level gate: only the `team` label wakes this (dormant)
        // persona — the web teamSolve adapter owns the live member spawn.
        where: "label.name=team",
      },
    ],
  },
  handler: agentHandler,
});
