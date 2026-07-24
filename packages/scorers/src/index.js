// @smithers-type-exports-begin
/** @typedef {import("./AggregateOptions.js").AggregateOptions} AggregateOptions */
/** @typedef {import("./types.js").AggregateScore} AggregateScore */
/** @typedef {import("./CreateScorerConfig.js").CreateScorerConfig} CreateScorerConfig */
/** @typedef {import("./DelegationEstimate.js").DelegationEstimate} DelegationEstimate */
/** @typedef {import("./DelegationEstimate.js").DelegationEstimatePayload} DelegationEstimatePayload */
/** @typedef {import("./DelegationEstimate.js").DelegationExecRowLike} DelegationExecRowLike */
/** @typedef {import("./DelegationEstimate.js").DelegationPlanRowLike} DelegationPlanRowLike */
/** @typedef {import("./DelegationEvent.js").DelegationEvent} DelegationEvent */
/** @typedef {import("./DelegationEvent.js").DelegationEventsPayload} DelegationEventsPayload */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunComponent} DelegationRunComponent */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunResults} DelegationRunResults */
/** @typedef {import("./DelegationRunScoreOptions.js").DelegationRunScoreOptions} DelegationRunScoreOptions */
/** @typedef {import("./EvalAssertion.ts").EvalAssertion} EvalAssertion */
/** @typedef {import("./EvalCaseInput.ts").EvalCaseInput} EvalCaseInput */
/** @typedef {import("./EvalDatasetParseResult.ts").EvalDatasetParseResult} EvalDatasetParseResult */
/** @typedef {import("./EvalJudge.ts").EvalJudge} EvalJudge */
/** @typedef {import("./EvalJudgeRunner.ts").EvalJudgeRunner} EvalJudgeRunner */
/** @typedef {import("./LlmJudgeConfig.js").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("./ModelPrice.js").ModelPrice} ModelPrice */
/** @typedef {import("./PlanSolidityOptions.js").PlanSolidityOptions} PlanSolidityOptions */
/** @typedef {import("./PocJudgmentOptions.js").PocJudgmentClassification} PocJudgmentClassification */
/** @typedef {import("./PocJudgmentOptions.js").PocJudgmentOptions} PocJudgmentOptions */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiComplianceOptions} WorkflowUiComplianceOptions */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiComplianceReport} WorkflowUiComplianceReport */
/** @typedef {import("./WorkflowUiComplianceOptions.ts").WorkflowUiViolation} WorkflowUiViolation */
/** @typedef {import("./types.js").SamplingConfig} SamplingConfig */
/** @typedef {import("./types.js").Scorer} Scorer */
/** @typedef {import("./types.js").ScorerBinding} ScorerBinding */
/** @typedef {import("./types.js").ScorerContext} ScorerContext */
/** @typedef {import("./types.js").ScoreResult} ScoreResult */
/** @typedef {import("./types.js").ScorerFn} ScorerFn */
/** @typedef {import("./types.js").ScorerInput} ScorerInput */
/** @typedef {import("./types.js").ScoreRow} ScoreRow */
/** @typedef {import("./types.js").ScorersMap} ScorersMap */
// @smithers-type-exports-end

// Factories
export { createScorer } from "./createScorer.js";
export { llmJudge } from "./llmJudge.js";
// Built-in scorers
export { relevancyScorer } from "./relevancyScorer.js";
export { toxicityScorer } from "./toxicityScorer.js";
export { faithfulnessScorer } from "./faithfulnessScorer.js";
export { schemaAdherenceScorer } from "./schemaAdherenceScorer.js";
export { latencyScorer } from "./latencyScorer.js";
// Delegation-chain scorers
export { pocJudgmentScorer } from "./pocJudgmentScorer.js";
export { planSolidityScorer } from "./planSolidityScorer.js";
export { estimateAccuracyScorer } from "./estimateAccuracyScorer.js";
export { tierFitScorer } from "./tierFitScorer.js";
export { humanPollScorer } from "./humanPollScorer.js";
// Workflow-UI authoring compliance (design-system usage + live agent chat)
export { gradeWorkflowUiSource, workflowHasAgentTasks, workflowUiComplianceScorer, } from "./workflowUiCompliance.js";
export { sideEffectAnalysis } from "./sideEffectAnalysis.js";
export { gradeSideEffectCompliance } from "./gradeSideEffectCompliance.js";
export { extractDelegationEvents, resolvePlanningNodes, } from "./delegationEvents.js";
// Eval suites (issue #77): shared dataset parsing + case grading + the
// scorer seam the `eval-suite-run` workflow attaches to every case task.
export { EVAL_CASE_STATUSES, EVAL_PASS_THRESHOLD, evalAssertionScorer, evalCaseRunId, evaluateEvalCase, evaluateEvalCaseAsync, formatEvalError, isPlainObject, jsonContains, jsonEquals, normalizeEvalJudge, normalizeExpected, parseEvalDataset, slugifyEvalToken, } from "./evalCases.js";
// Execution
export { runScorersAsync, runScorersBatch } from "./run-scorers.js";
// Aggregation
export { aggregateScores, weightedScore, delegationRunScore, } from "./aggregate.js";
// Token pricing (shared cost table)
export { modelTokenPrices } from "./modelTokenPrices.js";
export { estimateCostUsd } from "./estimateCostUsd.js";
// Schema
export { smithersScorers } from "./schema.js";
// Metrics
export { scorersStarted, scorersFinished, scorersFailed, scorerDuration, } from "./metrics.js";
