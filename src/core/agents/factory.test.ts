import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";

vi.mock("./claude.js", () => {
  const ClaudeAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "claude";
    this.deps = deps;
  });
  return { ClaudeAgent };
});

vi.mock("./codex.js", () => {
  const CodexAgent = vi.fn(function (
    this: Record<string, unknown>,
    schemaPath: string,
  ) {
    this.name = "codex";
    this.schemaPath = schemaPath;
  });
  return { CodexAgent };
});

vi.mock("./copilot.js", () => {
  const CopilotAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "copilot";
    this.deps = deps;
  });
  return { CopilotAgent };
});

vi.mock("./pi.js", () => {
  const PiAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "pi";
    this.deps = deps;
  });
  return { PiAgent };
});

vi.mock("./rovodev.js", () => {
  const RovoDevAgent = vi.fn(function (
    this: Record<string, unknown>,
    schemaPath: string,
    deps?: Record<string, unknown>,
  ) {
    this.name = "rovodev";
    this.schemaPath = schemaPath;
    this.deps = deps;
  });
  return { RovoDevAgent };
});

vi.mock("./opencode.js", () => {
  const OpenCodeAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    this.name = "opencode";
    this.deps = deps;
  });
  return { OpenCodeAgent };
});

vi.mock("./acp.js", () => {
  const AcpAgent = vi.fn(function (
    this: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) {
    const target = (deps as { target?: string } | undefined)?.target ?? "";
    this.name = `acp:${target}`;
    this.deps = deps;
  });
  return { AcpAgent };
});

import {
  createAgent,
  createAgentProvider,
  resolveTier,
  DEFAULT_TIER_NAME,
} from "./factory.js";
import { AcpAgent } from "./acp.js";
import { ClaudeAgent } from "./claude.js";
import { CopilotAgent } from "./copilot.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { PiAgent } from "./pi.js";
import { RovoDevAgent } from "./rovodev.js";
import type { RunInfo } from "../run.js";
import type { Config } from "../config.js";
import type { TieredModelsConfig } from "../tiered-models.js";

const stubRunInfo: RunInfo = {
  runId: "test-run",
  runDir: "/repo/.gnhf/runs/test-run",
  promptPath: "/repo/.gnhf/runs/test-run/PROMPT.md",
  notesPath: "/repo/.gnhf/runs/test-run/notes.md",
  schemaPath: "/repo/.gnhf/runs/test-run/schema.json",
  logPath: "/repo/.gnhf/runs/test-run/gnhf.log",
  baseCommit: "abc123",
  baseCommitPath: "/repo/.gnhf/runs/test-run/base-commit",
  stopWhenPath: "/repo/.gnhf/runs/test-run/stop-when",
  stopWhen: undefined,
  commitMessagePath: "/repo/.gnhf/runs/test-run/commit-message",
  commitMessage: undefined,
  tierConfigPath: "/repo/.gnhf/runs/test-run/tier-config.json",
  tieredModels: undefined,
};

const acpSessionStateDir = join(stubRunInfo.runDir, "acp-sessions");

function stubRunInfoWithTieredModels(
  tieredModels: TieredModelsConfig,
): RunInfo {
  return { ...stubRunInfo, tieredModels };
}

const noStopSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    success: { type: "boolean" },
    summary: { type: "string" },
    key_changes_made: { type: "array", items: { type: "string" } },
    key_learnings: { type: "array", items: { type: "string" } },
  },
  required: ["success", "summary", "key_changes_made", "key_learnings"],
};

const withStopSchema = {
  ...noStopSchema,
  properties: {
    ...noStopSchema.properties,
    should_fully_stop: { type: "boolean" },
  },
  required: [...noStopSchema.required, "should_fully_stop"],
};

