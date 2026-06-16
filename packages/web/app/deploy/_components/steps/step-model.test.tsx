import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PersonaSummary } from "../../_lib/types";
import { StepModel } from "./step-model";

function persona(overrides: Partial<PersonaSummary> = {}): PersonaSummary {
  return {
    id: "repo-hygiene",
    name: "Repo Hygiene",
    description: "Keep repositories tidy.",
    slug: "repo-hygiene",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: true,
    integrations: [],
    inputs: [],
    triggers: [],
    ...overrides,
  };
}

function renderStep(summary: PersonaSummary, harnessSource: "plan" | "byok" | "oauth" | null = "byok") {
  return renderToStaticMarkup(
    <StepModel
      persona={summary}
      harnessSource={harnessSource}
      byokKey=""
      onSourceChange={vi.fn()}
      onByokKeyChange={vi.fn()}
    />,
  );
}

describe("StepModel", () => {
  it("enables ChatGPT subscription credentials for OpenAI subscription personas", () => {
    const html = renderStep(persona(), "oauth");

    expect(html).toContain("ChatGPT subscription");
    expect(html).toContain("active ChatGPT/Codex subscription credential");
    expect(html).not.toContain("aria-disabled=\"true\"");
    expect(html).not.toContain("disabled=\"\"");
    expect(html).toContain("BYOK");
    expect(html).toContain("Selected");
    expect(html).not.toContain("for=\"byok-key\"");
    expect(html).not.toContain(">Plan<");
  });

  it("uses Claude setup-token pending copy for Anthropic subscription personas", () => {
    const html = renderStep(
      persona({
        harness: "claude",
        model: "claude-sonnet-4-6",
        modelProvider: "anthropic",
      }),
    );

    expect(html).toContain("Claude subscription");
    expect(html).toContain("pending setup-token support");
    expect(html).toContain("Anthropic API key");
    expect(html).not.toContain(">Plan<");
  });

  it("keeps Plan available for non-subscription personas", () => {
    const html = renderStep(
      persona({
        useSubscription: false,
      }),
      "plan",
    );

    expect(html).toContain(">Plan<");
    expect(html).toContain("Workforce-billed model usage");
    expect(html).not.toContain("ChatGPT subscription");
  });

  it("does not render disabled Anthropic subscription credentials as selected from stale oauth state", () => {
    const html = renderStep(persona(), "oauth");

    const anthropic = persona({
      harness: "claude",
      model: "claude-sonnet-4-6",
      modelProvider: "anthropic",
    });
    const anthropicHtml = renderStep(anthropic, "oauth");

    expect(anthropicHtml).toContain("Claude subscription");
    expect(anthropicHtml).toContain("BYOK");
    expect(anthropicHtml).toContain("Selected");
    expect(anthropicHtml).toContain("Anthropic API key");
    expect(anthropicHtml).toMatch(/aria-checked="false"[^>]*aria-disabled="true"[\s\S]*Claude subscription/);
    expect(anthropicHtml).toMatch(/aria-checked="true"[\s\S]*BYOK/);

    expect(html).toContain("ChatGPT subscription");
    expect(html).toContain("BYOK");
    expect(html).toContain("Selected");
    expect(html).toMatch(/aria-checked="true"[\s\S]*ChatGPT subscription/);
  });

  it("shows the connect command when subscription credentials are missing", () => {
    const html = renderToStaticMarkup(
      <StepModel
        persona={persona()}
        harnessSource="oauth"
        byokKey=""
        subscriptionCredentialMessage="No active subscription credentials are connected. Run `npx agent-relay cloud connect openai`, mark the credential Active, then deploy again."
        onSourceChange={vi.fn()}
        onByokKeyChange={vi.fn()}
      />,
    );

    expect(html).toContain("No active subscription credentials are connected");
    expect(html).toContain("npx agent-relay cloud connect openai");
  });
});
