import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  PermanentAgentError,
  type Agent,
  type AgentOutput,
  type TokenUsage,
} from "./agents/types.js";
import type { AgentProvider } from "./agents/factory.js";
import { runUpfrontClassifier, runRouterClassifier } from "./agents/classifier.js";
import { redactAgentSpecForLogs, type Config } from "./config.js";
import type { RunInfo, TierHistorySource, TierPlan } from "./run.js";
import { appendNotes, appendTierHistory, toStringArray, writeTierPlan, readTierPlan } from "./run.js";
import {
  CLASSIFIER_TIER_NAME,
  classifierUsesRouter,
  classifierUsesSelf,
  getTierNames,
  isLocalTier,
  type TieredModelsConfig,
} from "./tiered-models.js";
import { appendDebugLog, serializeError } from "./debug-log.js";
import {
  CommitFailedError,
  commitAll,
  getBranchCommitCount,
  getCurrentBranch,
  getHeadCommit,
  pushCurrentBranch,
  resetHard,
} from "./git.js";
import {
  getInterruptDisposition,
  getInterruptHint,
  type InterruptDisposition,
  type InterruptHint,
} from "./interrupt-state.js";
import { buildCommitMessage } from "./commit-message.js";
import { buildIterationPrompt } from "../templates/iteration-prompt.js";

export interface IterationRecord {
  number: number;
  success: boolean;
  summary: string;
  keyChanges: string[];
  keyLearnings: string[];
  timestamp: Date;
}

export type { InterruptDisposition, InterruptHint } from "./interrupt-state.js";

export interface OrchestratorState {
  status: "running" | "waiting" | "aborted" | "stopped";
  gracefulStopRequested: boolean;
  interruptHint: InterruptHint;
  currentIteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  // Sticky flag: true when at least one iteration's usage was reported as
  // estimated (e.g. an ACP adapter that doesn't emit usage_update). Once set,
  // it stays set for the rest of the run so totals are presented honestly.
  tokensEstimated: boolean;
  commitCount: number;
  iterations: IterationRecord[];
  successCount: number;
  failCount: number;
  consecutiveFailures: number;
  consecutiveErrors: number;
  startTime: Date;
  waitingUntil: Date | null;
  lastMessage: string | null;
  lastAgentError?: string | null;
  hasPendingCommitFailure?: boolean;
  currentTier: string;
  inputTokensByTier: Record<string, number>;
  outputTokensByTier: Record<string, number>;
  billableInputTokens: number;
  billableOutputTokens: number;
  tierIterationCounts: Record<string, number>;
}

export interface OrchestratorEvents {
  state: [OrchestratorState];
  "iteration:start": [number];
  "iteration:end": [IterationRecord];
  abort: [string];
  stopped: [];
}

export interface RunLimits {
  maxIterations?: number;
  maxTokens?: number;
  stopWhen?: string;
  push?: boolean;
  // CLI --tier <name>: pin every iteration to this tier and skip the
  // upfront classifier. Validated against the configured tier set before
  // construction.
  pinTier?: string;
  // CLI --no-classifier: force classifier mode off for this invocation.
  disableClassifier?: boolean;
}

const STOP_CLOSE_AGENT_GRACE_MS = 250;

type RunIterationResult =
  | {
      type: "completed";
      record: IterationRecord;
      shouldFullyStop: boolean;
      abortReason?: string;
    }
  | { type: "stopped" }
  | { type: "aborted"; reason: string };

function isAgentProvider(value: Agent | AgentProvider): value is AgentProvider {
  return (
    typeof (value as AgentProvider).getAgentFor === "function" &&
    typeof (value as AgentProvider).defaultTier === "string"
  );
}

function wrapAgentAsProvider(agent: Agent): AgentProvider {
  return {
    defaultTier: "default",
    tiers: ["default"],
    tieredModels: undefined,
    getAgentFor: () => agent,
    // Pass through the agent's close directly so microtask timing matches
    // the original (Agent-only) shutdown path — adding an extra async layer
    // here perturbs tests that flush an exact number of microtasks between
    // close resolution and the "stopped" event.
    close: agent.close ? agent.close.bind(agent) : () => undefined,
  };
}