describe("createAgent", () => {
  it("creates a ClaudeAgent when name is 'claude'", () => {
    const agent = createAgent("claude", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("passes per-agent extra args through to the ClaudeAgent", () => {
    const agent = createAgent(
      "claude",
      stubRunInfo,
      undefined,
      ["--model", "sonnet"],
      { includeStopField: false },
    );

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "sonnet"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("claude");
  });

  it("hands ClaudeAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("claude", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("hands ClaudeAgent a schema with configured commit message fields", () => {
    createAgent("claude", stubRunInfo, undefined, undefined, {
      includeStopField: false,
      commitFields: [
        { name: "type", allowed: ["feat", "fix"] },
        { name: "scope" },
      ],
    });

    expect(ClaudeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: {
        ...noStopSchema,
        properties: {
          ...noStopSchema.properties,
          type: { type: "string", enum: ["feat", "fix"] },
          scope: { type: "string" },
        },
        required: [...noStopSchema.required, "type", "scope"],
      },
    });
  });

  it("creates a CodexAgent when name is 'codex'", () => {
    const agent = createAgent("codex", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("codex");
  });

  it("creates a CopilotAgent when name is 'copilot'", () => {
    const agent = createAgent("copilot", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(CopilotAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("copilot");
  });

  it("passes per-agent extra args through to the CopilotAgent", () => {
    const agent = createAgent(
      "copilot",
      stubRunInfo,
      undefined,
      ["--model", "gpt-5.4"],
      { includeStopField: false },
    );

    expect(CopilotAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "gpt-5.4"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("copilot");
  });

  it("hands CopilotAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("copilot", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(CopilotAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("passes per-agent extra args through to the CodexAgent", () => {
    const agent = createAgent(
      "codex",
      stubRunInfo,
      undefined,
      ["-m", "gpt-5.4", "--full-auto"],
      { includeStopField: false },
    );

    expect(CodexAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: ["-m", "gpt-5.4", "--full-auto"],
    });
    expect(agent.name).toBe("codex");
  });

  it("creates a PiAgent when name is 'pi'", () => {
    const agent = createAgent("pi", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(PiAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("pi");
  });

  it("passes path override and extra args through to the PiAgent", () => {
    const agent = createAgent(
      "pi",
      stubRunInfo,
      "/custom/pi",
      ["--provider", "openai-codex", "--model", "gpt-5.5"],
      { includeStopField: false },
    );

    expect(PiAgent).toHaveBeenCalledWith({
      bin: "/custom/pi",
      extraArgs: ["--provider", "openai-codex", "--model", "gpt-5.5"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("pi");
  });

  it("hands PiAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("pi", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(PiAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("creates a RovoDevAgent when name is 'rovodev'", () => {
    const agent = createAgent("rovodev", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: undefined,
    });
    expect(agent.name).toBe("rovodev");
  });

  it("passes per-agent extra args through to the RovoDevAgent", () => {
    const agent = createAgent(
      "rovodev",
      stubRunInfo,
      undefined,
      ["--profile", "work"],
      { includeStopField: false },
    );

    expect(RovoDevAgent).toHaveBeenCalledWith(stubRunInfo.schemaPath, {
      bin: undefined,
      extraArgs: ["--profile", "work"],
    });
    expect(agent.name).toBe("rovodev");
  });

  it("creates an OpenCodeAgent when name is 'opencode'", () => {
    const agent = createAgent("opencode", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });
    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: noStopSchema,
    });
    expect(agent.name).toBe("opencode");
  });

  it("passes per-agent extra args through to the OpenCodeAgent", () => {
    const agent = createAgent(
      "opencode",
      stubRunInfo,
      undefined,
      ["--model", "gpt-5"],
      { includeStopField: false },
    );

    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: ["--model", "gpt-5"],
      schema: noStopSchema,
    });
    expect(agent.name).toBe("opencode");
  });

  it("hands OpenCodeAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("opencode", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(OpenCodeAgent).toHaveBeenCalledWith({
      bin: undefined,
      extraArgs: undefined,
      schema: withStopSchema,
    });
  });

  it("creates an AcpAgent when the spec uses an acp: prefix", () => {
    const agent = createAgent("acp:gemini", stubRunInfo, undefined, undefined, {
      includeStopField: false,
    });

    expect(AcpAgent).toHaveBeenCalledWith({
      target: "gemini",
      schema: noStopSchema,
      runId: stubRunInfo.runId,
      sessionStateDir: acpSessionStateDir,
    });
    expect(agent.name).toBe("acp:gemini");
  });

  it("forwards raw ACP command specs as custom acpx targets", () => {
    const command = "./bin/dev-acp --profile ci";
    const agent = createAgent(
      `acp:${command}`,
      stubRunInfo,
      undefined,
      undefined,
      {
        includeStopField: false,
      },
    );

    expect(AcpAgent).toHaveBeenCalledWith({
      target: command,
      schema: noStopSchema,
      runId: stubRunInfo.runId,
      sessionStateDir: acpSessionStateDir,
    });
    expect(agent.name).toBe(`acp:${command}`);
  });

  it("hands AcpAgent a schema that requires should_fully_stop when includeStopField is true", () => {
    createAgent("acp:cursor", stubRunInfo, undefined, undefined, {
      includeStopField: true,
    });
    expect(AcpAgent).toHaveBeenCalledWith({
      target: "cursor",
      schema: withStopSchema,
      runId: stubRunInfo.runId,
      sessionStateDir: acpSessionStateDir,
    });
  });

  it("ignores per-agent path/args overrides for acp specs (v1)", () => {
    createAgent("acp:gemini", stubRunInfo, "/custom", ["--model", "x"], {
      includeStopField: false,
    });
    // The factory should not forward pathOverride or extraArgs to AcpAgent;
    // override semantics for ACP targets aren't defined in v1.
    expect(AcpAgent).toHaveBeenCalledWith({
      target: "gemini",
      schema: noStopSchema,
      runId: stubRunInfo.runId,
      sessionStateDir: acpSessionStateDir,
    });
  });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    agent: "claude",
    agentPathOverride: {},
    agentArgsOverride: {},
    acpRegistryOverrides: {},
    maxConsecutiveFailures: 3,
    preventSleep: true,
    ...overrides,
  };
}

