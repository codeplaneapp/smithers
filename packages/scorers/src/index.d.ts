import * as _smithers_orchestrator_agents_AgentLike from '@smithers-orchestrator/agents/AgentLike';
import { AgentLike as AgentLike$4 } from '@smithers-orchestrator/agents/AgentLike';
import { ZodObject } from 'zod';
export { smithersScorers } from '@smithers-orchestrator/db/internal-schema';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import * as effect from 'effect';
export { scorerDuration, scorersFailed, scorersFinished, scorersStarted } from '@smithers-orchestrator/observability/metrics';

/**
 * How a planning node's probe judgment was classified by
 * `pocJudgmentScorer`.
 *
 * - `correctPositiveChanged` — flagged a risk, and the probe finding changed
 *   the plan (a replan or self-invalidation followed the finding).
 * - `correctPositiveConfirmed` — flagged a risk that proved real: either the
 *   probe finding was folded in and the node reaffirmed, or the flagged risk
 *   materialized in execution.
 * - `correctNegative` — flagged nothing, and nothing in its domain was later
 *   invalidated, redelegated, or gate-failed.
 * - `falsePositive` — flagged a risk, but the probe found nothing (or the
 *   finding had no downstream effect).
 * - `falseNegative` — flagged nothing, but its node was later invalidated,
 *   redelegated, or failed a gate. Punished hardest.
 */
type PocJudgmentClassification$1 = "correctPositiveChanged" | "correctPositiveConfirmed" | "correctNegative" | "falsePositive" | "falseNegative";
/** Options for `pocJudgmentScorer`. */
type PocJudgmentOptions$2 = {
    /**
     * Per-classification score contribution in [0, 1]. Defaults reward
     * plan-changing findings hardest (1.0) and false negatives not at all (0).
     */
    values?: Partial<Record<PocJudgmentClassification$1, number>>;
    /**
     * Per-classification weight for the weighted mean over planning nodes.
     * Defaults weight `falseNegative` highest so missed risks dominate.
     */
    weights?: Partial<Record<PocJudgmentClassification$1, number>>;
};

/** Options for `planSolidityScorer`. */
type PlanSolidityOptions$2 = {
    /**
     * Penalty subtracted from 1.0 for each churn event that occurs after the
     * first `EXEC_STARTED` event. Plan-phase churn (before execution starts) is
     * free — that is the process working. Defaults:
     * `NODE_INVALIDATED` 0.10, `REDELEGATED` 0.08, `GATE_FAILED` 0.05,
     * `REPLAN_REQUESTED` 0.04.
     */
    penalties?: Partial<Record<"NODE_INVALIDATED" | "REDELEGATED" | "GATE_FAILED" | "REPLAN_REQUESTED", number>>;
};

/**
 * USD price for one model, per MILLION tokens. The invoice of record is the
 * provider's; this table drives spend estimates, dashboards, and the
 * per-session runaway brake.
 */
type ModelPrice$2 = {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
};

