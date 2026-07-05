import * as _smithers_agents_AgentLike from '@smithers-orchestrator/agents/AgentLike';
import { AgentLike as AgentLike$3 } from '@smithers-orchestrator/agents/AgentLike';
import { ZodObject } from 'zod';
import * as _smithers_db_adapter from '@smithers-orchestrator/db/adapter';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
import * as effect_MetricState from 'effect/MetricState';
import * as effect_MetricKeyType from 'effect/MetricKeyType';
import { Metric } from 'effect';

/** The result returned by every scorer function. */
type ScoreResult$2 = {
    /** Normalized quality score between 0 and 1. */
    score: number;
    /** Optional human-readable explanation of the score. */
    reason?: string;
    /** Arbitrary metadata for downstream consumption. */
    meta?: Record<string, unknown>;
};
/** The input passed to a scorer function when evaluating a task. */
type ScorerInput$1 = {
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
type ScorerFn$1 = (input: ScorerInput$1) => Promise<ScoreResult$2>;
/** A named, self-describing scorer. */
type Scorer$8 = {
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
    scorer: Scorer$8;
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
    judge: AgentLike$3;
    /** System-level instructions for the judge agent. */
    instructions: string;
    /**
     * Build the prompt sent to the judge from the scorer input.
     * The prompt should instruct the judge to respond with JSON: `{ "score": <0-1>, "reason": "<text>" }`.
     */
    promptTemplate: (input: ScorerInput$1) => string;
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

/** @typedef {import("./AggregateOptions.js").AggregateOptions} AggregateOptions */
/** @typedef {import("./types.js").AggregateScore} AggregateScore */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
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
declare function aggregateScores(adapter: SmithersDb$1, opts?: AggregateOptions$1): Promise<AggregateScore$1[]>;
type AggregateOptions$1 = AggregateOptions$2;
type AggregateScore$1 = AggregateScore$2;
type SmithersDb$1 = _smithers_db_adapter.SmithersDb;

/**
 * Drizzle table definition for the `_smithers_scorers` table.
 * Stores individual scorer results for each task execution.
 */
type SmithersScorerColumn<Name extends string, Data, NotNull extends boolean, HasDefault extends boolean, PrimaryKey extends boolean, ColumnType extends string, DataType extends "string" | "number"> = drizzle_orm_sqlite_core.SQLiteColumn<{
    name: Name;
    tableName: "_smithers_scorers";
    dataType: DataType;
    columnType: ColumnType;
    data: Data;
    driverParam: Data;
    notNull: NotNull;
    hasDefault: HasDefault;
    isPrimaryKey: PrimaryKey;
    isAutoincrement: false;
    hasRuntimeDefault: false;
    enumValues: DataType extends "string" ? [string, ...string[]] : undefined;
    baseColumn: never;
    identity: undefined;
    generated: undefined;
}, {}, {}>;
declare const smithersScorers: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_scorers";
    schema: undefined;
    columns: {
        id: SmithersScorerColumn<"id", string, true, false, true, "SQLiteText", "string">;
        runId: SmithersScorerColumn<"run_id", string, true, false, false, "SQLiteText", "string">;
        nodeId: SmithersScorerColumn<"node_id", string, true, false, false, "SQLiteText", "string">;
        iteration: SmithersScorerColumn<"iteration", number, true, true, false, "SQLiteInteger", "number">;
        attempt: SmithersScorerColumn<"attempt", number, true, true, false, "SQLiteInteger", "number">;
        scorerId: SmithersScorerColumn<"scorer_id", string, true, false, false, "SQLiteText", "string">;
        scorerName: SmithersScorerColumn<"scorer_name", string, true, false, false, "SQLiteText", "string">;
        source: SmithersScorerColumn<"source", string, true, false, false, "SQLiteText", "string">;
        score: SmithersScorerColumn<"score", number, true, false, false, "SQLiteReal", "number">;
        reason: SmithersScorerColumn<"reason", string, false, false, false, "SQLiteText", "string">;
        metaJson: SmithersScorerColumn<"meta_json", string, false, false, false, "SQLiteText", "string">;
        inputJson: SmithersScorerColumn<"input_json", string, false, false, false, "SQLiteText", "string">;
        outputJson: SmithersScorerColumn<"output_json", string, false, false, false, "SQLiteText", "string">;
        groundTruthJson: SmithersScorerColumn<"ground_truth_json", string, false, false, false, "SQLiteText", "string">;
        contextJson: SmithersScorerColumn<"context_json", string, false, false, false, "SQLiteText", "string">;
        latencyMs: SmithersScorerColumn<"latency_ms", number, false, false, false, "SQLiteReal", "number">;
        scoredAtMs: SmithersScorerColumn<"scored_at_ms", number, true, false, false, "SQLiteInteger", "number">;
        durationMs: SmithersScorerColumn<"duration_ms", number, false, false, false, "SQLiteReal", "number">;
    };
    dialect: "sqlite";
}>;

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
declare function createScorer(config: CreateScorerConfig$1): Scorer$7;
type CreateScorerConfig$1 = CreateScorerConfig$2;
type Scorer$7 = Scorer$8;

/** @typedef {import("./LlmJudgeConfig.js").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/** @typedef {import("./types.js").ScorerInput} ScorerInput */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
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
declare function llmJudge(config: LlmJudgeConfig$1): Scorer$6;
type LlmJudgeConfig$1 = LlmJudgeConfig$2;
type Scorer$6 = Scorer$8;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a relevancy scorer that uses an LLM judge to evaluate whether
 * the output is relevant to the input.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function relevancyScorer(judge: AgentLike$2): Scorer$5;
type AgentLike$2 = _smithers_agents_AgentLike.AgentLike;
type Scorer$5 = Scorer$8;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a toxicity scorer that uses an LLM judge to detect toxic,
 * harmful, or inappropriate content in the output.
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function toxicityScorer(judge: AgentLike$1): Scorer$4;
type AgentLike$1 = _smithers_agents_AgentLike.AgentLike;
type Scorer$4 = Scorer$8;

/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a faithfulness scorer that uses an LLM judge to check whether
 * the output is faithful to the provided context (no hallucinations).
 *
 * @param {AgentLike} judge
 * @returns {Scorer}
 */
declare function faithfulnessScorer(judge: AgentLike): Scorer$3;
type AgentLike = _smithers_agents_AgentLike.AgentLike;
type Scorer$3 = Scorer$8;

/** @typedef {import("./types.js").Scorer} Scorer */
/**
 * Creates a schema adherence scorer that validates the output against
 * the task's Zod schema. Returns 1.0 if valid, 0.0 if invalid.
 *
 * @returns {Scorer}
 */
declare function schemaAdherenceScorer(): Scorer$2;
type Scorer$2 = Scorer$8;

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
}): Scorer$1;
type Scorer$1 = Scorer$8;

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
declare function runScorersAsync(scorers: ScorersMap$1, ctx: ScorerContext$1, adapter: SmithersDb | null, eventBus?: EventBus | null): void;
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
declare function runScorersBatch(scorers: ScorersMap$1, ctx: ScorerContext$1, adapter: SmithersDb | null, eventBus?: EventBus | null): Promise<Record<string, ScoreResult$1 | null>>;
type EventBus = any;
type ScoreResult$1 = ScoreResult$2;
type ScorerContext$1 = ScorerContext$2;
type ScorersMap$1 = ScorersMap$2;
type SmithersDb = _smithers_db_adapter.SmithersDb;

