import { join } from "node:path";
import {
  buildAgentOutputSchema,
  type Agent,
  type AgentOutputCommitField,
  type AgentOutputTierField,
} from "./types.js";
import {
  getAcpTarget,
  isAcpSpec,
  isModelClassFlag,
  type AgentName,
  type AgentSpec,
  type Config,
} from "../config.js";
import {
  isTieredModelsActive,
  type TieredModelsConfig,
} from "../tiered-models.js";
import type { RunInfo } from "../run.js";
import { AcpAgent } from "./acp.js";
import { ClaudeAgent } from "./claude.js";
import { CopilotAgent } from "./copilot.js";
import { CodexAgent } from "./codex.js";
import { OpenCodeAgent } from "./opencode.js";
import { PiAgent } from "./pi.js";
import { RovoDevAgent } from "./rovodev.js";

export interface CreateAgentOptions {
  includeStopField: boolean;
  commitFields?: AgentOutputCommitField[];
  tierField?: AgentOutputTierField;
  acpRegistryOverrides?: Record<string, string>;
}

export const DEFAULT_TIER_NAME = "default";

export interface ResolvedTier {
  tierName: string;
  agent: AgentSpec;
  agentPath: string | undefined;
  agentArgs: string[] | undefined;
  acpRegistryOverrides: Record<string, string>;
  local: boolean;
}

function getNativeAgentName(spec: AgentSpec): AgentName | undefined {
  return isAcpSpec(spec) ? undefined : (spec as AgentName);
}

function tierSetsModelClassFlag(
  tierArgs: string[] | undefined,
  agent: AgentName,
): boolean {
  if (tierArgs === undefined) return false;
  return tierArgs.some((arg) => isModelClassFlag(agent, arg));
}

// Drops top-level --model-class flag (and its value when written as separate
// args). Only fires when the tier supplies a model-class flag of its own,
// so non-tier callers see unchanged top-level args.
function dropModelClassFlags(topArgs: string[], agent: AgentName): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < topArgs.length) {
    const arg = topArgs[i]!;
    if (isModelClassFlag(agent, arg)) {
      if (arg.includes("=")) {
        i += 1;
      } else {
        i += 2;
      }
      continue;
    }
    result.push(arg);
    i += 1;
  }
  return result;
}

export function resolveTier(config: Config, tierName: string): ResolvedTier {
  const tieredModels = config.tieredModels;
  if (!isTieredModelsActive(tieredModels)) {
    const native = getNativeAgentName(config.agent);
    return {
      tierName: DEFAULT_TIER_NAME,
      agent: config.agent,
      agentPath: native ? config.agentPathOverride[native] : undefined,
      agentArgs: native ? config.agentArgsOverride[native] : undefined,
      acpRegistryOverrides: { ...config.acpRegistryOverrides },
      local: false,
    };
  }

  const tier = tieredModels.tiers[tierName];
  if (tier === undefined) {
    throw new Error(`Unknown tier: ${tierName}`);
  }

  const effectiveAgent: AgentSpec = tier.agent ?? config.agent;
  const native = getNativeAgentName(effectiveAgent);

  let agentArgs: string[] | undefined;
  let agentPath: string | undefined;
  if (native !== undefined) {
    agentPath = config.agentPathOverride[native];
    const topArgsRaw = config.agentArgsOverride[native] ?? [];
    const tierArgsRaw = tier.args?.[native];
    const tierSetsModel = tierSetsModelClassFlag(tierArgsRaw, native);
    const topArgs = tierSetsModel
      ? dropModelClassFlags(topArgsRaw, native)
      : topArgsRaw;
    const combined = [...topArgs, ...(tierArgsRaw ?? [])];
    agentArgs = combined.length === 0 ? undefined : combined;
  }

  const acpRegistryOverrides: Record<string, string> = {
    ...config.acpRegistryOverrides,
    ...(tier.acpRegistryOverrides ?? {}),
  };

  return {
    tierName,
    agent: effectiveAgent,
    agentPath,
    agentArgs,
    acpRegistryOverrides,
    local: tier.local === true,
  };
}

export function createAgent(
  spec: AgentSpec,
  runInfo: RunInfo,
  pathOverride: string | undefined,
  agentArgsOverride: string[] | undefined,
  options: CreateAgentOptions,
): Agent {
  const schema = buildAgentOutputSchema({
    includeStopField: options.includeStopField,
    commitFields: options.commitFields,
    ...(options.tierField === undefined
      ? {}
      : { tierField: options.tierField }),
  });

  if (isAcpSpec(spec)) {
    return new AcpAgent({
      target: getAcpTarget(spec),
      schema,
      runId: runInfo.runId,
      sessionStateDir: join(runInfo.runDir, "acp-sessions"),
      ...(options.acpRegistryOverrides === undefined
        ? {}
        : { registryOverrides: options.acpRegistryOverrides }),
    });
  }

  const name = spec;
  switch (name) {
    case "claude":
      return new ClaudeAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "codex":
      return new CodexAgent(runInfo.schemaPath, {
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
    case "copilot":
      return new CopilotAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "opencode":
      return new OpenCodeAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "pi":
      return new PiAgent({
        bin: pathOverride,
        extraArgs: agentArgsOverride,
        schema,
      });
    case "rovodev":
      return new RovoDevAgent(runInfo.schemaPath, {
        bin: pathOverride,
        extraArgs: agentArgsOverride,
      });
  }
}

export interface AgentProvider {
  defaultTier: string;
  tiers: readonly string[];
  tieredModels: TieredModelsConfig | undefined;
  getAgentFor(tier: string): Agent;
  close(): Promise<void> | void;
}

export function createAgentProvider(
  config: Config,
  runInfo: RunInfo,
  options: CreateAgentOptions,
): AgentProvider {
  const tieredModels = runInfo.tieredModels;
  const active = isTieredModelsActive(tieredModels);
  const tiers = active ? Object.keys(tieredModels.tiers) : [DEFAULT_TIER_NAME];
  const defaultTier = active ? tieredModels.defaultTier : DEFAULT_TIER_NAME;
  const cache = new Map<string, Agent>();

  const effectiveConfig: Config = active
    ? { ...config, tieredModels }
    : { ...config, tieredModels: undefined };

  const getAgentFor = (tierName: string): Agent => {
    const cached = cache.get(tierName);
    if (cached !== undefined) return cached;

    const resolved = resolveTier(effectiveConfig, tierName);
    const agent = createAgent(
      resolved.agent,
      runInfo,
      resolved.agentPath,
      resolved.agentArgs,
      {
        includeStopField: options.includeStopField,
        ...(options.commitFields === undefined
          ? {}
          : { commitFields: options.commitFields }),
        ...(options.tierField === undefined
          ? {}
          : { tierField: options.tierField }),
        acpRegistryOverrides: resolved.acpRegistryOverrides,
      },
    );
    cache.set(tierName, agent);
    return agent;
  };

  const close = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const agent of cache.values()) {
      try {
        await agent.close?.();
      } catch (err) {
        errors.push(err);
      }
    }
    cache.clear();
    if (errors.length > 0) {
      throw errors[0];
    }
  };

  return {
    defaultTier,
    tiers,
    tieredModels: active ? tieredModels : undefined,
    getAgentFor,
    close,
  };
}