/** The result returned by every scorer function. */
type ScoreResult$3 = {
    /** Normalized quality score between 0 and 1. */
    score: number;
    /** Optional human-readable explanation of the score. */
    reason?: string;
    /** Arbitrary metadata for downstream consumption. */
    meta?: Record<string, unknown>;
};
/** The input passed to a scorer function when evaluating a task. */
type ScorerInput$2 = {
    /** The original task input or prompt. */
    input: unknown;
    /** The task's produced output. */
    output: unknown;
    /** Expected output for comparison (optional). */
    groundTruth?: unknown;
    /** Additional context such as retrieved documents (optional). */
    context?: unknown;
    /** How long the task took in milliseconds (optional). */
    latencyMs?: number;
    /** The Zod schema the output should match (optional). */
    outputSchema?: ZodObject;
};
/** An async function that evaluates a scorer input and returns a score result. */
type ScorerFn$1 = (input: ScorerInput$2) => Promise<ScoreResult$3>;
/** A named, self-describing scorer. */
type Scorer$d = {
    /** Unique identifier for the scorer. */
    id: string;
    /** Human-readable name. */
    name: string;
    /** Description of what this scorer evaluates. */
    description: string;
    /** The scoring function. */
    score: ScorerFn$1;
};
/** Controls how often a scorer runs. */
type SamplingConfig$1 = {
    type: "all";
} | {
    type: "ratio";
    rate: number;
} | {
    type: "none";
};
/** Binds a scorer to a task with optional sampling configuration. */
type ScorerBinding$1 = {
    scorer: Scorer$d;
    sampling?: SamplingConfig$1;
};
/** A named map of scorer bindings attached to a task. */
type ScorersMap$2 = Record<string, ScorerBinding$1>;
/** A full row in the _smithers_scorers table. */
type ScoreRow$1 = {
    id: string;
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    scorerId: string;
    scorerName: string;
    source: "live" | "batch";
    score: number;
    reason: string | null;
    metaJson: string | null;
    inputJson: string | null;
    outputJson: string | null;
    groundTruthJson: string | null;
    contextJson: string | null;
    latencyMs: number | null;
    scoredAtMs: number;
    durationMs: number | null;
};
/** Aggregated statistics for a scorer across multiple runs. */
type AggregateScore$2 = {
    scorerId: string;
    scorerName: string;
    count: number;
    mean: number;
    min: number;
    max: number;
    p50: number;
    stddev: number;
};
/** Context provided to the scorer execution engine. */
type ScorerContext$2 = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    input: unknown;
    output: unknown;
    groundTruth?: unknown;
    context?: unknown;
    latencyMs?: number;
    outputSchema?: ZodObject;
};

type LlmJudgeConfig$2 = {
    id: string;
    name: string;
    description: string;
    /** An agent that will act as the judge. */
    judge: AgentLike$4;
    /** System-level instructions for the judge agent. */
    instructions: string;
    /**
     * Build the prompt sent to the judge from the scorer input.
     * The prompt should instruct the judge to respond with JSON: `{ "score": <0-1>, "reason": "<text>" }`.
     */
    promptTemplate: (input: ScorerInput$2) => string;
};

/** The component keys `delegationRunScore` combines. */
type DelegationRunComponent$1 = "pocJudgment" | "planSolidity" | "estimateAccuracy" | "tierFit" | "humanPoll";
/**
 * The per-component results fed to `delegationRunScore`. A component may be
 * absent, `null` (e.g. sampled out or failed in `runScorersBatch`), or a
 * `ScoreResult` with `meta.skipped` — all three are excluded from the
 * weighted total and the remaining weights are renormalized.
 */
type DelegationRunResults$2 = Partial<Record<DelegationRunComponent$1, ScoreResult$3 | null | undefined>>;
/** Options for `delegationRunScore`. */
type DelegationRunScoreOptions$2 = {
    /**
     * Component weights. Defaults: pocJudgment 0.25, planSolidity 0.25,
     * estimateAccuracy 0.15, tierFit 0.15, humanPoll 0.2.
     */
    weights?: Partial<Record<DelegationRunComponent$1, number>>;
};

/**
 * A single delegation event emitted by a delegation-chain run.
 *
 * The delegation-chain workflow records the life of its plan graph as a flat
 * event log (`RISK_FLAGGED`, `PROBE_SPAWNED`, `FINDING_REPORTED`,
 * `NODE_INVALIDATED`, `EXEC_STARTED`, ...). The delegation scorers fold this
 * log deterministically; only the fields relevant to scoring are typed here
 * and every field except the tag is optional so partial logs still score.
 */
type DelegationEvent$1 = {
    /** Event tag, e.g. "RISK_FLAGGED", "EXEC_STARTED", "NODE_INVALIDATED". */
    t: string;
    /** Node the event applies to (RISK_FLAGGED, NODE_INVALIDATED, GATE_FAILED, ...). */
    node?: string;
    /** Parent node for PROBE_SPAWNED and CHILDREN_DECLARED. */
    parent?: string;
    /** Node that requested a replan (REPLAN_REQUESTED). */
    from?: string;
    /** Probe node that produced a finding (FINDING_REPORTED). */
    probe?: string;
    /** Planning node a probe finding is reported to (FINDING_REPORTED). */
    toParent?: string;
    /** Declared children (CHILDREN_DECLARED); used to learn node kinds. */
    children?: {
        id: string;
        kind?: string;
    }[];
    [key: string]: unknown;
};
/**
 * A payload the delegation scorers can read events (and optionally node
 * metadata) from. Scorers accept either a bare `DelegationEvent[]` or this
 * object shape in the scored output or context.
 */
