import { InvalidConfigError } from "./config-errors.js";
import {
  AGENT_NAMES,
  isAcpSpec,
  isAgentSpec,
  isReservedAgentArg,
  type AgentName,
  type AgentSpec,
} from "./config.js";
import {
  CLASSIFIER_MODES,
  TIER_NAME_PATTERN,
  type ClassifierMode,
  type TierDef,
  type TieredModelsConfig,
} from "./tiered-models.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected a boolean`,
    );
  }
  return value;
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected a string`,
    );
  }
  return value;
}

function ensureNonEmptyString(value: unknown, label: string): string {
  const str = ensureString(value, label);
  if (str.trim() === "") {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected a non-empty string`,
    );
  }
  return str;
}

function normalizeTierArgs(
  value: unknown,
  tierName: string,
): Partial<Record<AgentName, string[]>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels.tiers.${tierName}.args: expected an object`,
    );
  }

  const validNames = new Set<string>(AGENT_NAMES);
  const result: Partial<Record<AgentName, string[]>> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!validNames.has(key)) {
      throw new InvalidConfigError(
        `Invalid agent name in tieredModels.tiers.${tierName}.args: "${key}"`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new InvalidConfigError(
        `Invalid config value for tieredModels.tiers.${tierName}.args.${key}: expected an array of strings`,
      );
    }
    const args = raw.map((entry, index) => {
      if (typeof entry !== "string") {
        throw new InvalidConfigError(
          `Invalid config value for tieredModels.tiers.${tierName}.args.${key}[${index}]: expected a string`,
        );
      }
      const trimmed = entry.trim();
      if (trimmed === "") {
        throw new InvalidConfigError(
          `Invalid config value for tieredModels.tiers.${tierName}.args.${key}[${index}]: expected a non-empty string`,
        );
      }
      // tieredModelsEnabled: false here is intentional — model-class flags
      // are exactly what tier args are for. Other gnhf-managed flags (-p,
      // --output-format, --json-schema, etc.) are still rejected.
      if (
        isReservedAgentArg(key as AgentName, trimmed, {
          tieredModelsEnabled: false,
        })
      ) {
        throw new InvalidConfigError(
          `Invalid config value for tieredModels.tiers.${tierName}.args.${key}[${index}]: "${trimmed}" is managed by gnhf and cannot be overridden`,
        );
      }
      return trimmed;
    });
    result[key as AgentName] = args;
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeAcpRegistryOverrides(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidConfigError(
      `Invalid config value for ${label}: expected an object`,
    );
  }

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.trim() === "") {
      throw new InvalidConfigError(
        `Invalid target name in ${label}: expected a non-empty string`,
      );
    }
    const command = ensureNonEmptyString(raw, `${label}.${key}`);
    result[key] = command.trim();
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

function normalizeTier(value: unknown, tierName: string): TierDef {
  if (!isRecord(value)) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels.tiers.${tierName}: expected an object`,
    );
  }

  const allowedKeys = new Set([
    "description",
    "agent",
    "args",
    "acpRegistryOverrides",
    "local",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new InvalidConfigError(
        `Unsupported config key for tieredModels.tiers.${tierName}.${key}`,
      );
    }
  }

  const tier: TierDef = {};

  if (value.description !== undefined) {
    tier.description = ensureNonEmptyString(
      value.description,
      `tieredModels.tiers.${tierName}.description`,
    );
  }

  if (value.agent !== undefined) {
    const agent = value.agent;
    if (!isAgentSpec(agent)) {
      throw new InvalidConfigError(
        `Invalid config value for tieredModels.tiers.${tierName}.agent: not a valid agent spec`,
      );
    }
    tier.agent = agent as AgentSpec;
  }

  const args = normalizeTierArgs(value.args, tierName);
  if (args !== undefined) tier.args = args;

  const acpRegistryOverrides = normalizeAcpRegistryOverrides(
    value.acpRegistryOverrides,
    `tieredModels.tiers.${tierName}.acpRegistryOverrides`,
  );
  if (acpRegistryOverrides !== undefined) {
    tier.acpRegistryOverrides = acpRegistryOverrides;
  }

  if (value.local !== undefined) {
    tier.local = ensureBoolean(
      value.local,
      `tieredModels.tiers.${tierName}.local`,
    );
  }

  return tier;
}

