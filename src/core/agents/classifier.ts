import type { Agent, AgentOutput, OnUsage, TokenUsage } from "./types.js";
import { parseAgentJson } from "./json-extract.js";

export interface ClassifierResult {
  tier: string;
  usage: TokenUsage;
}

export interface RunClassifierOptions {
  agent: Agent;
  objective: string;
  cwd: string;
  defaultTier: string;
  tiers: { name: string; description?: string }[];
  fieldName: string;
  signal?: AbortSignal;
  onUsage?: OnUsage;
  logPath?: string;
}

export interface RouterPlanResult {
  tiers: string[];
  plan: string[];
  rationale: string;
  usage: TokenUsage;
}

export interface RouterClassifierOptions {
  agent: Agent;
  objective: string;
  cwd: string;
  defaultTier: string;
  tiers: { name: string; description?: string }[];
  signal?: AbortSignal;
  onUsage?: OnUsage;
  logPath?: string;
}

export function buildClassifierPrompt(params: {
  objective: string;
  defaultTier: string;
  tiers: { name: string; description?: string }[];
  fieldName: string;
}): string {
  const tierLines = params.tiers
    .map(
      (tier) =>
        `- \`${tier.name}\`${tier.description ? `: ${tier.description}` : ""}`,
    )
    .join("\n");

  return `You are routing the first iteration of a long-running coding loop to the right model tier. Do not modify any files. Do not run any commands. Read the objective below, then choose the cheapest tier sufficient for the first iteration's planned work.

Available tiers:
${tierLines}

Output the structured JSON object expected by the loop with:
- success: true
- summary: "tier-selection"
- key_changes_made: []
- key_learnings: []
- ${params.fieldName}: the name of the tier you chose for the first iteration

When in doubt, choose "${params.defaultTier}". Prefer cheaper tiers unless the first iteration needs planning across files, design decisions, or non-obvious debugging.

## Objective

${params.objective}`;
}

export function buildRouterClassifierPrompt(params: {
  objective: string;
  defaultTier: string;
  tiers: { name: string; description?: string }[];
}): string {
  const tierLines = params.tiers
    .map(
      (tier) =>
        `- \`${tier.name}\`${tier.description ? `: ${tier.description}` : ""}`,
    )
    .join("\n");

  return `You are routing a long-running coding loop to the right model tiers. Do not modify any files. Do not run any commands. Read the objective below, then plan how many iterations you expect the loop to need. For each iteration, choose the cheapest tier sufficient for the work in that iteration.

Available tiers:
${tierLines}

Return a JSON object with these fields:
- "tiers": an array of tier names, one per iteration in order, each chosen from the available tiers above
- "plan": an array of short bullet descriptions, same length and parallel to "tiers", describing the expected work for each iteration
- "rationale": a one-paragraph explanation of your tier choices

Output ONLY this JSON object. Do not wrap it in markdown fences or add any other text.

When in doubt, choose "${params.defaultTier}". Prefer cheaper tiers unless the iteration needs planning across files, design decisions, or non-obvious debugging.

## Objective

${params.objective}`;
}

export async function runUpfrontClassifier(
  options: RunClassifierOptions,
): Promise<ClassifierResult> {
  const prompt = buildClassifierPrompt({
    objective: options.objective,
    defaultTier: options.defaultTier,
    tiers: options.tiers,
    fieldName: options.fieldName,
  });

  const runOptions: {
    onUsage?: OnUsage;
    signal?: AbortSignal;
    logPath?: string;
  } = {};
  if (options.onUsage) runOptions.onUsage = options.onUsage;
  if (options.signal) runOptions.signal = options.signal;
  if (options.logPath) runOptions.logPath = options.logPath;

  const result = await options.agent.run(prompt, options.cwd, runOptions);
  const tier = extractTier(result.output, options.fieldName);
  return { tier, usage: result.usage };
}

export async function runRouterClassifier(
  options: RouterClassifierOptions,
): Promise<RouterPlanResult> {
  const prompt = buildRouterClassifierPrompt({
    objective: options.objective,
    defaultTier: options.defaultTier,
    tiers: options.tiers,
  });

  const capturedText: string[] = [];
  const runOptions: {
    onUsage?: OnUsage;
    signal?: AbortSignal;
    logPath?: string;
    onMessage?: (text: string) => void;
  } = {};
  if (options.onUsage) runOptions.onUsage = options.onUsage;
  if (options.signal) runOptions.signal = options.signal;
  if (options.logPath) runOptions.logPath = options.logPath;
  runOptions.onMessage = (text: string) => {
    capturedText.push(text);
  };

  const result = await options.agent.run(prompt, options.cwd, runOptions);
  const fullText = capturedText.join("");
  const parsed = parseAgentJson(fullText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("router classifier returned no valid JSON plan");
  }

  const record = parsed as Record<string, unknown>;
  const tiers = record.tiers;
  const plan = record.plan;
  const rationale = record.rationale;

  if (
    !Array.isArray(tiers) ||
    !tiers.every((t): t is string => typeof t === "string") ||
    tiers.length === 0
  ) {
    throw new Error(
      `router classifier: invalid tiers (expected non-empty string array, got ${JSON.stringify(tiers)})`,
    );
  }
  if (
    !Array.isArray(plan) ||
    !plan.every((p): p is string => typeof p === "string")
  ) {
    throw new Error(
      `router classifier: invalid plan (expected string array, got ${JSON.stringify(plan)})`,
    );
  }
  if (plan.length !== tiers.length) {
    throw new Error(
      `router classifier: tiers and plan length mismatch (${tiers.length} vs ${plan.length})`,
    );
  }
  if (typeof rationale !== "string" || rationale.trim() === "") {
    throw new Error(
      `router classifier: invalid rationale (expected non-empty string, got ${JSON.stringify(rationale)})`,
    );
  }

  return { tiers, plan, rationale, usage: result.usage };
}

function extractTier(output: AgentOutput, fieldName: string): string {
  const value = (output as unknown as Record<string, unknown>)[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `classifier output missing or invalid ${fieldName}: got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