type DelegationEventsPayload$2 = {
    /** The run's delegation event log, in emission order. */
    events: DelegationEvent$1[];
    /** Optional node metadata; `kind` decides which nodes are planning nodes. */
    nodes?: {
        id: string;
        kind?: string;
    }[];
    [key: string]: unknown;
};

/**
 * A delegation node's predicted (or measured) resource envelope. Plan nodes
 * forecast one per child; exec rows report what actually happened. All
 * dimensions are optional — accuracy is judged only on dimensions present on
 * both sides.
 */
type DelegationEstimate$1 = {
    /** Total tokens (input + output). */
    tokens?: number;
    /** Dollar cost. */
    costUsd?: number;
    /** Wall-clock minutes. */
    minutes?: number;
};
/**
 * The shape `estimateAccuracyScorer` reads plan forecasts from: a dcPlan-like
 * row whose `children[].estimate` carries the per-child prediction. Replans
 * re-forecast, so later rows supersede earlier ones for the same child.
 * `subtreeEstimate` is a derived rollup and is not scored directly.
 */
type DelegationPlanRowLike$1 = {
    logicalId?: string;
    children?: {
        logicalId?: string;
        id?: string;
        estimate?: DelegationEstimate$1;
    }[];
    subtreeEstimate?: DelegationEstimate$1;
    [key: string]: unknown;
};
/** A dcExec-like row carrying the measured actuals for one node. */
type DelegationExecRowLike$1 = {
    logicalId?: string;
    id?: string;
    actual?: DelegationEstimate$1;
    [key: string]: unknown;
};
/**
 * The payload `estimateAccuracyScorer` accepts in the scored output or
 * context: plan rows under `plan` (or `plans`) and exec rows under `exec`
 * (or `execs`).
 */
type DelegationEstimatePayload$1 = {
    plan?: DelegationPlanRowLike$1[];
    plans?: DelegationPlanRowLike$1[];
    exec?: DelegationExecRowLike$1[];
    execs?: DelegationExecRowLike$1[];
    [key: string]: unknown;
};

type CreateScorerConfig$2 = {
    id: string;
    name: string;
    description: string;
    score: ScorerFn$1;
};

type AggregateOptions$2 = {
    /** Filter to a specific run. */
    runId?: string;
    /** Filter to a specific node. */
    nodeId?: string;
    /** Filter to a specific scorer. */
    scorerId?: string;
};

/** @typedef {import("./CreateScorerConfig.js").CreateScorerConfig} CreateScorerConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a scorer from a plain configuration object.
 *
 * ```ts
 * const myScorer = createScorer({
 *   id: "word-count",
 *   name: "Word Count",
 *   description: "Scores based on word count",
 *   score: async ({ output }) => ({
 *     score: Math.min(String(output).split(/\s+/).length / 200, 1),
 *   }),
 * });
 * ```
 *
 * @param {CreateScorerConfig} config
 * @returns {Scorer}
 */
declare function createScorer(config: CreateScorerConfig$1): Scorer$c;
type CreateScorerConfig$1 = CreateScorerConfig$2;
type Scorer$c = Scorer$d;

/**
 * Creates an LLM-as-judge scorer that delegates evaluation to an AI agent.
 *
 * The judge agent receives a prompt constructed from `promptTemplate` and is
 * expected to return a JSON object with `score` (0-1) and optional `reason`.
 *
 * ```ts
 * const toneScorer = llmJudge({
 *   id: "tone",
 *   name: "Professional Tone",
 *   description: "Evaluates professional tone",
 *   judge: new AnthropicAgent({ model: "claude-fable-5" }),
 *   instructions: "You evaluate text for professional tone.",
 *   promptTemplate: ({ output }) =>
 *     `Rate the professionalism of this text (0-1 JSON):\n\n${String(output)}`,
 * });
 * ```
 *
 * @param {LlmJudgeConfig} config
 * @returns {Scorer}
 */
