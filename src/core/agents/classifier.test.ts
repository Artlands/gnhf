import { describe, it, expect, vi } from "vitest";
import { buildClassifierPrompt, runUpfrontClassifier } from "./classifier.js";
import type { Agent, AgentResult } from "./types.js";

describe("buildClassifierPrompt", () => {
  it("lists each tier with its description and points the agent at the default tier", () => {
    const prompt = buildClassifierPrompt({
      objective: "ship a thing",
      defaultTier: "complex",
      fieldName: "next_iteration_tier",
      tiers: [{ name: "complex", description: "planning" }, { name: "simple" }],
    });

    expect(prompt).toContain("`complex`: planning");
    expect(prompt).toContain("`simple`");
    expect(prompt).toContain('When in doubt, choose "complex"');
    expect(prompt).toContain("next_iteration_tier");
    expect(prompt).toContain("ship a thing");
  });
});

function makeResult(nextTier: string): AgentResult {
  return {
    output: {
      success: true,
      summary: "tier-selection",
      key_changes_made: [],
      key_learnings: [],
      next_iteration_tier: nextTier,
    },
    usage: {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  };
}

describe("runUpfrontClassifier", () => {
  it("returns the tier value reported by the agent", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async () => makeResult("simple")),
    };

    const result = await runUpfrontClassifier({
      agent,
      objective: "ship",
      cwd: "/repo",
      defaultTier: "complex",
      fieldName: "next_iteration_tier",
      tiers: [{ name: "complex" }, { name: "simple" }],
    });

    expect(result.tier).toBe("simple");
    expect(result.usage.inputTokens).toBe(12);
  });

  it("throws when the agent omits the tier field", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(
        async () =>
          ({
            output: {
              success: true,
              summary: "x",
              key_changes_made: [],
              key_learnings: [],
            },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
            },
          }) as AgentResult,
      ),
    };

    await expect(
      runUpfrontClassifier({
        agent,
        objective: "ship",
        cwd: "/repo",
        defaultTier: "complex",
        fieldName: "next_iteration_tier",
        tiers: [{ name: "complex" }, { name: "simple" }],
      }),
    ).rejects.toThrow(/missing or invalid next_iteration_tier/);
  });
});