function normalizeClassifier(value: unknown): {
  mode: ClassifierMode;
  routerTier?: string;
} {
  if (value === undefined) {
    return { mode: "agent-self" };
  }
  if (!isRecord(value)) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels.classifier: expected an object`,
    );
  }

  const allowedKeys = new Set(["mode", "routerTier"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new InvalidConfigError(
        `Unsupported config key for tieredModels.classifier.${key}`,
      );
    }
  }

  const mode: ClassifierMode =
    value.mode === undefined
      ? "agent-self"
      : ((): ClassifierMode => {
          if (
            typeof value.mode !== "string" ||
            !(CLASSIFIER_MODES as readonly string[]).includes(value.mode)
          ) {
            throw new InvalidConfigError(
              `Invalid config value for tieredModels.classifier.mode: expected one of ${CLASSIFIER_MODES.join(", ")}`,
            );
          }
          return value.mode as ClassifierMode;
        })();

  const result: { mode: ClassifierMode; routerTier?: string } = { mode };
  if (value.routerTier !== undefined) {
    result.routerTier = ensureNonEmptyString(
      value.routerTier,
      "tieredModels.classifier.routerTier",
    );
  }
  return result;
}

function effectiveTierAgent(
  tier: TierDef,
  topLevelAgent: AgentSpec,
): AgentSpec {
  return tier.agent ?? topLevelAgent;
}

function isManagedServerAgent(agent: AgentSpec): boolean {
  return agent === "rovodev" || agent === "opencode" || isAcpSpec(agent);
}

function validateTierArgsMatchEffectiveAgent(
  tiers: Record<string, TierDef>,
  topLevelAgent: AgentSpec,
): void {
  for (const [name, tier] of Object.entries(tiers)) {
    if (tier.args === undefined) continue;

    const effective = effectiveTierAgent(tier, topLevelAgent);
    if (isAcpSpec(effective)) {
      throw new InvalidConfigError(
        `Invalid config value for tieredModels.tiers.${name}.args: tier args are only supported for native agents, but this tier uses "${effective}"`,
      );
    }

    for (const agent of Object.keys(tier.args)) {
      if (agent !== effective) {
        throw new InvalidConfigError(
          `Invalid config value for tieredModels.tiers.${name}.args.${agent}: tier args must match the effective tier agent "${effective}"`,
        );
      }
    }
  }
}

export function normalizeTieredModelsConfig(
  value: unknown,
  topLevelAgent: AgentSpec,
): TieredModelsConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels: expected an object`,
    );
  }

  const allowedKeys = new Set([
    "enabled",
    "defaultTier",
    "classifier",
    "tiers",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new InvalidConfigError(
        `Unsupported config key for tieredModels.${key}`,
      );
    }
  }

  const enabled =
    value.enabled === undefined
      ? false
      : ensureBoolean(value.enabled, "tieredModels.enabled");

  if (!enabled) {
    // Feature is off; collapse to undefined so the rest of the system can
    // treat "tiered models disabled" as a single state (no Config.tieredModels
    // field at all). Accept and discard the rest of the block; users may
    // leave tier definitions in place while toggling the feature.
    return undefined;
  }

  if (!isRecord(value.tiers)) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels.tiers: expected an object`,
    );
  }

  const tiers: Record<string, TierDef> = {};
  for (const [name, raw] of Object.entries(value.tiers)) {
    if (!TIER_NAME_PATTERN.test(name)) {
      throw new InvalidConfigError(
        `Invalid tier name "${name}" in tieredModels.tiers: must match ${TIER_NAME_PATTERN.source}`,
      );
    }
    if (name === "default") {
      throw new InvalidConfigError(
        `Invalid tier name "default" in tieredModels.tiers: "default" is reserved by gnhf as the legacy sentinel and cannot be used as a tier name`,
      );
    }
    tiers[name] = normalizeTier(raw, name);
  }

  if (Object.keys(tiers).length === 0) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels.tiers: expected at least one tier`,
    );
  }

  if (value.defaultTier === undefined) {
    throw new InvalidConfigError(
      `Missing config value for tieredModels.defaultTier`,
    );
  }
  const defaultTier = ensureNonEmptyString(
    value.defaultTier,
    "tieredModels.defaultTier",
  );
  if (!(defaultTier in tiers)) {
    throw new InvalidConfigError(
      `Invalid config value for tieredModels.defaultTier: "${defaultTier}" is not a configured tier`,
    );
  }

  const classifier = normalizeClassifier(value.classifier);
  if (classifier.mode === "router" || classifier.mode === "router+self") {
    if (classifier.routerTier === undefined) {
      throw new InvalidConfigError(
        `Missing config value for tieredModels.classifier.routerTier (required when mode is "${classifier.mode}")`,
      );
    }
    if (!(classifier.routerTier in tiers)) {
      throw new InvalidConfigError(
        `Invalid config value for tieredModels.classifier.routerTier: "${classifier.routerTier}" is not a configured tier`,
      );
    }
  }

  validateTierArgsMatchEffectiveAgent(tiers, topLevelAgent);

  // Managed-server / ACP agents at the top level can only be used with tiers
  // that swap the whole agent. Args-only tiering would need per-tier servers
  // which isn't in the MVP support matrix.
  if (isManagedServerAgent(topLevelAgent)) {
    for (const [name, tier] of Object.entries(tiers)) {
      const effective = effectiveTierAgent(tier, topLevelAgent);
      if (isManagedServerAgent(effective) && tier.agent === undefined) {
        throw new InvalidConfigError(
          `Invalid config value for tieredModels.tiers.${name}: top-level agent "${topLevelAgent}" requires every tier to set tier.agent (managed-server / ACP agents support whole-agent swap only)`,
        );
      }
    }
  }

  return {
    enabled: true,
    defaultTier,
    classifier,
    tiers,
  };
}