declare function llmJudge(config: LlmJudgeConfig$1): Scorer$b;
type LlmJudgeConfig$1 = LlmJudgeConfig$2;
type Scorer$b = Scorer$d;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a relevancy scorer that uses an LLM judge to evaluate whether
 * the output is relevant to the input.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function relevancyScorer(judge: AgentLike$3): Scorer$a;
type AgentLike$3 = _smithers_orchestrator_agents_AgentLike.AgentLike;
type Scorer$a = Scorer$d;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a toxicity scorer that uses an LLM judge to detect toxic,
 * harmful, or inappropriate content in the output.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function toxicityScorer(judge: AgentLike$2): Scorer$9;
type AgentLike$2 = _smithers_orchestrator_agents_AgentLike.AgentLike;
type Scorer$9 = Scorer$d;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a faithfulness scorer that uses an LLM judge to check whether
 * the output is faithful to the provided context (no hallucinations).
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function faithfulnessScorer(judge: AgentLike$1): Scorer$8;
type AgentLike$1 = _smithers_orchestrator_agents_AgentLike.AgentLike;
type Scorer$8 = Scorer$d;

/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a schema adherence scorer that validates the output against
 * the task's Zod schema. Returns 1.0 if valid, 0.0 if invalid.
 *
 * @returns {Scorer}
 */
declare function schemaAdherenceScorer(): Scorer$7;
type Scorer$7 = Scorer$d;

/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a latency scorer that scores based on execution time.
 * Returns 1.0 at or below `targetMs`, linearly decreasing to 0.0 at `maxMs`.
 *
 * @param {{ targetMs: number; maxMs: number }} opts
 * @returns {Scorer}
 */
declare function latencyScorer(opts: {
    targetMs: number;
    maxMs: number;
}): Scorer$6;
type Scorer$6 = Scorer$d;

/**
 * Creates the delegation-chain POC-judgment scorer.
 *
 * For each planning node (goal/chunk) in a delegation event log, classifies
 * its risk judgment into one of five outcomes (see
 * `PocJudgmentClassification`) and returns the weighted mean of the
 * per-classification values. Findings that CHANGED the plan reward hardest;
 * unflagged risks that later broke the node (false negatives) are punished
 * hardest via both a zero value and the highest weight.
 *
 * The event log is read from the scored `output` (preferred) or `context`,
 * as either a bare `DelegationEvent[]` or a `{ events, nodes? }` payload.
 * With no events or no planning nodes the scorer no-ops (score 1,
 * `meta.skipped`).
 *
 * @param {PocJudgmentOptions} [opts]
 * @returns {Scorer}
 */
declare function pocJudgmentScorer(opts?: PocJudgmentOptions$1): Scorer$5;
type PocJudgmentOptions$1 = PocJudgmentOptions$2;
type Scorer$5 = Scorer$d;

/**
 * Creates the delegation-chain plan-solidity scorer.
 *
 * Measures how solid the plan was once execution began. Churn during the
 * planning phase (before the first `EXEC_STARTED` event) is free — plan-phase
 * invalidations are the process working. Every churn event after execution
 * starts (`NODE_INVALIDATED`, `REDELEGATED`, `GATE_FAILED`,
 * `REPLAN_REQUESTED`) subtracts a configurable penalty from 1.0; the score is
 * clamped to [0, 1]. With the defaults, one post-exec invalidation plus one
 * redelegation scores 0.82 (the delegation-chain simulation's Frame 10).
 *
 * The event log is read from the scored `output` (preferred) or `context`.
 * With no events the scorer no-ops (score 1, `meta.skipped`); if execution
 * never started, all churn was plan-phase and the score is 1.
 *
 * @param {PlanSolidityOptions} [opts]
 * @returns {Scorer}
 */
declare function planSolidityScorer(opts?: PlanSolidityOptions$1): Scorer$4;
type PlanSolidityOptions$1 = PlanSolidityOptions$2;
type Scorer$4 = Scorer$d;

