# Tiered-model routing - implementation plan

Status: Phase 1 infrastructure is implemented. Self-classification, router
plans, CLI tier pinning flags, prompt tier-selection flow, per-tier token
budgets, renderer summaries, and tier telemetry remain planned follow-up
phases.

## Goal

Save tokens by letting `gnhf` run cheap or self-hosted models on "simple"
iterations and reserve a top-tier model (e.g. Opus, GPT-5) for iterations that
genuinely need planning. The top-tier model may itself be used to classify task
complexity. This is an opt-in feature; today's runs are unaffected when it is
disabled.

## Constraints from the existing code

Anchor points the remaining implementation must integrate with:

- Phase 1 introduced `AgentProvider` in `src/core/agents/factory.ts`. The
  orchestrator asks the provider for the default tier's agent, but
  self-classification and router phases still need to choose non-default tiers
  per iteration.
- Model choice without tiered models still flows through `agentArgsOverride` in
  `~/.gnhf/config.yml` (e.g. `claude: ["--model", "sonnet"]`). With
  `tieredModels.enabled`, model-class flags move into tier args.
- The output schema is fixed at run start. `src/core/run.ts` writes
  `.gnhf/runs/<id>/output-schema.json` once. `buildAgentOutputSchema`
  (`src/core/agents/types.ts`) is the single source of truth.
- `rovodev` and `opencode` are long-running HTTP servers
  (`src/core/agents/managed-process.ts`). `acp` keeps a persistent session per
  run. These cannot trivially swap models per iteration.
- `claude`, `codex`, `copilot`, `pi` spawn fresh per iteration — they can swap
  cleanly.
- `config.ts` rejects "reserved" args via `isReservedAgentArg`. Any flag this
  feature takes ownership of (e.g. `--model`) must be added there conditionally
  so existing users who set `--model` in `agentArgsOverride` are not broken when
  they have not opted into tiered models.
- Per-run metadata that must survive resume (commit-message preset, stop-when)
  is persisted as files in `.gnhf/runs/<id>/` and reloaded on resume. New
  tier-related state must follow the same pattern.

## Design

### 1. Config schema

New top-level block in `~/.gnhf/config.yml`:

```yaml
tieredModels:
  enabled: true
  defaultTier: complex            # tier used when classifier abstains or fails
  classifier:
    mode: agent-self              # one of: off | agent-self | router | router+self
    routerTier: complex           # tier used for any classifier LLM call
  tiers:
    complex:
      description: "Planning across files, design decisions, non-obvious debugging."
      args:
        claude: ["--model", "opus"]
        codex:  ["-m", "gpt-5", "-c", 'model_reasoning_effort="high"']
    simple:
      description: "Mechanical edits, formatting, known-recipe work."
      args:
        claude: ["--model", "sonnet"]
        codex:  ["-m", "gpt-5-mini"]
    cheap:
      description: "Trivial fixes; routed to a local model."
      agent: "acp:local-qwen"          # whole-agent swap for this tier
      local: true                      # tokens do NOT count toward --max-tokens
      acpRegistryOverrides:             # cross-tier registry override
        local-qwen: "/usr/local/bin/qwen-acp"
```

Field rules:

- `enabled` gates the feature. When `false`, behavior is identical to today.
- `tiers` is an open map `Record<string, TierDef>`. Tier names are free-form
  strings; only `defaultTier` is treated specially by the orchestrator. Naming
  conventions like `complex`/`simple`/`cheap` are documentation, not enums.