function tierEnabled(
  tieredModels: TieredModelsConfig | undefined,
): tieredModels is TieredModelsConfig {
  return tieredModels !== undefined && tieredModels.enabled === true;
}

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private config: Config;
  private provider: AgentProvider;
  private runInfo: RunInfo;
  private cwd: string;
  private prompt: string;
  private limits: RunLimits;
  private stopRequested = false;
  private stopPromise: Promise<void> | null = null;
  private activeIterationPromise: Promise<RunIterationResult> | null = null;
  private activeAbortController: AbortController | null = null;
  private pendingAbortReason: string | null = null;
  private pendingCommitFailure: string | null = null;
  private activeIterationTokensEstimated = false;
  private loopDone = false;
  private stoppedEventEmitted = false;
  private nextTier: string;
  private nextTierSource: TierHistorySource;
  private classifierAttempted = false;
  private tierPlan: TierPlan | null = null;

  private state: Omit<
    OrchestratorState,
    "interruptHint" | "hasPendingCommitFailure"
  > = {
    status: "running",
    gracefulStopRequested: false,
    currentIteration: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    tokensEstimated: false,
    commitCount: 0,
    iterations: [],
    successCount: 0,
    failCount: 0,
    consecutiveFailures: 0,
    consecutiveErrors: 0,
    startTime: new Date(),
    waitingUntil: null,
    lastMessage: null,
    lastAgentError: null,
    currentTier: "default",
    inputTokensByTier: {},
    outputTokensByTier: {},
    billableInputTokens: 0,
    billableOutputTokens: 0,
    tierIterationCounts: {},
  };

  constructor(
    config: Config,
    agentOrProvider: Agent | AgentProvider,
    runInfo: RunInfo,
    prompt: string,
    cwd: string,
    startIteration = 0,
    limits: RunLimits = {},
  ) {
    super();
    this.config = config;
    this.provider = isAgentProvider(agentOrProvider)
      ? agentOrProvider
      : wrapAgentAsProvider(agentOrProvider);
    this.runInfo = runInfo;
    this.prompt = prompt;
    this.cwd = cwd;
    this.limits = limits;
    this.state.currentIteration = startIteration;
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );

    const defaultTier = this.provider.defaultTier;
    this.state.currentTier = defaultTier;

    if (this.limits.pinTier !== undefined) {
      this.nextTier = this.limits.pinTier;
      this.nextTierSource = "override";
      // Skip the upfront classifier — pinTier covers iteration 1 already.
      this.classifierAttempted = true;
    } else {
      this.nextTier = defaultTier;
      this.nextTierSource = "default";
    }

    // Load persisted tier plan on resume
    if (startIteration > 0 && this.routerActive()) {
      const plan = readTierPlan(this.runInfo.tierPlanPath);
      if (plan) {
        this.tierPlan = {
          tiers: plan.tiers,
          plan: plan.plan,
          rationale: plan.rationale,
          consumed: plan.consumed,
        };
        appendDebugLog("tier:plan-resumed", {
          consumed: plan.consumed,
          remaining: plan.tiers.length - plan.consumed,
        });
      }
    }
  }

  private getActiveAgent(): Agent {
    return this.provider.getAgentFor(this.state.currentTier);
  }

  getState(): OrchestratorState {
    return {
      ...this.state,
      tokensEstimated:
        this.state.tokensEstimated || this.activeIterationTokensEstimated,
      interruptHint: getInterruptHint(this.state),
      hasPendingCommitFailure: this.pendingCommitFailure !== null,
    };
  }

  requestGracefulStop(): void {
    if (
      this.stopRequested ||
      this.state.gracefulStopRequested ||
      this.loopDone
    ) {
      return;
    }

    this.state.gracefulStopRequested = true;
    appendDebugLog("orchestrator:graceful-stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      status: this.state.status,
    });
    this.emit("state", this.getState());

    if (this.state.status === "waiting") {
      this.activeAbortController?.abort();
    }
  }

  handleInterrupt(): InterruptDisposition {
    const disposition = getInterruptDisposition(this.state);
    if (disposition === "request-graceful-stop") {
      this.requestGracefulStop();
    } else if (disposition === "force-stop") {
      this.stop();
    }
    return disposition;
  }

  stop(): void {
    this.stopRequested = true;
    appendDebugLog("orchestrator:stop-requested", {
      iteration: this.state.currentIteration,
      hasActiveIteration: this.activeIterationPromise !== null,
      loopDone: this.loopDone,
    });
    this.activeAbortController?.abort();
    this.state.gracefulStopRequested = false;

    if (this.loopDone) {
      this.emitStopped();
      return;
    }

    if (this.stopPromise) return;

    this.stopPromise = (async () => {
      if (this.activeIterationPromise) {
        const iterationPromise = this.activeIterationPromise.catch(
          () => undefined,
        );
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(settle, STOP_CLOSE_AGENT_GRACE_MS);
          timer.unref?.();
          void iterationPromise.finally(settle);
        });
        await this.closeAgent();
        await iterationPromise;
      } else {
        await this.closeAgent();
      }
      resetHard(this.cwd);
      this.pendingCommitFailure = null;
      this.state.status = "stopped";
      this.emit("state", this.getState());
      this.emitStopped();
    })();
  }

  async start(): Promise<void> {
    this.state.startTime = new Date();
    this.state.status = "running";
    // Preserve a pre-start graceful-stop request. ctrl+c can land after the
    // renderer starts listening but before the orchestrator loop begins.
    this.emit("state", this.getState());

    appendDebugLog("orchestrator:start", {
      agent: redactAgentSpecForLogs(this.getActiveAgent().name),
      runId: this.runInfo.runId,
      startIteration: this.state.currentIteration,
      maxIterations: this.limits.maxIterations,
      maxTokens: this.limits.maxTokens,
      push: this.limits.push === true,
      maxConsecutiveFailures: this.config.maxConsecutiveFailures,
      baseCommit: this.runInfo.baseCommit,
      initialCommitCount: this.state.commitCount,
      tieredModelsEnabled: this.tieredModelsActive(),
      classifierMode: this.runInfo.tieredModels?.classifier.mode,
      pinTier: this.limits.pinTier,
      disableClassifier: this.limits.disableClassifier === true,
      defaultTier: this.provider.defaultTier,
    });

    try {
      if (this.shouldRunUpfrontClassifier()) {
        await this.runUpfrontClassifierIfNeeded();
      }

      while (!this.stopRequested) {
        const preIterationAbortReason = this.getPreIterationAbortReason();
        if (preIterationAbortReason) {
          this.abort(preIterationAbortReason);
          break;
        }
        if (this.stopForGracefulShutdown()) {
          break;
        }

        this.state.currentIteration++;
        this.applyNextTierForIteration();
        this.state.status = "running";
        this.emit("iteration:start", this.state.currentIteration);
        this.emit("state", this.getState());

        const tierSelection = this.buildTierSelectionInfo();
        const baseIterationPrompt = buildIterationPrompt({
          n: this.state.currentIteration,
          runId: this.runInfo.runId,
          prompt: this.prompt,
          stopWhen: this.limits.stopWhen,
          commitMessage: this.config.commitMessage,
          ...(tierSelection === undefined ? {} : { tierSelection }),
        });
        const iterationPrompt = this.pendingCommitFailure
          ? this.buildCommitRepairPrompt(baseIterationPrompt)
          : baseIterationPrompt;

        appendDebugLog("iteration:start", {
          iteration: this.state.currentIteration,
          promptLength: iterationPrompt.length,
          consecutiveFailures: this.state.consecutiveFailures,
          totalInputTokens: this.state.totalInputTokens,
          totalOutputTokens: this.state.totalOutputTokens,
          git: this.snapshotGitState(),
        });

        const iterationStartedAt = Date.now();
        this.activeIterationPromise = this.runIteration(iterationPrompt);
        const result = await this.activeIterationPromise;
        this.activeIterationPromise = null;
        const iterationElapsedMs = Date.now() - iterationStartedAt;

        if (result.type === "stopped") {
          appendDebugLog("iteration:stopped", {
            iteration: this.state.currentIteration,
            elapsedMs: iterationElapsedMs,
          });
          break;
        }
        if (result.type === "aborted") {
          appendDebugLog("iteration:aborted", {
            iteration: this.state.currentIteration,
            elapsedMs: iterationElapsedMs,
            reason: result.reason,
          });
          this.abort(result.reason);
          break;
        }

        const { record } = result;
        this.state.iterations.push(record);
        this.emit("iteration:end", record);
        this.emit("state", this.getState());

        appendDebugLog("iteration:end", {
          iteration: record.number,
          elapsedMs: iterationElapsedMs,
          success: record.success,
          summary: record.summary,
          keyChanges: record.keyChanges.length,
          keyLearnings: record.keyLearnings.length,
          consecutiveFailures: this.state.consecutiveFailures,
          totalInputTokens: this.state.totalInputTokens,
          totalOutputTokens: this.state.totalOutputTokens,
          tokensEstimated: this.state.tokensEstimated,
          commitCount: this.state.commitCount,
        });

        if (result.abortReason) {
          this.abort(result.abortReason);
          break;
        }

        if (this.stopForGracefulShutdown()) {
          break;
        }

        if (this.limits.stopWhen !== undefined && result.shouldFullyStop) {
          this.abort("stop condition met");
          break;
        }

        const postIterationAbortReason = this.getPostIterationAbortReason();
        if (postIterationAbortReason) {
          this.abort(postIterationAbortReason);
          break;
        }

        if (
          this.state.consecutiveFailures >= this.config.maxConsecutiveFailures
        ) {
          this.abort(
            `${this.config.maxConsecutiveFailures} consecutive failures`,
          );
          break;
        }

        if (this.state.consecutiveErrors > 0 && !this.stopRequested) {
          const backoffMs =
            60_000 * Math.pow(2, this.state.consecutiveErrors - 1);
          this.state.status = "waiting";
          this.state.waitingUntil = new Date(Date.now() + backoffMs);
          this.emit("state", this.getState());

          appendDebugLog("backoff:start", {
            iteration: this.state.currentIteration,
            consecutiveErrors: this.state.consecutiveErrors,
            backoffMs,
          });

          await this.interruptibleSleep(backoffMs);

          appendDebugLog("backoff:end", {
            iteration: this.state.currentIteration,
            stopRequested: this.stopRequested,
          });

          this.state.waitingUntil = null;
          if (!this.stopRequested) {
            if (this.stopForGracefulShutdown()) {
              break;
            }
            this.state.status = "running";
            this.emit("state", this.getState());
          }
        }
      }
    } catch (err) {
      appendDebugLog("orchestrator:loop-error", {
        iteration: this.state.currentIteration,
        error: serializeError(err),
      });
      throw err;
    } finally {
      this.activeIterationPromise = null;
      if (this.stopPromise) {
        await this.stopPromise;
      } else {
        await this.closeAgent();
      }
      this.loopDone = true;
      if (this.didStopWithoutForce()) {
        this.emitStopped();
      }
      appendDebugLog("orchestrator:end", {
        status: this.state.status,
        iterations: this.state.currentIteration,
        successCount: this.state.successCount,
        failCount: this.state.failCount,
        totalInputTokens: this.state.totalInputTokens,
        totalOutputTokens: this.state.totalOutputTokens,
        commitCount: this.state.commitCount,
      });
    }
  }

  private async runIteration(prompt: string): Promise<RunIterationResult> {
    const baseInputTokens = this.state.totalInputTokens;
    const baseOutputTokens = this.state.totalOutputTokens;
    const tierForIteration = this.state.currentTier;
    const tierInputBaseline =
      this.state.inputTokensByTier[tierForIteration] ?? 0;
    const tierOutputBaseline =
      this.state.outputTokensByTier[tierForIteration] ?? 0;
    const billableInputBaseline = this.state.billableInputTokens;
    const billableOutputBaseline = this.state.billableOutputTokens;
    const isLocal = isLocalTier(this.runInfo.tieredModels, tierForIteration);

    this.activeAbortController = new AbortController();
    this.pendingAbortReason = null;
    this.activeIterationTokensEstimated = false;

    const onUsage = (usage: TokenUsage) => {
      this.state.totalInputTokens = baseInputTokens + usage.inputTokens;
      this.state.totalOutputTokens = baseOutputTokens + usage.outputTokens;
      this.state.inputTokensByTier[tierForIteration] =
        tierInputBaseline + usage.inputTokens;
      this.state.outputTokensByTier[tierForIteration] =
        tierOutputBaseline + usage.outputTokens;
      if (!isLocal) {
        this.state.billableInputTokens =
          billableInputBaseline + usage.inputTokens;
        this.state.billableOutputTokens =
          billableOutputBaseline + usage.outputTokens;
      }
      this.activeIterationTokensEstimated = usage.estimated === true;
      this.emit("state", this.getState());

      const reason = this.getTokenAbortReason();
      if (
        reason &&
        this.activeAbortController &&
        !this.activeAbortController.signal.aborted
      ) {
        this.pendingAbortReason = reason;
        this.activeAbortController.abort();
      }
    };

    const onMessage = (text: string) => {
      this.state.lastMessage = text;
      this.emit("state", this.getState());
    };

    const logPath = join(
      this.runInfo.runDir,
      `iteration-${this.state.currentIteration}.jsonl`,
    );

    const agent = this.getActiveAgent();
    const agentStartedAt = Date.now();
    appendDebugLog("agent:run:start", {
      iteration: this.state.currentIteration,
      agent: redactAgentSpecForLogs(agent.name),
      logPath,
    });

    try {
      const result = await agent.run(prompt, this.cwd, {
        onUsage,
        onMessage,
        signal: this.activeAbortController.signal,
        logPath,
      });

      this.activeIterationTokensEstimated = false;
      if (result.usage.estimated) this.state.tokensEstimated = true;

      appendDebugLog("agent:run:end", {
        iteration: this.state.currentIteration,
        elapsedMs: Date.now() - agentStartedAt,
        success: result.output.success,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheCreationTokens: result.usage.cacheCreationTokens,
        estimated: result.usage.estimated ?? false,
      });

      if (this.stopRequested) {
        return { type: "stopped" };
      }

      const shouldFullyStop = result.output.should_fully_stop === true;

      if (result.output.success) {
        const record = this.recordSuccess(result.output);
        if (record.success) {
          this.adoptNextTierFromOutput(result.output);
        } else {
          // recordSuccess returns success=false only on commit failure;
          // restart the next iteration on the safe default tier so the
          // repair pass has full capability.
          this.setNextTier(this.provider.defaultTier, "commit-repair");
        }
        const abortReason =
          record.success && this.limits.push === true
            ? this.pushAfterSuccess()
            : undefined;
        return {
          type: "completed",
          record,
          shouldFullyStop: record.success ? shouldFullyStop : false,
          ...(abortReason === undefined ? {} : { abortReason }),
        };
      }
      this.setNextTier(this.provider.defaultTier, "failure-fallback");
      return {
        type: "completed",
        record: this.recordFailure(
          `[FAIL] ${result.output.summary}`,
          result.output.summary,
          toStringArray(result.output.key_learnings),
          "reported",
        ),
        shouldFullyStop,
      };
    } catch (err) {
      const elapsedMs = Date.now() - agentStartedAt;
      if (this.activeIterationTokensEstimated) {
        this.state.tokensEstimated = true;
        this.activeIterationTokensEstimated = false;
      }

      if (
        this.pendingAbortReason &&
        err instanceof Error &&
        err.message === "Agent was aborted"
      ) {
        appendDebugLog("agent:run:aborted", {
          iteration: this.state.currentIteration,
          elapsedMs,
          reason: this.pendingAbortReason,
        });
        if (this.pendingCommitFailure === null) {
          resetHard(this.cwd);
        }
        return { type: "aborted", reason: this.pendingAbortReason };
      }

      if (this.stopRequested) {
        appendDebugLog("agent:run:stopped", {
          iteration: this.state.currentIteration,
          elapsedMs,
        });
        return { type: "stopped" };
      }

      // This is where diagnostics most often matter — particularly for
      // `TypeError: fetch failed`, where the surface message is useless
      // without the undici cause chain. Always serialize the full error
      // before we collapse it to a string for the notes file.
      appendDebugLog("agent:run:error", {
        iteration: this.state.currentIteration,
        elapsedMs,
        error: serializeError(err),
      });

      if (err instanceof PermanentAgentError) {
        if (this.pendingCommitFailure === null) {
          resetHard(this.cwd);
        }
        this.state.lastAgentError = err.detail;
        return { type: "aborted", reason: err.message };
      }

      const summary = err instanceof Error ? err.message : String(err);
      this.setNextTier(this.provider.defaultTier, "agent-error");
      return {
        type: "completed",
        record: this.recordFailure(`[ERROR] ${summary}`, summary, [], "error"),
        shouldFullyStop: false,
      };
    } finally {
      this.activeAbortController = null;
      this.pendingAbortReason = null;
    }
  }

  private recordSuccess(output: AgentOutput): IterationRecord {
    const keyChanges = toStringArray(output.key_changes_made);
    const keyLearnings = toStringArray(output.key_learnings);
    try {
      commitAll(
        buildCommitMessage(this.config.commitMessage, output, {
          iteration: this.state.currentIteration,
        }),
        this.cwd,
      );
    } catch (error) {
      if (error instanceof CommitFailedError) {
        return this.recordCommitFailure(error);
      }
      throw error;
    }

    this.pendingCommitFailure = null;
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      output.summary,
      keyChanges,
      keyLearnings,
    );
    this.state.commitCount = getBranchCommitCount(
      this.runInfo.baseCommit,
      this.cwd,
    );
    this.state.successCount++;
    this.state.consecutiveFailures = 0;
    this.state.consecutiveErrors = 0;
    this.state.lastAgentError = null;
    return {
      number: this.state.currentIteration,
      success: true,
      summary: output.summary,
      keyChanges,
      keyLearnings,
      timestamp: new Date(),
    };
  }

  private buildCommitRepairPrompt(basePrompt: string): string {
    return `${basePrompt}

## Previous Commit Failure

The previous iteration made workspace changes, but gnhf could not commit them because git commit failed.
Do not start unrelated work.
Inspect and fix the existing uncommitted changes so the commit can pass, then report success.

Git commit output:

\`\`\`
${this.pendingCommitFailure}
\`\`\``;
  }

  private recordCommitFailure(error: CommitFailedError): IterationRecord {
    this.pendingCommitFailure = error.detail;
    const summary = "git commit failed; asking agent to repair the workspace";
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      `[ERROR] ${summary}`,
      [],
      [error.detail],
    );
    this.state.failCount++;
    this.state.consecutiveFailures++;
    this.state.consecutiveErrors = 0;
    this.state.lastAgentError = error.detail;
    return {
      number: this.state.currentIteration,
      success: false,
      summary,
      keyChanges: [],
      keyLearnings: [error.detail],
      timestamp: new Date(),
    };
  }

  private pushAfterSuccess(): string | undefined {
    try {
      pushCurrentBranch(this.cwd);
      appendDebugLog("git:push:success", {
        iteration: this.state.currentIteration,
      });
      return undefined;
    } catch (err) {
      appendDebugLog("git:push:error", {
        iteration: this.state.currentIteration,
        error: serializeError(err),
      });
      const message = err instanceof Error ? err.message : String(err);
      return `push failed: ${message}`;
    }
  }

  private recordFailure(
    notesSummary: string,
    recordSummary: string,
    learnings: string[],
    kind: "reported" | "error",
  ): IterationRecord {
    const hadPendingCommitFailure = this.pendingCommitFailure !== null;
    appendNotes(
      this.runInfo.notesPath,
      this.state.currentIteration,
      notesSummary,
      [],
      toStringArray(learnings),
    );
    if (!hadPendingCommitFailure) {
      resetHard(this.cwd);
    }
    this.state.failCount++;
    this.state.consecutiveFailures++;
    // Only hard errors (agent threw) escalate the backoff streak. Explicit
    // agent-reported failures indicate the loop is healthy - the agent tried
    // and concluded it couldn't succeed - so we move straight to the next
    // iteration.
    if (kind === "error") {
      this.state.consecutiveErrors++;
      this.state.lastAgentError = recordSummary;
    } else {
      this.state.consecutiveErrors = 0;
      this.state.lastAgentError = null;
    }
    return {
      number: this.state.currentIteration,
      success: false,
      summary: recordSummary,
      keyChanges: [],
      keyLearnings: toStringArray(learnings),
      timestamp: new Date(),
    };
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.activeAbortController = new AbortController();
      const timer = setTimeout(() => {
        this.activeAbortController = null;
        resolve();
      }, ms);

      this.activeAbortController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        this.activeAbortController = null;
        resolve();
      });
    });
  }

  private getPreIterationAbortReason(): string | null {
    if (
      this.limits.maxIterations !== undefined &&
      this.state.currentIteration >= this.limits.maxIterations
    ) {
      return `max iterations reached (${this.limits.maxIterations})`;
    }

    return this.getTokenAbortReason();
  }

  private getPostIterationAbortReason(): string | null {
    if (
      this.limits.maxIterations !== undefined &&
      this.state.currentIteration >= this.limits.maxIterations
    ) {
      return `max iterations reached (${this.limits.maxIterations})`;
    }

    return this.getTokenAbortReason();
  }

  private getTokenAbortReason(): string | null {
    if (this.limits.maxTokens === undefined) return null;

    if (this.tieredModelsActive()) {
      const billable =
        this.state.billableInputTokens + this.state.billableOutputTokens;
      if (billable < this.limits.maxTokens) return null;
      return `max tokens reached (${billable}/${this.limits.maxTokens} billable)`;
    }

    const totalTokens =
      this.state.totalInputTokens + this.state.totalOutputTokens;
    if (totalTokens < this.limits.maxTokens) return null;
    return `max tokens reached (${totalTokens}/${this.limits.maxTokens})`;
  }

  private finishGracefulStop(): void {
    this.state.status = "stopped";
    this.state.gracefulStopRequested = false;
    this.state.waitingUntil = null;
    appendDebugLog("orchestrator:graceful-stop-complete", {
      iteration: this.state.currentIteration,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    this.emit("state", this.getState());
  }

  private stopForGracefulShutdown(): boolean {
    if (!this.state.gracefulStopRequested) {
      return false;
    }
    this.finishGracefulStop();
    return true;
  }

  private didStopWithoutForce(): boolean {
    return this.stopPromise === null && this.state.status === "stopped";
  }

  private abort(reason: string): void {
    this.state.status = "aborted";
    this.state.gracefulStopRequested = false;
    this.state.lastMessage = reason;
    this.state.waitingUntil = null;
    appendDebugLog("orchestrator:abort", {
      reason,
      iteration: this.state.currentIteration,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    this.emit("abort", reason);
    this.emit("state", this.getState());
  }

  private async closeAgent(): Promise<void> {
    try {
      await this.provider.close();
    } catch (err) {
      appendDebugLog("agent:close:error", {
        error: serializeError(err),
      });
      // Best-effort cleanup only.
    }
  }

  private emitStopped(): void {
    if (this.stoppedEventEmitted) {
      return;
    }
    this.stoppedEventEmitted = true;
    this.emit("stopped");
  }

  private tieredModelsActive(): boolean {
    return tierEnabled(this.runInfo.tieredModels);
  }

  private classifierActive(): boolean {
    if (!this.tieredModelsActive()) return false;
    if (this.limits.disableClassifier === true) return false;
    if (this.limits.pinTier !== undefined) return false;
    return classifierUsesSelf(this.runInfo.tieredModels!.classifier.mode);
  }

  private routerActive(): boolean {
    if (!this.tieredModelsActive()) return false;
    if (this.limits.disableClassifier === true) return false;
    if (this.limits.pinTier !== undefined) return false;
    return classifierUsesRouter(this.runInfo.tieredModels!.classifier.mode);
  }

  private buildTierSelectionInfo():
    | {
        fieldName: string;
        defaultTier: string;
        tiers: { name: string; description?: string }[];
      }
    | undefined {
    if (!this.classifierActive()) return undefined;
    const tieredModels = this.runInfo.tieredModels!;
    return {
      fieldName: "next_iteration_tier",
      defaultTier: tieredModels.defaultTier,
      tiers: getTierNames(tieredModels).map((name) => {
        const tier = tieredModels.tiers[name];
        return tier?.description === undefined
          ? { name }
          : { name, description: tier.description };
      }),
    };
  }

  private setNextTier(tier: string, source: TierHistorySource): void {
    this.nextTier = this.validateTierName(tier)
      ? tier
      : this.provider.defaultTier;
    this.nextTierSource = this.validateTierName(tier)
      ? source
      : "failure-fallback";
    if (!this.validateTierName(tier)) {
      appendDebugLog("tier:invalid-next", {
        iteration: this.state.currentIteration,
        requested: tier,
        fallback: this.provider.defaultTier,
      });
    }
  }

  private validateTierName(tier: string): boolean {
    if (!this.tieredModelsActive()) return tier === this.provider.defaultTier;
    return tier in this.runInfo.tieredModels!.tiers;
  }

  private adoptNextTierFromOutput(output: AgentOutput): void {
    if (!this.classifierActive()) {
      this.setNextTier(this.provider.defaultTier, "default");
      return;
    }
    const requested = (output as unknown as Record<string, unknown>)
      .next_iteration_tier;
    if (typeof requested !== "string" || requested.trim() === "") {
      appendDebugLog("tier:missing-next", {
        iteration: this.state.currentIteration,
        fallback: this.provider.defaultTier,
      });
      this.setNextTier(this.provider.defaultTier, "failure-fallback");
      return;
    }
    this.setNextTier(requested, "self");
  }

  private applyNextTierForIteration(): void {
    if (this.limits.pinTier !== undefined) {
      this.state.currentTier = this.limits.pinTier;
      this.recordTierHistory("override");
      return;
    }

    // Router plan consumption
    if (
      this.tierPlan !== null &&
      this.tierPlan.consumed < this.tierPlan.tiers.length
    ) {
      // In router+self mode, the previous iteration's self-classification
      // (stored in nextTier with source "self") overrides this plan slot.
      if (this.classifierActive() && this.nextTierSource === "self") {
        this.state.currentTier = this.nextTier;
        this.recordTierHistory("self");
      } else {
        this.state.currentTier =
          this.tierPlan.tiers[this.tierPlan.consumed];
        this.recordTierHistory("router");
      }
      this.tierPlan.consumed++;
      // Persist updated consumed count so resume picks up correctly
      writeTierPlan(this.runInfo.tierPlanPath, this.tierPlan);
      return;
    }

    // Plan exhausted (or no plan): use the existing nextTier path
    this.state.currentTier = this.nextTier;
    this.recordTierHistory(this.nextTierSource);
    // Reset for the next iteration; the iteration outcome overwrites this.
    this.nextTier = this.provider.defaultTier;
    this.nextTierSource = "default";
  }

  private recordTierHistory(source: TierHistorySource): void {
    const tier = this.state.currentTier;
    this.state.tierIterationCounts[tier] =
      (this.state.tierIterationCounts[tier] ?? 0) + 1;
    if (!this.tieredModelsActive()) return;
    try {
      appendTierHistory(this.runInfo.tierHistoryPath, {
        iteration: this.state.currentIteration,
        tier,
        source,
      });
    } catch (err) {
      appendDebugLog("tier:history-write-error", {
        iteration: this.state.currentIteration,
        error: serializeError(err),
      });
    }
  }

  private shouldRunUpfrontClassifier(): boolean {
    if (this.classifierAttempted) return false;
    if (!this.classifierActive() && !this.routerActive()) return false;
    if (this.state.currentIteration > 0) return false;
    return true;
  }

  private async runUpfrontClassifierIfNeeded(): Promise<void> {
    if (this.classifierAttempted) return;
    this.classifierAttempted = true;

    if (!this.classifierActive() && !this.routerActive()) return;
    if (this.state.currentIteration > 0) return;

    const tieredModels = this.runInfo.tieredModels!;
    const classifierTier =
      tieredModels.classifier.routerTier ?? tieredModels.defaultTier;
    if (!(classifierTier in tieredModels.tiers)) {
      appendDebugLog("classifier:fallback", {
        reason: "router-tier-missing",
        requested: classifierTier,
        fallback: tieredModels.defaultTier,
      });
      this.setNextTier(tieredModels.defaultTier, "default");
      return;
    }

    const tiers = getTierNames(tieredModels).map((name) => {
      const tier = tieredModels.tiers[name];
      return tier?.description === undefined
        ? { name }
        : { name, description: tier.description };
    });

    const classifierLocal = isLocalTier(tieredModels, classifierTier);
    const baseInputTokens = this.state.totalInputTokens;
    const baseOutputTokens = this.state.totalOutputTokens;
    const billableInputBaseline = this.state.billableInputTokens;
    const billableOutputBaseline = this.state.billableOutputTokens;
    const classifierInputBaseline =
      this.state.inputTokensByTier[CLASSIFIER_TIER_NAME] ?? 0;
    const classifierOutputBaseline =
      this.state.outputTokensByTier[CLASSIFIER_TIER_NAME] ?? 0;

    const onUsage = (usage: TokenUsage) => {
      this.state.totalInputTokens = baseInputTokens + usage.inputTokens;
      this.state.totalOutputTokens = baseOutputTokens + usage.outputTokens;
      this.state.inputTokensByTier[CLASSIFIER_TIER_NAME] =
        classifierInputBaseline + usage.inputTokens;
      this.state.outputTokensByTier[CLASSIFIER_TIER_NAME] =
        classifierOutputBaseline + usage.outputTokens;
      if (!classifierLocal) {
        this.state.billableInputTokens =
          billableInputBaseline + usage.inputTokens;
        this.state.billableOutputTokens =
          billableOutputBaseline + usage.outputTokens;
      }
      if (usage.estimated) this.state.tokensEstimated = true;
      this.emit("state", this.getState());
    };

    const controller = new AbortController();
    const previousController = this.activeAbortController;
    this.activeAbortController = controller;

    appendDebugLog("classifier:start", {
      tier: classifierTier,
      local: classifierLocal,
    });
    const startedAt = Date.now();
    try {
      const agent = this.provider.getAgentFor(classifierTier);
      const classifierLogPath = join(this.runInfo.runDir, "classifier.jsonl");

      if (this.routerActive()) {
        // ====== ROUTER / ROUTER+SELF PATH ======
        const result = await runRouterClassifier({
          agent,
          objective: this.prompt,
          cwd: this.cwd,
          defaultTier: tieredModels.defaultTier,
          tiers,
          signal: controller.signal,
          onUsage,
          logPath: classifierLogPath,
        });

        // Validate each tier name
        const invalidTier = result.tiers.find(
          (t) => !this.validateTierName(t),
        );
        if (invalidTier) {
          appendDebugLog("classifier:fallback", {
            reason: "invalid-tier-in-plan",
            invalidTier,
            elapsedMs: Date.now() - startedAt,
          });
          this.setNextTier(tieredModels.defaultTier, "default");
          return;
        }

        // Persist plan and set first tier
        const plan: TierPlan = {
          tiers: result.tiers,
          plan: result.plan,
          rationale: result.rationale,
          consumed: 0,
        };
        this.tierPlan = { ...plan, consumed: 0 };
        writeTierPlan(this.runInfo.tierPlanPath, plan);

        this.nextTier = result.tiers[0];
        this.nextTierSource = "router";

        appendDebugLog("classifier:router-plan", {
          elapsedMs: Date.now() - startedAt,
          tiers: result.tiers,
          planLength: result.plan.length,
        });
      } else {
        // ====== AGENT-SELF PATH (existing) ======
        const result = await runUpfrontClassifier({
          agent,
          objective: this.prompt,
          cwd: this.cwd,
          defaultTier: tieredModels.defaultTier,
          tiers,
          fieldName: "next_iteration_tier",
          signal: controller.signal,
          onUsage,
          logPath: classifierLogPath,
        });
        if (this.validateTierName(result.tier)) {
          this.nextTier = result.tier;
          this.nextTierSource = "classifier";
          appendDebugLog("classifier:end", {
            elapsedMs: Date.now() - startedAt,
            tier: result.tier,
          });
        } else {
          appendDebugLog("classifier:fallback", {
            reason: "tier-not-configured",
            requested: result.tier,
            fallback: tieredModels.defaultTier,
            elapsedMs: Date.now() - startedAt,
          });
          this.setNextTier(tieredModels.defaultTier, "default");
        }
      }
    } catch (err) {
      appendDebugLog("classifier:fallback", {
        reason: "classifier-error",
        error: serializeError(err),
        elapsedMs: Date.now() - startedAt,
      });
      this.setNextTier(tieredModels.defaultTier, "default");
    } finally {
      this.activeAbortController = previousController;
    }
  }

  private snapshotGitState(): Record<string, unknown> {
    // Cheap diagnostic snapshot — catches "previous iteration's reset
    // didn't land" and "we're on the wrong branch" bugs that otherwise
    // look identical to real agent failures.
    try {
      return {
        head: getHeadCommit(this.cwd),
        branch: getCurrentBranch(this.cwd),
        commitCount: this.state.commitCount,
      };
    } catch (err) {
      return {
        error: serializeError(err),
      };
    }
  }
}