/**
 * Creates the delegation-chain estimate-accuracy scorer.
 *
 * Every delegation plan node predicts `{ tokens, costUsd, minutes }` for each
 * child; exec rows report the actuals. For each node with both a latest
 * estimate and actuals, accuracy is the symmetric ratio
 * `min(predicted, actual) / max(predicted, actual)` per dimension, averaged
 * over the dimensions present on both sides (1.0 = perfect forecast). The
 * run-level score is the mean over nodes weighted by predicted `costUsd`
 * (falling back to weight 1 when a node has no positive cost prediction), so
 * misforecasting big nodes matters more.
 *
 * Replans re-forecast, so the LATEST estimate per node wins (plan rows are
 * read in order; later `children[].estimate` entries supersede earlier ones,
 * as do later `actual`s). Plan rows' `subtreeEstimate` rollups are derived
 * and not scored. Rows are read from the scored `output` (preferred) or
 * `context` as a `{ plan|plans, exec|execs }` payload; nodes missing either
 * side are skipped, and with nothing to score the scorer no-ops (score 1,
 * `meta.skipped`).
 *
 * @returns {Scorer}
 */
declare function estimateAccuracyScorer(): Scorer$3;
type Scorer$3 = Scorer$d;

/**
 * Creates the delegation-chain tier-fit scorer, an LLM judge that evaluates
 * whether a node's intelligence tier (fable/opus/sonnet/haiku) matched its
 * work. Over-tiering wastes cost on routine work; under-tiering risks quality
 * on hard work.
 *
 * The node descriptor (`{ tier, brief, stats? }`) is read from the scored
 * `input` (preferred) or `context`; the node's produced output is the scored
 * `output`. `stats` may carry cost/context figures (e.g. `costUsd`, token
 * counts) and is passed to the judge verbatim when present.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function tierFitScorer(judge: AgentLike): Scorer$2;
type AgentLike = _smithers_orchestrator_agents_AgentLike.AgentLike;
type Scorer$2 = Scorer$d;

/**
 * Creates the delegation-chain human-poll scorer.
 *
 * Consumes a submitted end-of-run user poll — an array of
 * `{ question, answer }` entries where answers are 1-5 ratings and/or
 * booleans — and normalizes it to a mean score in [0, 1]. The poll is read
 * from the scored `output` (preferred) or `context`, as either a bare array
 * or a `{ poll: [...] }` payload. With no poll (or no recognizable answers)
 * the scorer no-ops (score 1, `meta.skipped`).
 *
 * @returns {Scorer}
 */
declare function humanPollScorer(): Scorer$1;
type Scorer$1 = Scorer$d;

/**
 * Look up the per-million-token price for a model id. Matches the base id plus
 * any `-`/`_` date-stamp suffix or a bracketed context-window alias like
 * `claude-opus-4-8[1m]`, so a real model is never metered as free. Unknown ids
 * return the all-zero price.
 *
 * Sonnet 5's published introductory rate ends on September 1, 2026; encoding
 * the transition here prevents a deployment that survives that date from
 * silently under-metering new requests.
 *
 * @param {string} model
 * @param {number} [atMs]
 * @returns {ModelPrice}
 */
declare function modelTokenPrices(model: string, atMs?: number): ModelPrice$1;
type ModelPrice$1 = ModelPrice$2;

/**
 * Price a token forecast into dollars. The `<Estimate>` component authors token
 * counts per task; this turns them into `costUsd` deterministically so the
 * model never has to reason about prices. Prices are per MILLION tokens.
 *
 * When only a single `tokens` total is known (no input/output split), it is
 * priced at the blended midpoint of input and output rates — a token forecast
 * this coarse cannot know its own read/write mix, and the midpoint keeps a
 * cheap model's estimate from swinging 5x on that unknown. The same 50/50
 * assumption determines whether a coarse GPT-5.6 forecast crosses the 272K
 * long-context input threshold.
 *
 * @param {{ model: string, tokens?: number, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, pricingAtMs?: number }} usage
 * @returns {number} dollars
 */
declare function estimateCostUsd(usage: {
    model: string;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    pricingAtMs?: number;
}): number;