declare const scorersStarted: Metric.Metric.Counter<number>;
declare const scorersFinished: Metric.Metric.Counter<number>;
declare const scorersFailed: Metric.Metric.Counter<number>;
declare const scorerDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

/**
 * A single delegation event emitted by a delegation-chain run.
 *
 * The delegation-chain workflow records the life of its plan graph as a flat
 * event log (`RISK_FLAGGED`, `PROBE_SPAWNED`, `FINDING_REPORTED`,
 * `NODE_INVALIDATED`, `EXEC_STARTED`, ...). The delegation scorers fold this
 * log deterministically; only the fields relevant to scoring are typed here
 * and every field except the tag is optional so partial logs still score.
 */
type DelegationEvent = {
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
type DelegationEventsPayload = {
    /** The run's delegation event log, in emission order. */
    events: DelegationEvent[];
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
type DelegationEstimate = {
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
type DelegationPlanRowLike = {
    logicalId?: string;
    children?: {
        logicalId?: string;
        id?: string;
        estimate?: DelegationEstimate;
    }[];
    subtreeEstimate?: DelegationEstimate;
    [key: string]: unknown;
};
/** A dcExec-like row carrying the measured actuals for one node. */
type DelegationExecRowLike = {
    logicalId?: string;
    id?: string;
    actual?: DelegationEstimate;
    [key: string]: unknown;
};
/**
 * The payload `estimateAccuracyScorer` accepts in the scored output or
 * context: plan rows under `plan` (or `plans`) and exec rows under `exec`
 * (or `execs`).
 */
type DelegationEstimatePayload = {
    plan?: DelegationPlanRowLike[];
    plans?: DelegationPlanRowLike[];
    exec?: DelegationExecRowLike[];
    execs?: DelegationExecRowLike[];
    [key: string]: unknown;
};

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
type PocJudgmentClassification = "correctPositiveChanged" | "correctPositiveConfirmed" | "correctNegative" | "falsePositive" | "falseNegative";
/** Options for `pocJudgmentScorer`. */
type PocJudgmentOptions = {
    /**
     * Per-classification score contribution in [0, 1]. Defaults reward
     * plan-changing findings hardest (1.0) and false negatives not at all (0).
     */
    values?: Partial<Record<PocJudgmentClassification, number>>;
    /**
     * Per-classification weight for the weighted mean over planning nodes.
     * Defaults weight `falseNegative` highest so missed risks dominate.
     */
    weights?: Partial<Record<PocJudgmentClassification, number>>;
};

/** Options for `planSolidityScorer`. */
type PlanSolidityOptions = {
    /**
     * Penalty subtracted from 1.0 for each churn event that occurs after the
     * first `EXEC_STARTED` event. Plan-phase churn (before execution starts) is
     * free — that is the process working. Defaults:
     * `NODE_INVALIDATED` 0.10, `REDELEGATED` 0.08, `GATE_FAILED` 0.05,
     * `REPLAN_REQUESTED` 0.04.
     */
    penalties?: Partial<Record<"NODE_INVALIDATED" | "REDELEGATED" | "GATE_FAILED" | "REPLAN_REQUESTED", number>>;
};

/** The component keys `delegationRunScore` combines. */
type DelegationRunComponent = "pocJudgment" | "planSolidity" | "estimateAccuracy" | "tierFit" | "humanPoll";
/**
 * The per-component results fed to `delegationRunScore`. A component may be
 * absent, `null` (e.g. sampled out or failed in `runScorersBatch`), or a
 * `ScoreResult` with `meta.skipped` — all three are excluded from the
 * weighted total and the remaining weights are renormalized.
 */
type DelegationRunResults = Partial<Record<DelegationRunComponent, ScoreResult$2 | null | undefined>>;
/** Options for `delegationRunScore`. */
type DelegationRunScoreOptions = {
    /**
     * Component weights. Defaults: pocJudgment 0.25, planSolidity 0.25,
     * estimateAccuracy 0.15, tierFit 0.15, humanPoll 0.2.
     */
    weights?: Partial<Record<DelegationRunComponent, number>>;
};

/**
 * Extracts a delegation event log from a scorer input.
 *
 * Accepts either a bare `DelegationEvent[]` or a `{ events, nodes? }` object
 * in the scored `output` (preferred) or `context`. Returns `null` when
 * neither carries events, so scorers can no-op per the package's skip
 * convention.
 */
declare function extractDelegationEvents(input: Pick<ScorerInput$1, "output" | "context">): DelegationEventsPayload | null;
/**
 * Resolves the set of planning-node ids a delegation log describes.
 *
 * When node metadata is available (payload `nodes`, or `children` carried by
 * `CHILDREN_DECLARED` events), only nodes whose `kind` is `goal` or `chunk`
 * qualify. Otherwise the set is derived from the events: every id referenced
 * as a planning actor minus known probe ids (`FINDING_REPORTED.probe`).
 */
declare function resolvePlanningNodes(payload: DelegationEventsPayload): string[];
/**
 * Creates the delegation-chain POC-judgment scorer.
 *
 * For each planning node (goal/chunk) in a delegation event log, classifies
 * its risk judgment into one of five outcomes (see
 * `PocJudgmentClassification`) and returns the weighted mean of the
 * per-classification values. Findings that CHANGED the plan reward hardest;
 * unflagged risks that later broke the node (false negatives) are punished
 * hardest via both a zero value and the highest weight.
 */
declare function pocJudgmentScorer(opts?: PocJudgmentOptions): Scorer$8;
/**
 * Creates the delegation-chain plan-solidity scorer.
 *
 * Measures how solid the plan was once execution began. Churn during the
 * planning phase (before the first `EXEC_STARTED` event) is free; every
 * churn event after execution starts subtracts a configurable penalty from
 * 1.0 and the score is clamped to [0, 1].
 */
declare function planSolidityScorer(opts?: PlanSolidityOptions): Scorer$8;
/**
 * Creates the delegation-chain estimate-accuracy scorer.
 *
 * For each node with both a latest estimate and actuals, accuracy is the
 * symmetric ratio `min(predicted, actual) / max(predicted, actual)` per
 * dimension, averaged over the dimensions present on both sides. The
 * run-level score is the mean over nodes weighted by predicted `costUsd`.
 * Replans re-forecast, so the LATEST estimate per node wins.
 */
declare function estimateAccuracyScorer(): Scorer$8;
/**
 * Creates the delegation-chain tier-fit scorer, an LLM judge that evaluates
 * whether a node's intelligence tier (fable/opus/sonnet/haiku) matched its
 * work. Over-tiering wastes cost on routine work; under-tiering risks quality
 * on hard work.
 */
declare function tierFitScorer(judge: AgentLike$3): Scorer$8;
/**
 * Creates the delegation-chain human-poll scorer.
 *
 * Consumes a submitted end-of-run user poll — an array of
 * `{ question, answer }` entries where answers are 1-5 ratings and/or
 * booleans — and normalizes it to a mean score in [0, 1]. With no poll the
 * scorer no-ops (score 1, `meta.skipped`).
 */
declare function humanPollScorer(): Scorer$8;
/**
 * Combines named `ScoreResult`s into one weighted score.
 *
 * Components that are missing, `null`, or skipped (`meta.skipped`) are
 * excluded and the remaining weights renormalize. When every component is
 * excluded the combined result is itself skipped (score 1, `meta.skipped`).
 */
declare function weightedScore(results: Record<string, ScoreResult$2 | null | undefined>, weights: Record<string, number>): ScoreResult$2;
/**
 * Combines the five delegation-chain scorer results into the run total:
 * `pocJudgmentScorer`, `planSolidityScorer`, `estimateAccuracyScorer`,
 * `tierFitScorer`, and `humanPollScorer`, weighted
 * 0.25 / 0.25 / 0.15 / 0.15 / 0.2 by default. Built on `weightedScore`, so
 * skipped or missing components drop out and the remaining weights
 * renormalize.
 */
declare function delegationRunScore(results: DelegationRunResults, opts?: DelegationRunScoreOptions): ScoreResult$2;

type AggregateOptions = AggregateOptions$2;
type AggregateScore = AggregateScore$2;
type CreateScorerConfig = CreateScorerConfig$2;
type LlmJudgeConfig = LlmJudgeConfig$2;
type SamplingConfig = SamplingConfig$1;
type Scorer = Scorer$8;
type ScorerBinding = ScorerBinding$1;
type ScorerContext = ScorerContext$2;
type ScoreResult = ScoreResult$2;
type ScorerFn = ScorerFn$1;
type ScorerInput = ScorerInput$1;
type ScoreRow = ScoreRow$1;
type ScorersMap = ScorersMap$2;

export { type AggregateOptions, type AggregateScore, type CreateScorerConfig, type DelegationEstimate, type DelegationEstimatePayload, type DelegationEvent, type DelegationEventsPayload, type DelegationExecRowLike, type DelegationPlanRowLike, type DelegationRunComponent, type DelegationRunResults, type DelegationRunScoreOptions, type LlmJudgeConfig, type PlanSolidityOptions, type PocJudgmentClassification, type PocJudgmentOptions, type SamplingConfig, type ScoreResult, type ScoreRow, type Scorer, type ScorerBinding, type ScorerContext, type ScorerFn, type ScorerInput, type ScorersMap, aggregateScores, createScorer, delegationRunScore, estimateAccuracyScorer, extractDelegationEvents, faithfulnessScorer, humanPollScorer, latencyScorer, llmJudge, planSolidityScorer, pocJudgmentScorer, relevancyScorer, resolvePlanningNodes, runScorersAsync, runScorersBatch, schemaAdherenceScorer, scorerDuration, scorersFailed, scorersFinished, scorersStarted, smithersScorers, tierFitScorer, toxicityScorer, weightedScore };
