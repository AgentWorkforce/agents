import { describe, expect, it } from "vitest";
import { translatePersonaRelayToInboxSelectors } from "./inbox-selectors";

describe("translatePersonaRelayToInboxSelectors", () => {
  it("normalizes inbox selectors from persona relay fields and agent.inbox", () => {
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {
          relay: {
            enabled: true,
            inbox: ["#support", "@self"],
            channels: ["#ops", "triage"],
          },
        },
        agent: {
          inbox: [{ channels: ["#support", "#reviews"] }],
        },
      }),
    ).toEqual(["@self", "ops", "reviews", "support", "triage"]);
  });

  it("uses raw persona relay fields when the parsed persona omits relay metadata", () => {
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {},
        rawPersona: {
          relay: {
            inbox: ["#launch"],
          },
        },
      }),
    ).toEqual(["launch"]);
  });

  it("ignores disabled relay config and unsupported @user selectors", () => {
    expect(
      translatePersonaRelayToInboxSelectors({
        persona: {
          relay: {
            enabled: false,
            inbox: ["#support"],
          },
        },
        agent: {
          inbox: ["@someone"],
        },
      }),
    ).toEqual([]);
  });
});
