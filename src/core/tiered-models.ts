import type { AgentName, AgentSpec } from "./config.js";

export type ClassifierMode = "off" | "agent-self" | "router" | "router+self";

export const CLASSIFIER_MODES: readonly ClassifierMode[] = [
  "off",
  "agent-self",
  "router",
  "router+self",
] as const;

export const TIER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const CLASSIFIER_TIER_NAME = "classifier";

export interface TierDef {
  description?: string;
  agent?: AgentSpec;
  args?: Partial<Record<AgentName, string[]>>;
  acpRegistryOverrides?: Record<string, string>;
  local?: boolean;
}

export interface TieredModelsClassifierConfig {
  mode: ClassifierMode;
  routerTier?: string;
}

export interface TieredModelsConfig {
  enabled: boolean;
  defaultTier: string;
  classifier: TieredModelsClassifierConfig;
  tiers: Record<string, TierDef>;
}

export function classifierUsesRouter(mode: ClassifierMode): boolean {
  return mode === "router" || mode === "router+self";
}

export function classifierUsesSelf(mode: ClassifierMode): boolean {
  return mode === "agent-self" || mode === "router+self";
}

export function isTieredModelsActive(
  config: TieredModelsConfig | undefined,
): config is TieredModelsConfig {
  return config !== undefined && config.enabled === true;
}

export function getTierNames(config: TieredModelsConfig): string[] {
  return Object.keys(config.tiers);
}

export function isLocalTier(
  config: TieredModelsConfig | undefined,
  tierName: string,
): boolean {
  if (!isTieredModelsActive(config)) return false;
  return config.tiers[tierName]?.local === true;
}