/**
 * Extracts a delegation event log from a scorer input.
 *
 * Accepts either a bare `DelegationEvent[]` or a `{ events, nodes? }` object
 * in the scored `output` (preferred) or `context`. Returns `null` when
 * neither carries events, so scorers can no-op per the package's skip
 * convention.
 *
 * @param {Pick<ScorerInput, "output" | "context">} input
 * @returns {DelegationEventsPayload | null}
 */
declare function extractDelegationEvents(input: Pick<ScorerInput$1, "output" | "context">): DelegationEventsPayload$1 | null;
/**
 * Resolves the set of planning-node ids a delegation log describes.
 *
 * When node metadata is available (payload `nodes`, or `children` carried by
 * `CHILDREN_DECLARED` events), only nodes whose `kind` is `goal` or `chunk`
 * qualify. Otherwise the set is derived from the events: every id referenced
 * as a planning actor (`RISK_FLAGGED.node`, `PROBE_SPAWNED.parent`,
 * `CHILDREN_DECLARED.parent`, `FINDING_REPORTED.toParent`,
 * `REPLAN_REQUESTED.from`, `GATES_DECLARED.node`, node lifecycle events)
 * minus known probe ids (`FINDING_REPORTED.probe`).
 *
 * @param {DelegationEventsPayload} payload
 * @returns {string[]}
 */
declare function resolvePlanningNodes(payload: DelegationEventsPayload$1): string[];
type DelegationEventsPayload$1 = DelegationEventsPayload$2;
type ScorerInput$1 = ScorerInput$2;

/**
 * Fire-and-forget scorer execution. Runs all scorers via Effect.runFork
 * so they never block the workflow. Used for live scoring during execution.
 *
 * @param {ScorersMap} scorers
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {EventBus | null} [eventBus]
 * @returns {void}
 */
declare function runScorersAsync(scorers: ScorersMap$1, ctx: ScorerContext$1, adapter: SmithersDb$1 | null, eventBus?: EventBus | null): void;
/**
 * Blocking scorer execution. Runs all scorers and waits for completion.
 * Returns a map of key -> ScoreResult. Used for batch/test evaluation.
 *
 * @param {ScorersMap} scorers
 * @param {ScorerContext} ctx
 * @param {SmithersDb | null} adapter
 * @param {EventBus | null} [eventBus]
 * @returns {Promise<Record<string, ScoreResult | null>>}
 */
declare function runScorersBatch(scorers: ScorersMap$1, ctx: ScorerContext$1, adapter: SmithersDb$1 | null, eventBus?: EventBus | null): Promise<Record<string, ScoreResult$2 | null>>;
type EventBus = {
    emit: (eventName: "event", event: unknown) => unknown;
    emitEventWithPersist?: (event: unknown) => effect.Effect.Effect<void, unknown>;
};
type ScoreResult$2 = ScoreResult$3;
type ScorerContext$1 = ScorerContext$2;
type ScorersMap$1 = ScorersMap$2;
type SmithersDb$1 = _smithers_orchestrator_db_adapter.SmithersDb;

/** @typedef {import("./AggregateOptions.js").AggregateOptions} AggregateOptions */
/** @typedef {import("./types.js").AggregateScore} AggregateScore */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunResults} DelegationRunResults */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunScoreOptions} DelegationRunScoreOptions */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
/**
 * Computes aggregate statistics for scorer results.
 *
 * Returns one row per scorer with count, mean, min, max, p50, and stddev.
 * Uses a simple SQL aggregation query plus in-memory p50 calculation,
 * since SQLite does not support PERCENTILE_CONT or correlated subqueries
 * in GROUP BY reliably.
 *
 * @param {SmithersDb} adapter
 * @param {AggregateOptions} [opts]
 * @returns {Promise<AggregateScore[]>}
 */
declare function aggregateScores(adapter: SmithersDb, opts?: AggregateOptions$1): Promise<AggregateScore$1[]>;
/**
 * Combines named `ScoreResult`s into one weighted score.
 *
 * Components that are missing, `null` (e.g. sampled out or failed in
 * `runScorersBatch`), or skipped (`meta.skipped`) are excluded and the
 * remaining weights renormalize, so a not-applicable component never dilutes
 * the total. When every component is excluded the combined result is itself
 * skipped (score 1, `meta.skipped`), matching the built-in scorers' no-op
 * convention.
 *
 * @param {Record<string, ScoreResult | null | undefined>} results
 * @param {Record<string, number>} weights
 * @returns {ScoreResult}
 */
