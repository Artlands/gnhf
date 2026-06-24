import { describe, expect, it } from "vitest";
import { normalizeTieredModelsConfig } from "./tiered-models-config.js";

describe("normalizeTieredModelsConfig", () => {
  it("returns undefined when the block is absent", () => {
    expect(normalizeTieredModelsConfig(undefined, "claude")).toBeUndefined();
    expect(normalizeTieredModelsConfig(null, "claude")).toBeUndefined();
  });

  it("returns undefined when enabled is false (regardless of other fields)", () => {
    expect(
      normalizeTieredModelsConfig(
        {
          enabled: false,
          defaultTier: "nonexistent",
          tiers: {},
        },
        "claude",
      ),
    ).toBeUndefined();
  });

  it("accepts a minimal enabled config and defaults classifier mode to agent-self", () => {
    const result = normalizeTieredModelsConfig(
      {
        enabled: true,
        defaultTier: "complex",
        tiers: {
          complex: { args: { claude: ["--model", "opus"] } },
        },
      },
      "claude",
    );

    expect(result).toEqual({
      enabled: true,
      defaultTier: "complex",
      classifier: { mode: "agent-self" },
      tiers: {
        complex: { args: { claude: ["--model", "opus"] } },
      },
    });
  });

  it("preserves the local flag on tiers that set it", () => {
    const result = normalizeTieredModelsConfig(
      {
        enabled: true,
        defaultTier: "complex",
        tiers: {
          complex: { args: { claude: ["--model", "opus"] } },
          cheap: {
            agent: "acp:local-qwen",
            local: true,
            acpRegistryOverrides: { "local-qwen": "/usr/local/bin/qwen-acp" },
          },
        },
      },
      "claude",
    );

    expect(result?.tiers.cheap?.local).toBe(true);
    expect(result?.tiers.cheap?.agent).toBe("acp:local-qwen");
    expect(result?.tiers.cheap?.acpRegistryOverrides).toEqual({
      "local-qwen": "/usr/local/bin/qwen-acp",
    });
  });

  it("rejects an empty tiers map", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        { enabled: true, defaultTier: "x", tiers: {} },
        "claude",
      ),
    ).toThrow(/expected at least one tier/);
  });

  it("rejects a defaultTier that is not a configured tier", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "missing",
          tiers: { complex: {} },
        },
        "claude",
      ),
    ).toThrow(/defaultTier.*not a configured tier/);
  });

  it("rejects tier names that contain invalid characters", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "bad name",
          tiers: { "bad name": {} },
        },
        "claude",
      ),
    ).toThrow(/Invalid tier name/);
  });

  it("requires routerTier when classifier mode is router", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          classifier: { mode: "router" },
          tiers: { complex: {} },
        },
        "claude",
      ),
    ).toThrow(/routerTier.*required/);
  });

  it("requires routerTier to be a configured tier", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          classifier: { mode: "router+self", routerTier: "missing" },
          tiers: { complex: {} },
        },
        "claude",
      ),
    ).toThrow(/routerTier.*not a configured tier/);
  });

  it("rejects an unknown classifier mode", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          classifier: { mode: "lol" },
          tiers: { complex: {} },
        },
        "claude",
      ),
    ).toThrow(/classifier\.mode.*expected one of/);
  });

  it("rejects tier args that contain a non-model-class gnhf-managed flag", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          tiers: {
            complex: {
              args: { claude: ["-p", "leak"] },
            },
          },
        },
        "claude",
      ),
    ).toThrow(/managed by gnhf/);
  });

  it("allows model-class flags inside tier args (that is the point)", () => {
    const result = normalizeTieredModelsConfig(
      {
        enabled: true,
        defaultTier: "simple",
        tiers: {
          simple: { args: { claude: ["--model", "sonnet"] } },
        },
      },
      "claude",
    );

    expect(result?.tiers.simple?.args?.claude).toEqual(["--model", "sonnet"]);
  });

  it("requires every tier to swap the agent when top-level agent is a managed-server agent", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          tiers: {
            complex: { args: { rovodev: ["--profile", "x"] } },
          },
        },
        "rovodev",
      ),
    ).toThrow(/requires every tier to set tier\.agent/);
  });

  it("accepts top-level acp: when every tier supplies tier.agent", () => {
    const result = normalizeTieredModelsConfig(
      {
        enabled: true,
        defaultTier: "complex",
        tiers: {
          complex: { agent: "claude", args: { claude: ["--model", "opus"] } },
        },
      },
      "acp:gemini",
    );

    expect(result?.tiers.complex?.agent).toBe("claude");
  });

  it("rejects unknown top-level fields", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          tiers: { complex: {} },
          mystery: true,
        },
        "claude",
      ),
    ).toThrow(/Unsupported config key for tieredModels\.mystery/);
  });

  it("rejects unknown TierDef fields", () => {
    expect(() =>
      normalizeTieredModelsConfig(
        {
          enabled: true,
          defaultTier: "complex",
          tiers: { complex: { mystery: 1 } },
        },
        "claude",
      ),
    ).toThrow(
      /Unsupported config key for tieredModels\.tiers\.complex\.mystery/,
    );
  });
});
