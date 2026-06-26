import { describe, it, expect, vi } from "vitest";
import {
  buildClassifierPrompt,
  runUpfrontClassifier,
  buildRouterClassifierPrompt,
  runRouterClassifier,
} from "./classifier.js";
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

describe("buildRouterClassifierPrompt", () => {
  it("lists each tier and asks for a plan with tiers, plan, and rationale", () => {
    const prompt = buildRouterClassifierPrompt({
      objective: "build feature X",
      defaultTier: "complex",
      tiers: [
        { name: "complex", description: "planning across files" },
        { name: "simple", description: "mechanical edits" },
      ],
    });

    expect(prompt).toContain("`complex`: planning across files");
    expect(prompt).toContain("`simple`: mechanical edits");
    expect(prompt).toContain('"tiers"');
    expect(prompt).toContain('"plan"');
    expect(prompt).toContain('"rationale"');
    expect(prompt).toContain('When in doubt, choose "complex"');
    expect(prompt).toContain("build feature X");
  });
});

describe("runRouterClassifier", () => {
  function resultWithUsage(): AgentResult {
    return {
      output: {
        success: true,
        summary: "",
        key_changes_made: [],
        key_learnings: [],
      },
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    };
  }

  it("extracts a valid plan from the assistant text", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, opts) => {
        const onMsg = opts?.onMessage;
        if (onMsg) {
          onMsg('{"tiers":["complex","simple"],');
          onMsg('"plan":["design architecture","implement"],');
          onMsg('"rationale":"start strong, then streamline"}');
        }
        return resultWithUsage();
      }),
    };

    const result = await runRouterClassifier({
      agent,
      objective: "build web app",
      cwd: "/repo",
      defaultTier: "complex",
      tiers: [{ name: "complex" }, { name: "simple" }],
    });

    expect(result.tiers).toEqual(["complex", "simple"]);
    expect(result.plan).toEqual(["design architecture", "implement"]);
    expect(result.rationale).toBe("start strong, then streamline");
    expect(result.usage.inputTokens).toBe(50);
  });

  it("throws when the assistant text contains no valid JSON", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, opts) => {
        const onMsg = opts?.onMessage;
        if (onMsg) onMsg("Here is my analysis... no JSON here");
        return resultWithUsage();
      }),
    };

    await expect(
      runRouterClassifier({
        agent,
        objective: "build",
        cwd: "/repo",
        defaultTier: "complex",
        tiers: [{ name: "complex" }, { name: "simple" }],
      }),
    ).rejects.toThrow(/no valid JSON/);
  });

  it("throws when tiers and plan have mismatched lengths", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, opts) => {
        const onMsg = opts?.onMessage;
        if (onMsg) {
          onMsg(
            '{"tiers":["complex","simple"],"plan":["only one"],"rationale":"bad"}',
          );
        }
        return resultWithUsage();
      }),
    };

    await expect(
      runRouterClassifier({
        agent,
        objective: "build",
        cwd: "/repo",
        defaultTier: "complex",
        tiers: [{ name: "complex" }, { name: "simple" }],
      }),
    ).rejects.toThrow(/length mismatch/);
  });

  it("throws when tiers array is empty", async () => {
    const agent: Agent = {
      name: "claude",
      run: vi.fn(async (_prompt, _cwd, opts) => {
        const onMsg = opts?.onMessage;
        if (onMsg) {
          onMsg('{"tiers":[],"plan":[],"rationale":"empty"}');
        }
        return resultWithUsage();
      }),
    };

    await expect(
      runRouterClassifier({
        agent,
        objective: "build",
        cwd: "/repo",
        defaultTier: "complex",
        tiers: [{ name: "complex" }, { name: "simple" }],
      }),
    ).rejects.toThrow(/invalid tiers/);
  });
});