- A `TierDef` may set any of:
  - `description: string` — one-line hint shown to the agent in the iteration
    prompt so it can choose intelligently.
  - `args: Partial<Record<AgentName, string[]>>` — per-native-agent extra args
    spliced **after** the top-level `agentArgsOverride[agent]`. Tier args win on
    conflict (e.g. tier supplies `--model opus`, overriding any model set in
    `agentArgsOverride`).
  - `agent: AgentSpec` — whole-agent swap. When set, this tier uses a different
    agent entirely (e.g. an `acp:` target pointing at a self-hosted model).
    Takes priority over `args`.
  - `acpRegistryOverrides: Record<string, string>` — tier-scoped ACP registry
    overrides, merged on top of the top-level `acpRegistryOverrides` when the
    tier resolves to an `acp:` spec. (Confirmed open question #2.)
  - `local: boolean` (default `false`) — declares that this tier runs against
    a self-hosted or local model. Tokens accrued under a local tier are
    excluded from the `--max-tokens` budget check (see §8). They are still
    tallied separately so the renderer and exit summary can show the full
    picture. There is no auto-detection — a tier is local only when the user
    declares it. An `acp:` agent is not assumed local just because it is ACP.
- `classifier.mode`:
  - `off` — every iteration uses `defaultTier`. Kill switch.
  - `agent-self` — the previous iteration's structured output declares the next
    iteration's tier (see §3). Iteration 1's tier is chosen by an upfront
    one-shot classifier call (see §4).
  - `router` — a single upfront classifier call produces a tier plan for the
    whole run, including iteration 1 (see §4).
  - `router+self` — router seeds the plan; each iteration's
    `next_iteration_tier` overrides the plan slot for the next iteration.

### 2. Per-iteration agent construction

Phase 1 replaced the single-`Agent`-per-run contract with an agent provider.

```ts
// src/core/agents/factory.ts
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
): AgentProvider;
```

Behavior:

- When `tieredModels.enabled === false`, `createAgentProvider` returns a
  provider whose `tiers = ["default"]` and `getAgentFor` always returns the
  agent constructed exactly as `createAgent` does today. This is the zero-change
  path that keeps every existing test green without modification.
- When enabled, each tier lazily constructs its `Agent` on first use and caches
  it, so a run that never selects a tier never spawns that tier's process tree.
  This matters because `rovodev`/`opencode` would otherwise start managed
  servers nobody uses.
- `provider.close()` closes every cached agent. This is wired through the
  existing shutdown path in `orchestrator.ts`.

The orchestrator now holds an `AgentProvider`, not an `Agent`. Per iteration it
resolves `agent = provider.getAgentFor(tier)` and calls `.run(...)` on that.

### 3. Self-classification path (`mode: "agent-self"` and `"router+self"`)

Extend the output schema, mirroring how `should_fully_stop` is added today.
The `next_iteration_tier` field is added to the iteration schema **only** when
`classifier.mode` is `agent-self` or `router+self`. In plain `mode: router`,
the iteration schema is unchanged from today — the orchestrator consumes from
the prebuilt plan and ignores any per-iteration tier guess. In `mode: off`,
the field is also absent.

```jsonc
// added when tieredModels.enabled && classifier.mode in ("agent-self", "router+self")
"next_iteration_tier": {
  "type": "string",
  "enum": ["complex", "simple", "cheap"]   // populated from config.tieredModels.tiers
}
```

Implementation notes:

- Include in `required` so OpenAI strict mode (codex `--output-schema`)
  accepts it. Mirror the existing `commitFields` pattern in
  `buildAgentOutputSchema` — add a new option:
  ```ts
  tierField?: { name: string; allowed: string[] }
  ```
- Thread it through `RunSchemaOptions` (`src/core/run.ts`) so the schema is
  rewritten on resume just like `commitMessage`/`stopWhen` already are.
- `src/templates/iteration-prompt.ts` gains a new "Tier selection" section
  listing tiers with their `description` strings and one example each, e.g.:

  > **Tier for the next iteration**
  > Choose the cheapest tier sufficient for the next step. Prefer `simple`
  > unless planning, cross-file reasoning, or non-obvious debugging is needed.
  > - `complex`: planning across files, design decisions, non-obvious debugging
  > - `simple`: mechanical edits, formatting, known-recipe work
  > - `cheap`: trivial fixes routed to a local model

  Followed by the existing output-field block, with `next_iteration_tier`
  appended.
- The orchestrator stores `nextTier` (initialized from §4) and uses it for the
  next iteration's `getAgentFor(...)`.
- Failure overrides:
  - On `success=false` reported by the agent: force `nextTier = defaultTier`
    with `source: "failure-fallback"`. The agent's last self-assessment is
    untrustworthy.
  - On `CommitFailedError` (commit-repair iteration): force
    `nextTier = defaultTier` with `source: "commit-repair"`.
  - On hard agent error (caught in `runIteration` catch block): force
    `nextTier = defaultTier` with `source: "agent-error"`.

### 4. Router path (`mode: "router"` and `"router+self"`)

Single upfront LLM call before iteration 1 produces a tier plan.

- Implemented as a lightweight one-shot, shaped like an `Agent.run` but with a
  dedicated output schema:
  ```jsonc
  {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "plan": { "type": "array", "items": { "type": "string" } },
      "tiers": {
        "type": "array",
        "items": { "type": "string", "enum": ["complex", "simple", "cheap"] }
      },
      "rationale": { "type": "string" }
    },
    "required": ["plan", "tiers", "rationale"]
  }
  ```
- Uses `provider.getAgentFor(classifier.routerTier)` so it reuses the same agent
  construction path; no separate "classifier agent" class.
- Persist result to `.gnhf/runs/<id>/tier-plan.json`. On resume, reload and
  resume consumption from the iteration index that was reached.
- The orchestrator pops one tier from `tiers` per iteration. Once exhausted:
  - In `mode: "router"`: fall back to `defaultTier`.
  - In `mode: "router+self"`: switch to self-classification using the previous
    iteration's `next_iteration_tier`.

`mode: "agent-self"` also performs an upfront classifier call for iteration 1
only — same schema and same agent (`provider.getAgentFor(classifier.routerTier)`)
as router, but `tiers` is required to be length 1. The orchestrator uses
`tiers[0]` for iteration 1 and discards `plan`. (Confirmed open question #1:
the classifier picks iteration 1's tier rather than forcing strong-tier as a
default.)

**Classifier prompt (sketch).** Used by both router-mode and agent-self
iteration-1 calls; only the requested `tiers` array length and the framing
differ.

> You are helping route iterations of a long-running coding loop. The
> objective is below. Plan how many iterations you expect the loop to need,
> and for each one choose the cheapest tier sufficient for the work in that
> iteration.
>
> Tiers:
> - `complex`: planning across files, design decisions, non-obvious debugging
> - `simple`: mechanical edits, formatting, known-recipe work
> - `cheap`: trivial fixes routed to a local model
>
> Return:
> - `plan`: short bullet for each iteration describing the expected work
> - `tiers`: parallel array of tier names, same length as `plan`
> - `rationale`: one paragraph
>
> Objective: {{prompt}}

(For agent-self iteration-1, swap the second sentence with "Choose the cheapest
tier sufficient for the *first* iteration's work" and require `plan`/`tiers`
of length 1.)

**Classifier failure modes.** All of these fall back to `defaultTier` for
iteration 1 and (router mode) leave `tier-plan.json` unwritten:

- Classifier process spawn error.
- Classifier call returns invalid JSON or fails schema validation.
- Classifier call returns a tier name not in `config.tieredModels.tiers`.
- Classifier call times out (no specific timeout in MVP; relies on user's
  agent-level timeouts and SIGINT). Document this as a known limitation.

Log every fallback via `appendDebugLog("classifier:fallback", { reason, ... })`
and append a `tier-history.jsonl` entry with `source: "classifier-error"` for
iteration 1.

**Classifier token budget.** Classifier tokens are accounted under a synthetic
tier name `"classifier"` in `inputTokensByTier`/`outputTokensByTier`. They
count toward the billable `--max-tokens` budget when
`tieredModels.tiers[classifier.routerTier].local !== true`, and are excluded
otherwise — same rule as any other tier (see §8). If the upfront call alone
exceeds `--max-tokens` (and the router tier is billable), abort the run with
the existing token-limit reason before iteration 1 starts.

### 5. CLI surface

New flags on the main `gnhf` command in `src/cli.ts`:

- `--tier <name>` — pin this run to a single tier; bypasses classifier
  entirely. Runtime-only, not persisted. Useful for `gnhf "fix typo" --tier
  simple`.
- `--no-classifier` — equivalent to `classifier.mode: off` for this run.
  Runtime-only.
- Both flags are added to `redactDebugArgs` if they could carry sensitive
  agent-spec strings (they cannot today, but mirror the pattern).
- Flag validation: `--tier <name>` must match a configured tier name when
  `tieredModels.enabled`. When `enabled=false` and `--tier` is set, error with
  a message pointing at the config.

### 6. Reserved-arg additions in `config.ts`

When `tieredModels.enabled === true`, gnhf manages model-selection flags for
native agents. Add to `isReservedAgentArg` **conditionally** (signature:
`isReservedAgentArg(agent, arg, opts: { tieredModelsEnabled: boolean })`):

- claude: `--model`, `--model=...`
- codex: `-m`, `--model`, `--model=...`
- copilot: `--model`, `--model=...`
- pi: `--model`, `--model=...`

Validation error message must point to `tieredModels.tiers.<name>.args` as the
migration path so users who have `--model` in their top-level
`agentArgsOverride` get a clear next step.

Reuse `isReservedAgentArg` from inside the new `TierDef.args` validation too —
tier args are subject to the same rules as top-level `agentArgsOverride` (no
overriding gnhf-managed flags like `-p`, `--output-format`, etc.), except that
inside a tier the `--model`-class flags are *allowed* (that is the whole
point).

**Effective-agent rule for tier args.** When a tier swaps the agent (e.g.
top-level `agent: claude`, tier `simple` has `agent: codex`), the tier's `args`
map is validated against the **tier's effective agent**, not the top-level
agent. So `tieredModels.tiers.simple.args.codex` is the relevant entry, and it
is validated under `codex`'s reserved-arg rules. The tier's `args` map for
agents other than the effective agent is rejected at config load so typos are
not silently ignored.

**Flag dedup at splice time.** When tier args set a model-class flag that also
appears in the top-level `agentArgsOverride`, drop the top-level occurrence at
splice time so the CLI does not receive two `--model` flags. The dedup rule
fires only for the model-class flags listed above; everything else preserves
the existing "splice tier after top-level, last wins" behavior. Since
top-level `--model` is rejected by validation when `tieredModels.enabled`,
this dedup mainly protects against migration windows and explicit user
overrides via env-injected args.

### 7. Schema, persistence, and resume

Per-run metadata files under `.gnhf/runs/<id>/`:

- `tier-config.json` — frozen copy of the resolved `tieredModels` block at run
  start. Resume reads this, not `~/.gnhf/config.yml`. Same rationale as the
  existing `commit-message` file: a config change mid-run must not silently
  retarget already-decided iterations. This file is implemented in Phase 1.
- `tier-plan.json` — present only when `classifier.mode` includes router.
  Shape: `{ tiers: string[], plan: string[], rationale: string, consumed: number }`.
  Planned for the router phase.
- `tier-history.jsonl` — append-only, one line per iteration:
  ```json
  {"iteration": 1, "tier": "complex", "source": "router", "ts": "..."}
  ```
  `source` is one of: `default`, `self`, `router`, `override` (CLI `--tier`),
  `failure-fallback`, `commit-repair`, `agent-error`. This is the auditability
  hook for "why did this run burn so many Opus tokens?" Planned for the
  self-classification phase.

Update `RunInfo` and `RunSchemaOptions` (`src/core/run.ts`) to surface tier
metadata. Phase 1 surfaces `tier-config.json`: `setupRun` writes it, and
`resumeRun` reads it and uses it instead of the live config block. Router and
history files will add their own metadata fields in later phases.

**Backwards compatibility on resume.** A run started before this feature exists
has no `tier-config.json`. `resumeRun` must treat the absence of the file as
"tiered models off for this run" — do not consult the live config, do not add
the tier field to the schema. Same pattern as the existing
`backfillLegacyBaseCommit` flow.

**Precedence on resume when the live config has drifted:**
1. CLI flags for *this invocation* (`--tier`, `--no-classifier`) win and are
   applied as one-shot overrides without rewriting `tier-config.json`. A
   `--tier` pin on resume is recorded in `tier-history.jsonl` with
   `source: "override"` for each affected iteration.
2. `tier-config.json` is the source of truth for `tiers`, `defaultTier`, and
   `classifier.mode` when no CLI override is present.
3. The live `~/.gnhf/config.yml` is **not** consulted for the resumed run's
   tier block (same rationale as the existing commit-message preset freeze).

**Current-branch resume with prompt change** (the `(o) Update prompt and
continue` flow in `cli.ts`). The router's `tier-plan.json` was built against
the old prompt; the new prompt may need a different shape of plan. On this
path:
- If `classifier.mode` includes router, delete `tier-plan.json`. The
  orchestrator will run a fresh upfront classifier call before the next
  iteration. Log via `appendDebugLog("classifier:plan-invalidated", { reason: "prompt-changed" })`.
- `tier-history.jsonl` is preserved (it is a record of what happened, not
  forward-looking).
- `tier-config.json` is preserved.

### 8. Orchestrator integration points (`src/core/orchestrator.ts`)

- Constructor takes `AgentProvider` instead of `Agent`.
- Add private state:
  ```ts
  private currentTier: string;
  private nextTier: string;
  private tierHistory: { iteration: number; tier: string; source: string }[];
  private inputTokensByTier: Record<string, number> = {};
  private outputTokensByTier: Record<string, number> = {};
  private billableInputTokens = 0;   // sum across non-local tiers (incl. classifier if non-local)
  private billableOutputTokens = 0;  // see §8 budget-check rule
  ```
- Before the `while (!this.stopRequested)` loop, if a classifier is configured,
  run the upfront classification call. Result populates `this.nextTier` for
  iteration 1 and (router mode) stashes the plan.
- Inside the loop, before `runIteration`:
  - `this.currentTier = this.nextTier`
  - `const agent = this.provider.getAgentFor(this.currentTier)`
  - Append a `tierHistory` entry with the chosen source.
- After a successful iteration: read `output.next_iteration_tier`, validate
  against the configured tier set, set `this.nextTier`. If validation fails,
  fall back to `defaultTier` and log via `appendDebugLog`.
- On failure / commit-failure / agent-error: see §3 failure overrides.
- Token accounting: tag the `onUsage` callback delta with the active tier so
  per-tier totals accumulate. When the active tier is `local: true`, add to
  `inputTokensByTier`/`outputTokensByTier` and to the global
  `totalInputTokens`/`totalOutputTokens` for display, but **do not** add to
  `billableInputTokens`/`billableOutputTokens`.
- `--max-tokens` budget check uses `billableInputTokens +
  billableOutputTokens`, **not** the global total. Update
  `getTokenAbortReason` to use the billable sum. The abort message stays
  understandable (e.g. `"max tokens reached (12345/10000 billable)"`).
- Classifier-tier billability follows `tieredModels.tiers[routerTier].local`.
  In practice the router tier is the strong online model, so classifier
  tokens are billable; but if a user wires up a local router, those tokens
  also stop counting. Same rule as any other tier.
- Treat `--max-tokens` as the global sum across non-local tiers, same as
  today modulo the local-exclusion rule. (Confirmed open question #3.)
  `--max-tokens-per-tier` is a deliberate follow-up.

### 9. Renderer and exit summary

Out of scope for MVP. Guard against breakage:

- The renderer is constructed with `config.agent` (the top-level spec). It
  should keep displaying that spec, not the per-iteration tier name, so the
  header does not flicker. Optionally add a single read-only `tier:` line that
  reflects `orchestrator.getState().currentTier` when
  `tieredModels.enabled === true`; this is a small, safe addition.
- Confirm the renderer does not assume `agent.name` is stable across
  iterations; today it caches the spec, which is fine.
- Exit summary (`src/core/exit-summary.ts`) is unchanged in MVP. Per-tier token
  breakdown can land in a follow-up that consumes `inputTokensByTier` /
  `outputTokensByTier`.

### 10. Agent-specific support matrix

| Agent     | Tiered routing in MVP?                                           |
|-----------|------------------------------------------------------------------|
| claude    | Yes — spawn-per-iteration, splice tier args                      |
| codex     | Yes                                                              |
| copilot   | Yes                                                              |
| pi        | Yes                                                              |
| rovodev   | Whole-agent swap only; no args-only tiering or per-tier managed server |
| opencode  | Whole-agent swap only; no args-only tiering or per-tier managed server |
| acp       | Whole-agent swap only — tier can set `agent: acp:<target>` and use its own session |

Enforce at config-load time: if `tieredModels.enabled` is true and the top-level
`agent` is `rovodev`/`opencode`/`acp:*`, only allow tiers that swap the agent
via `tier.agent` (not tier-args-only). Emit a clear error otherwise pointing
the user at the matrix.

### 11. Telemetry (`src/core/telemetry.ts`)

Stay inside the existing one-`pageview`-and-one-`track`-per-run discipline.
Add these fields to the end-of-run `track("run", ...)` payload, all anonymous
and non-identifying:

- `tiered_models_enabled: boolean`
- `classifier_mode: "off"|"agent-self"|"router"|"router+self"|undefined`
- `tier_iteration_counts: Record<string, number>` (e.g. `{ complex: 3, simple: 12 }`)
- `tier_input_tokens: Record<string, number>`
- `tier_output_tokens: Record<string, number>`
- `local_tiers: string[]` (names of tiers that had `local: true` set)
- `billable_input_tokens: number` (sum across non-local tiers)
- `billable_output_tokens: number`

No per-iteration events. No tier names that could identify a user (tier names
are user-chosen but already anonymous — they will be strings like `complex`,
`simple`, or possibly model names like `opus`; treat them as anonymous strings,
same as the existing `agent` field).

### 12. Testing strategy

Follow project conventions: unit tests next to source as `*.test.ts`, e2e tests
under `e2e/` driving the built `dist/cli.mjs`.

Unit tests:

- Tier-resolution function: config + tier name → resolved `(AgentSpec,
  agentArgs)`. Cover precedence: `tier.agent` beats `tier.args`; tier args
  splice after top-level `agentArgsOverride`; `acpRegistryOverrides` merge with
  tier values winning on key conflict.
- Classifier-output validation: invalid `next_iteration_tier` falls back to
  `defaultTier`; missing field falls back to `defaultTier`.
- "Failed iteration forces defaultTier" branch and the other failure overrides
  in §3.
- `buildAgentOutputSchema` with `tierField` set: schema includes
  `next_iteration_tier` in both `properties` and `required`.
- `isReservedAgentArg` with `tieredModelsEnabled` toggle: `--model` rejected at
  top-level when enabled, accepted inside `TierDef.args`.
- Resume re-reads `tier-config.json` and ignores live config changes.
- `tier-history.jsonl` append format.

E2E tests (extend `e2e/`):

- Drive a `claude`-spec run with `tieredModels.enabled` and a stub binary at
  `agentPathOverride.claude` that:
  1. Asserts `--model` rotates per iteration based on a scripted
     `next_iteration_tier` sequence.
  2. Emits the expected `assistant`/`result` JSONL events.
- Router mode: stub the upfront classifier response, verify each iteration
  receives the planned model, verify `tier-plan.json` is written.
- Resume mid-run: kill after iteration 2, restart, verify the next spawned
  binary receives the tier from the *frozen* `tier-config.json`, not the live
  config (mutate the live config between kill and resume to prove this).
- `--tier <name>` pins for the whole run; `--no-classifier` falls back to
  `defaultTier`.

Keep the e2e mock pattern from existing tests (`e2e/fixtures/`).

### 13. Tier resolution rules (single source of truth)

Centralize tier resolution in one helper so the orchestrator, factory, and
validator all agree. Pseudocode:

```ts
interface ResolvedTier {
  agent: AgentSpec;              // top-level if tier.agent is unset, else tier.agent
  agentPath?: string;            // top-level agentPathOverride[resolved.agent] if native
  agentArgs: string[];           // top-level args (minus dedup) ++ tier.args[resolved.agent]
  acpRegistryOverrides: Record<string, string>;
}

function resolveTier(config, tierName): ResolvedTier {
  const tier = config.tieredModels.tiers[tierName];
  const agent = tier.agent ?? config.agent;
  const native = getNativeAgentName(agent);
  const topArgs = native ? (config.agentArgsOverride[native] ?? []) : [];
  const tierArgs = native ? (tier.args?.[native] ?? []) : [];
  const dedupedTop = dropModelClassFlags(topArgs, tierArgs); // see §6
  return {
    agent,
    agentPath: native ? config.agentPathOverride[native] : undefined,
    agentArgs: [...dedupedTop, ...tierArgs],
    acpRegistryOverrides: {
      ...(config.acpRegistryOverrides ?? {}),
      ...(tier.acpRegistryOverrides ?? {}),  // tier wins on key conflict
    },
  };
}
```

Key precedence rules:
- `tier.agent` wins over top-level `config.agent` (including a `--agent` CLI
  override — see below).
- Top-level `agentPathOverride[effectiveAgent]` and
  `agentArgsOverride[effectiveAgent]` always apply, regardless of whether the
  effective agent matches the top-level one. So a tier that swaps `claude →
  codex` automatically picks up `agentPathOverride.codex` if set.
- `--agent <name>` CLI flag overrides `config.agent` but does **not** override
  per-tier `tier.agent` swaps. The CLI flag changes the fallback agent for
  tiers that do not set `agent`, not the agent for tiers that do.

### 14. Roll-out phases

Ship in three reviewable commits:

1. **Infra**. `AgentProvider` refactor, schema additions, config types,
   per-run metadata files, validation, reserved-arg conditional, tests.
   `tieredModels.enabled: false` is the default; provider always vends today's
   single agent. Zero behavior change for existing users.
2. **Self-classification**. Schema field, prompt template change, orchestrator
   next-tier wiring, upfront one-shot classifier for iteration 1, telemetry,
   tier-history.jsonl. Ship `agent-self` as the recommended default mode.
3. **Router + combined**. Add router mode, `tier-plan.json` persistence,
   `router+self` combined mode. Renderer per-tier breakdown can ride along or
   land separately.

### 15. Validation rules

Enforce at config load (and on `tier-config.json` read on resume):

- `tieredModels.enabled` is a boolean. Missing field → `false`.
- When `enabled: true`:
  - `tiers` is a non-empty object. Empty → `InvalidConfigError`.
  - Tier names match `^[a-zA-Z][a-zA-Z0-9_-]*$`. They get embedded in JSON
    schema enums and YAML keys, and shown in prompts; keep them ASCII-safe.
  - `defaultTier` is required and must be a key of `tiers`.
  - `classifier.mode` is one of `off | agent-self | router | router+self`.
    Missing → `agent-self`.
  - `classifier.routerTier` is required when `mode` is `router` or
    `router+self`, and must be a key of `tiers`. Ignored when
    `mode in (off, agent-self)`.
  - Each `TierDef.agent`, if present, must satisfy `isAgentSpec`.
  - Each `TierDef.args[name]` must match the **tier's effective agent** (see
    §6). Model-class flags are allowed inside tier args; other gnhf-managed
    flags are still rejected.
  - `TierDef.acpRegistryOverrides` is accepted and persisted on any tier. At
    agent construction time it is merged into the ACP registry override map;
    it only affects tiers that resolve to an `acp:` spec.
  - `TierDef.description` is optional. If absent, the iteration prompt uses
    the tier name alone, which is less informative for the agent.
  - `TierDef.local` is optional; default `false`. Setting it on a tier whose
    effective agent is a known hosted service (e.g. `claude`, `codex`,
    `copilot`) is not auto-rejected — users may proxy through a local
    gateway. A later token-budget phase should emit a debug-log line at run
    start noting the tier is marked local so it is auditable.
- Top-level constraints:
  - When `enabled: true` and the top-level `agent` is `rovodev` /
    `opencode` / `acp:*`, every configured tier must set `tier.agent` (i.e.
    whole-agent swap only — see §10 matrix). Tier-args-only is rejected with
    an error pointing to the agent-support matrix.
  - When `enabled: true` and the top-level `agentArgsOverride[name]` contains
    a model-class flag for any native agent, reject with a message pointing
    to `tieredModels.tiers.<name>.args` as the migration path.

**Degenerate cases:**

- Exactly one tier configured: planned behavior is to force classifier mode to
  `off` regardless of the configured value and log via
  `appendDebugLog("classifier:auto-off", { reason: "single-tier" })`. Phase 1
  does not yet run the classifier or add the `next_iteration_tier` field.
- `--tier <name>` CLI flag pins for the run: classifier mode is treated as
  `off` for this invocation. Schema does not include `next_iteration_tier`.
- `--no-classifier` CLI flag: same effect as `mode: off` for this invocation.

### 16. Edge cases worth calling out

- **Mock mode** (`--mock` in `cli.ts`). The mock path constructs
  `MockOrchestrator` directly and skips config loading. Tiered models do not
  apply in mock mode in MVP. If the renderer is changed to display
  `currentTier`, ensure `MockOrchestrator.getState()` returns a stable
  placeholder (e.g. `"default"`) so the renderer does not crash.
- **Iteration logs**. Per-iteration JSONL log paths
  (`.gnhf/runs/<id>/iteration-N.jsonl`) are unchanged — they stay
  per-iteration, not per-tier. Each agent the provider vends writes to the
  same `logPath` because only one is active at a time. No log file
  restructuring is required.
- **Renderer cache of `agent.name`**. Renderer is constructed with
  `config.agent` (the top-level spec). It should not derive the displayed
  name from `provider.getAgentFor(currentTier).name`, because that would
  flicker across iterations when tiers swap agents. Keep the displayed name
  as the spec and add the tier line only.
- **Cost-floor for short runs**. The upfront classifier call costs one
  strong-tier LLM call. For very short runs (e.g. one-iteration prompts),
  the classifier can cost more than it saves. Document in user-facing docs
  that `--tier simple` or `--no-classifier` is appropriate when the user
  already knows the work is trivial.
- **`should_fully_stop` + tier field**. When `stop-when` is set and
  classifier mode includes self, both `should_fully_stop` and
  `next_iteration_tier` are appended to the schema. Verify
  `buildAgentOutputSchema` handles both options together in a unit test.
- **Local tier with no usable token counts.** Some local-model setups (e.g.
  certain ACP adapters) report only estimated token counts. The local-tier
  exclusion runs *before* the estimated-flag handling — a tier marked
  `local: true` skips the billable counters regardless of whether the
  underlying usage is exact or estimated. The existing `state.tokensEstimated`
  sticky flag still flips on if a local tier reports estimated usage, which
  keeps the renderer's `~` prefix honest.
- **Logging redaction**. When a tier swaps to `acp:custom-cmd` (raw command,
  not a named target), `redactAgentSpecForLogs` must redact it to
  `acp:custom`. The existing helper already does this, but call
  `redactAgentSpecForLogs` on every tier's resolved agent before writing to
  the debug log or telemetry. Add a single test asserting this.

### 17. Confirmed open questions

1. **Iteration 1 tier** — picked by the classifier (router plan slot 0, or a
   one-shot upfront call for `agent-self`). No forced strong-tier default.
2. **`TierDef.acpRegistryOverrides`** — supported. Merged with top-level
   `acpRegistryOverrides`, tier wins on key conflict.
3. **`--max-tokens` scope** — global. `--max-tokens-per-tier` is a deliberate
   follow-up if usage shows a need.

### 18. Out of scope (explicit non-goals for MVP)

- Per-tier `--max-tokens` budget (the `local: true` exclusion is the only
  per-tier budget shaping in MVP; finer-grained per-tier caps wait for
  evidence of need).
- Renderer per-tier token breakdown.
- Per-tier `rovodev`/`opencode` managed servers.
- Automatic tier discovery (e.g. "infer Opus from Claude Pro plan").
- Cost estimation in `$` (token counts only).
- Cross-run learning (e.g. "this prompt slug usually only needs `simple`").