describe("resolveTier", () => {
  it("falls back to today's wiring when tieredModels is undefined", () => {
    const config = makeConfig({
      agent: "claude",
      agentPathOverride: { claude: "/usr/local/bin/claude" },
      agentArgsOverride: { claude: ["--foo"] },
      acpRegistryOverrides: { staging: "node x.mjs" },
    });
    const resolved = resolveTier(config, DEFAULT_TIER_NAME);
    expect(resolved).toEqual({
      tierName: DEFAULT_TIER_NAME,
      agent: "claude",
      agentPath: "/usr/local/bin/claude",
      agentArgs: ["--foo"],
      acpRegistryOverrides: { staging: "node x.mjs" },
      local: false,
    });
  });

  it("uses tier.agent when set, overriding top-level config.agent", () => {
    const config = makeConfig({
      agent: "claude",
      tieredModels: {
        enabled: true,
        defaultTier: "cheap",
        classifier: { mode: "agent-self" },
        tiers: {
          cheap: { agent: "acp:local-qwen" },
        },
      },
    });
    const resolved = resolveTier(config, "cheap");
    expect(resolved.agent).toBe("acp:local-qwen");
    expect(resolved.local).toBe(false);
  });

  it("propagates local: true onto the resolved tier", () => {
    const config = makeConfig({
      tieredModels: {
        enabled: true,
        defaultTier: "cheap",
        classifier: { mode: "agent-self" },
        tiers: {
          cheap: { agent: "acp:local-qwen", local: true },
        },
      },
    });
    const resolved = resolveTier(config, "cheap");
    expect(resolved.local).toBe(true);
  });

  it("merges top-level acpRegistryOverrides with tier-scoped, tier wins on conflict", () => {
    const config = makeConfig({
      acpRegistryOverrides: { staging: "global cmd" },
      tieredModels: {
        enabled: true,
        defaultTier: "cheap",
        classifier: { mode: "agent-self" },
        tiers: {
          cheap: {
            agent: "acp:staging",
            acpRegistryOverrides: { staging: "tier cmd" },
          },
        },
      },
    });
    const resolved = resolveTier(config, "cheap");
    expect(resolved.acpRegistryOverrides).toEqual({ staging: "tier cmd" });
  });

  it("splices top-level args before tier args", () => {
    const config = makeConfig({
      agent: "claude",
      agentArgsOverride: { claude: ["--foo", "--bar"] },
      tieredModels: {
        enabled: true,
        defaultTier: "complex",
        classifier: { mode: "agent-self" },
        tiers: {
          complex: { args: { claude: ["--baz"] } },
        },
      },
    });
    const resolved = resolveTier(config, "complex");
    expect(resolved.agentArgs).toEqual(["--foo", "--bar", "--baz"]);
  });

  it("drops a top-level --model when the tier also sets --model (paired form)", () => {
    const config = makeConfig({
      agent: "claude",
      agentArgsOverride: { claude: ["--model", "sonnet", "--foo"] },
      tieredModels: {
        enabled: true,
        defaultTier: "complex",
        classifier: { mode: "agent-self" },
        tiers: {
          complex: { args: { claude: ["--model", "opus"] } },
        },
      },
    });
    const resolved = resolveTier(config, "complex");
    expect(resolved.agentArgs).toEqual(["--foo", "--model", "opus"]);
  });

  it("drops a top-level --model=foo when the tier sets --model (equals form)", () => {
    const config = makeConfig({
      agent: "claude",
      agentArgsOverride: { claude: ["--model=sonnet", "--foo"] },
      tieredModels: {
        enabled: true,
        defaultTier: "complex",
        classifier: { mode: "agent-self" },
        tiers: {
          complex: { args: { claude: ["--model", "opus"] } },
        },
      },
    });
    const resolved = resolveTier(config, "complex");
    expect(resolved.agentArgs).toEqual(["--foo", "--model", "opus"]);
  });

  it("returns the named tier's content (not the legacy fallback) when tieredModels is active", () => {
    const config = makeConfig({
      agent: "claude",
      agentArgsOverride: { claude: ["--top"] },
      acpRegistryOverrides: { staging: "global cmd" },
      tieredModels: {
        enabled: true,
        defaultTier: "complex",
        classifier: { mode: "agent-self" },
        tiers: {
          complex: {
            agent: "codex",
            args: { codex: ["--tier-only"] },
            acpRegistryOverrides: { staging: "tier cmd" },
            local: true,
          },
        },
      },
    });
    const resolved = resolveTier(config, "complex");
    expect(resolved.tierName).toBe("complex");
    expect(resolved.agent).toBe("codex");
    expect(resolved.agentArgs).toEqual(["--tier-only"]);
    expect(resolved.acpRegistryOverrides).toEqual({ staging: "tier cmd" });
    expect(resolved.local).toBe(true);
  });

  it("does not drop top-level --model when the tier does not set one", () => {
    const config = makeConfig({
      agent: "claude",
      agentArgsOverride: { claude: ["--model", "sonnet"] },
      tieredModels: {
        enabled: true,
        defaultTier: "simple",
        classifier: { mode: "agent-self" },
        tiers: {
          simple: { args: { claude: ["--foo"] } },
        },
      },
    });
    const resolved = resolveTier(config, "simple");
    expect(resolved.agentArgs).toEqual(["--model", "sonnet", "--foo"]);
  });
});

