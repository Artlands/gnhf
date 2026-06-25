import type { Agent, AgentOutput, OnUsage, TokenUsage } from "./types.js";

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

function extractTier(output: AgentOutput, fieldName: string): string {
  const value = (output as unknown as Record<string, unknown>)[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `classifier output missing or invalid ${fieldName}: got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