declare function weightedScore(results: Record<string, ScoreResult$1 | null | undefined>, weights: Record<string, number>): ScoreResult$1;
/**
 * Combines the five delegation-chain scorer results into the run total shown
 * in the scores panel: `pocJudgmentScorer`, `planSolidityScorer`,
 * `estimateAccuracyScorer`, `tierFitScorer`, and `humanPollScorer`, weighted
 * 0.25 / 0.25 / 0.15 / 0.15 / 0.2 by default. Built on `weightedScore`, so
 * skipped or missing components (e.g. a poll the user never submitted) drop
 * out and the remaining weights renormalize.
 *
 * @param {DelegationRunResults} results
 * @param {DelegationRunScoreOptions} [opts]
 * @returns {ScoreResult}
 */
declare function delegationRunScore(results: DelegationRunResults$1, opts?: DelegationRunScoreOptions$1): ScoreResult$1;
type AggregateOptions$1 = AggregateOptions$2;
type AggregateScore$1 = AggregateScore$2;
type SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;
type DelegationRunResults$1 = DelegationRunResults$2;
type DelegationRunScoreOptions$1 = DelegationRunScoreOptions$2;
type ScoreResult$1 = ScoreResult$3;

type AggregateOptions = AggregateOptions$2;
type AggregateScore = AggregateScore$2;
type CreateScorerConfig = CreateScorerConfig$2;
type DelegationEstimate = DelegationEstimate$1;
type DelegationEstimatePayload = DelegationEstimatePayload$1;
type DelegationExecRowLike = DelegationExecRowLike$1;
type DelegationPlanRowLike = DelegationPlanRowLike$1;
type DelegationEvent = DelegationEvent$1;
type DelegationEventsPayload = DelegationEventsPayload$2;
type DelegationRunComponent = DelegationRunComponent$1;
type DelegationRunResults = DelegationRunResults$2;
type DelegationRunScoreOptions = DelegationRunScoreOptions$2;
type LlmJudgeConfig = LlmJudgeConfig$2;
type ModelPrice = ModelPrice$2;
type PlanSolidityOptions = PlanSolidityOptions$2;
type PocJudgmentClassification = PocJudgmentClassification$1;
type PocJudgmentOptions = PocJudgmentOptions$2;
type SamplingConfig = SamplingConfig$1;
type Scorer = Scorer$d;
type ScorerBinding = ScorerBinding$1;
type ScorerContext = ScorerContext$2;
type ScoreResult = ScoreResult$3;
type ScorerFn = ScorerFn$1;
type ScorerInput = ScorerInput$2;
type ScoreRow = ScoreRow$1;
type ScorersMap = ScorersMap$2;

export { type AggregateOptions, type AggregateScore, type CreateScorerConfig, type DelegationEstimate, type DelegationEstimatePayload, type DelegationEvent, type DelegationEventsPayload, type DelegationExecRowLike, type DelegationPlanRowLike, type DelegationRunComponent, type DelegationRunResults, type DelegationRunScoreOptions, type LlmJudgeConfig, type ModelPrice, type PlanSolidityOptions, type PocJudgmentClassification, type PocJudgmentOptions, type SamplingConfig, type ScoreResult, type ScoreRow, type Scorer, type ScorerBinding, type ScorerContext, type ScorerFn, type ScorerInput, type ScorersMap, aggregateScores, createScorer, delegationRunScore, estimateAccuracyScorer, estimateCostUsd, extractDelegationEvents, faithfulnessScorer, humanPollScorer, latencyScorer, llmJudge, modelTokenPrices, planSolidityScorer, pocJudgmentScorer, relevancyScorer, resolvePlanningNodes, runScorersAsync, runScorersBatch, schemaAdherenceScorer, tierFitScorer, toxicityScorer, weightedScore };