describe("createAgentProvider", () => {
  it("returns a single-tier 'default' provider when tieredModels is undefined", () => {
    const config = makeConfig();
    const provider = createAgentProvider(config, stubRunInfo, {
      includeStopField: false,
    });
    expect(provider.defaultTier).toBe(DEFAULT_TIER_NAME);
    expect(provider.tiers).toEqual([DEFAULT_TIER_NAME]);
    expect(provider.tieredModels).toBeUndefined();
    const agent = provider.getAgentFor(DEFAULT_TIER_NAME);
    expect(agent.name).toBe("claude");
  });

  it("caches per-tier agents and only constructs each one once", () => {
    const tieredModels = {
      enabled: true as const,
      defaultTier: "complex",
      classifier: { mode: "agent-self" as const },
      tiers: {
        complex: { args: { claude: ["--model", "opus"] } },
        simple: { args: { claude: ["--model", "sonnet"] } },
      },
    };
    const config = makeConfig({
      tieredModels,
    });
    const provider = createAgentProvider(
      config,
      stubRunInfoWithTieredModels(tieredModels),
      {
        includeStopField: false,
      },
    );
    expect(provider.tiers).toEqual(["complex", "simple"]);
    const before = (ClaudeAgent as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;
    const a1 = provider.getAgentFor("complex");
    const a2 = provider.getAgentFor("complex");
    expect(a1).toBe(a2);
    const after = (ClaudeAgent as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;
    expect(after - before).toBe(1);
  });

  it("close() invokes each cached agent's close exactly once", async () => {
    const closeOne = vi.fn();
    const closeTwo = vi.fn();
    const tieredModels = {
      enabled: true as const,
      defaultTier: "complex",
      classifier: { mode: "agent-self" as const },
      tiers: {
        complex: { args: { claude: ["--model", "opus"] } },
        simple: { args: { claude: ["--model", "sonnet"] } },
      },
    };
    const config = makeConfig({
      tieredModels,
    });
    const provider = createAgentProvider(
      config,
      stubRunInfoWithTieredModels(tieredModels),
      {
        includeStopField: false,
      },
    );
    const a1 = provider.getAgentFor("complex");
    const a2 = provider.getAgentFor("simple");
    a1.close = closeOne;
    a2.close = closeTwo;
    await provider.close();
    expect(closeOne).toHaveBeenCalledTimes(1);
    expect(closeTwo).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy runs on the default tier when live tieredModels is enabled", () => {
    const config = makeConfig({
      tieredModels: {
        enabled: true,
        defaultTier: "complex",
        classifier: { mode: "agent-self" },
        tiers: {
          complex: { args: { claude: ["--model", "opus"] } },
        },
      },
    });

    const provider = createAgentProvider(config, stubRunInfo, {
      includeStopField: false,
    });

    expect(provider.defaultTier).toBe(DEFAULT_TIER_NAME);
    expect(provider.tiers).toEqual([DEFAULT_TIER_NAME]);
    expect(provider.tieredModels).toBeUndefined();
    expect(provider.getAgentFor(DEFAULT_TIER_NAME).name).toBe("claude");
  });
});
