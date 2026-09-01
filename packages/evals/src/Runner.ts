/**
 * Deterministic fixed-suite execution and bound scorer evaluation.
 *
 * @see docs/specs/Concepts/Scoring.md
 * @since 0.1.0
 */
import type * as ScorerRunner from "@smthrs/scorers/Runner"
import * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
import type * as ScoreStore from "@smthrs/scorers/ScoreStore"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CaseExecutor, type Execution, type Service as CaseExecutorService } from "./CaseExecutor.ts"
import { EvalError } from "./EvalError.ts"
import type { Binding, Case, Suite } from "./Suite.ts"

/**
 * One score observation emitted by a suite run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Observation =
  & {
    readonly case: string
    readonly scorer: string
    readonly stepKey: string
    readonly at: string
  }
  & (
    | {
      readonly kind: "score"
      readonly score: number
      readonly reason?: string | undefined
      readonly meta?: unknown
    }
    | { readonly kind: "inconclusive"; readonly reason: string; readonly meta?: unknown }
  )

/**
 * A request sent to the scorers batch runner.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ScoreRequest {
  readonly case: string
  readonly stepKey: string
  readonly binding: Binding
  readonly input: {
    readonly input: unknown
    readonly output: unknown
    readonly groundTruth?: unknown
    readonly context?: unknown
    readonly latencyMs?: number
  }
}

/**
 * A blocking scorer job, matching `/scorers/Runner`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ScoreJob = ScorerRunner.Job

/**
 * Structural adapter for `/scorers`' blocking batch runner.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface ScoreBatchRunner {
  readonly runBatch: (
    jobs: ReadonlyArray<ScoreJob>,
    options?: { readonly concurrency?: number | undefined }
  ) => Effect.Effect<ReadonlyArray<ScoreObservation>, unknown>
}

/**
 * A score result aligned with a {@link ScoreRequest}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ScoreObservation = ScoreStore.Observation

/**
 * Per-case result retained by the deterministic runner.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CaseResult {
  readonly case: string
  readonly execution?: Execution | undefined
  readonly error?: EvalError | undefined
  readonly observations: ReadonlyArray<Observation>
}

/**
 * Stable result of a suite run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RunResult {
  readonly runId: string
  readonly suite: string
  readonly cases: ReadonlyArray<CaseResult>
  readonly observations: ReadonlyArray<Observation>
}

/**
 * Options for a deterministic suite run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface RunOptions {
  readonly scorer?: ScoreBatchRunner | undefined
  readonly runId: string
  readonly sampleId?: string | undefined
  readonly at: string
}

/**
 * Injectable batch-runner service used when a caller wants a reusable adapter.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Runner extends Context.Service<Runner, ScoreBatchRunner>()("flows/evals/Runner") {}

const scorerName = (binding: Binding): string => {
  return binding.scorer.scorerKey
}

const inconclusive = (caseName: string, scorer: string, stepKey: string, reason: string, at: string): Observation => ({
  case: caseName,
  scorer,
  stepKey,
  kind: "inconclusive",
  reason,
  at
})

/**
 * Names what actually went wrong.
 *
 * A scorer that threw a `TypeError` is a bug in the scorer and an unreachable
 * judge is an outage. A fixed sentence made the two observations identical, so
 * a permanently broken scorer kept producing inconclusive observations, which
 * no gate reads as a result, with nothing to debug from.
 */
const inconclusiveReason = (what: string, cause: Cause.Cause<unknown>): string =>
  `${what}: ${String(Cause.squash(cause))}`

const runCase = (executor: CaseExecutorService, suiteCase: Case): Effect.Effect<CaseResult> =>
  executor.run(suiteCase).pipe(
    Effect.match({
      onFailure: (cause) => ({
        case: suiteCase.name,
        error: new EvalError({
          code: "executor",
          message: `Target failed for case '${suiteCase.name}'`,
          cause
        }),
        observations: []
      }),
      onSuccess: (execution) => ({ case: suiteCase.name, execution, observations: [] })
    })
  )

const requestFor = (suiteCase: Case, execution: Execution, binding: Binding): ScoreRequest => ({
  case: suiteCase.name,
  stepKey: execution.stepKey,
  binding,
  input: {
    input: suiteCase.input,
    output: execution.output,
    ...(suiteCase.expected === undefined && binding.groundTruth === undefined
      ? {}
      : { groundTruth: suiteCase.expected ?? binding.groundTruth }),
    ...(binding.context === undefined ? {} : { context: binding.context }),
    latencyMs: execution.latencyMs
  }
})

const score = (
  cases: ReadonlyArray<CaseResult>,
  suite: Suite,
  scorer: ScoreBatchRunner | undefined,
  concurrency: number,
  at: string,
  runId: string,
  sampleId: string
): Effect.Effect<ReadonlyArray<CaseResult>, EvalError> =>
  Effect.gen(function*() {
    const candidates = cases.flatMap((caseResult) => {
      const execution = caseResult.execution
      const suiteCase = suite.cases.find((candidate) => candidate.name === caseResult.case)
      return execution === undefined || suiteCase === undefined
        ? []
        : suite.bindings
          .filter((binding) => binding.appliesTo === execution.target)
          .map((binding) => requestFor(suiteCase, execution, binding))
    })
    const sampled = yield* Effect.forEach(
      candidates,
      (request) =>
        Sampling.decide(
          request.binding.sampling,
          request.stepKey,
          request.binding.scorer.scorerKey
        ).pipe(
          Effect.map((selected) => selected ? request : undefined),
          Effect.mapError((cause) =>
            new EvalError({
              code: "invalid_suite",
              message: `Invalid sampling policy for scorer '${scorerName(request.binding)}'`,
              cause
            })
          )
        ),
      { concurrency }
    )
    const requests = sampled.filter((request): request is ScoreRequest => request !== undefined)
    if (requests.length === 0) return cases
    const jobs: Array<ScoreJob> = requests.map((request, index) => ({
      identity: `${suite.name}\u0000${runId}\u0000${sampleId}\u0000${request.case}\u0000${request.stepKey}\u0000${
        scorerName(request.binding)
      }\u0000${index}`,
      observation: { targetStepKey: request.stepKey, scorerKey: scorerName(request.binding) },
      score: request.binding.scorer.score(request.input),
      at: Date.parse(at)
    }))
    const executeInline = (job: ScoreJob): Effect.Effect<ScoreObservation> =>
      job.score.pipe(
        Effect.flatMap(Scorer.validate),
        Effect.map((result): ScoreStore.ScoreObservation => ({
          ...job.observation,
          kind: "score",
          score: result.score,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
          at: job.at
        })),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.succeed({
              ...job.observation,
              kind: "inconclusive" as const,
              reason: inconclusiveReason("Scorer execution failed", cause),
              at: job.at
            })
        )
      )
    const results = yield* (scorer === undefined
      ? Effect.forEach(jobs, executeInline, { concurrency })
      : scorer.runBatch(jobs, { concurrency }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.succeed(
              jobs.map((job) => ({
                ...job.observation,
                kind: "inconclusive" as const,
                reason: inconclusiveReason("Scorer batch failed", cause),
                at: job.at
              }))
            )
        )
      ))
    const observations = requests.map((request, index): Observation => {
      const result = results[index]
      if (result === undefined) {
        return inconclusive(
          request.case,
          scorerName(request.binding),
          request.stepKey,
          "Scorer batch returned no observation",
          at
        )
      }
      return result.kind === "inconclusive"
        ? inconclusive(request.case, scorerName(request.binding), request.stepKey, result.reason, at)
        : {
          case: request.case,
          scorer: scorerName(request.binding),
          stepKey: request.stepKey,
          kind: "score",
          score: result.score,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
          at
        }
    })
    return cases.map((caseResult) => ({
      ...caseResult,
      observations: observations.filter((observation) => observation.case === caseResult.case)
    }))
  })

/**
 * Runs a fixed suite with bounded execution and declaration-order results.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const run = (
  suite: Suite,
  options: RunOptions
): Effect.Effect<RunResult, EvalError, CaseExecutor | Runner> =>
  Effect.gen(function*() {
    const executor = yield* CaseExecutor
    const scorer = options.scorer ?? (yield* Effect.serviceOption(Runner)).pipe(
      (option) => option._tag === "Some" ? option.value : undefined
    )
    const atMillis = Date.parse(options.at)
    if (
      options.runId.trim().length === 0 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(options.at) ||
      !Number.isFinite(atMillis) ||
      new Date(atMillis).toISOString() !== options.at
    ) {
      return yield* Effect.fail(
        new EvalError({
          code: "invalid_suite",
          message: "Deterministic runs require a non-empty runId and canonical UTC timestamp"
        })
      )
    }
    const at = options.at
    const runId = options.runId
    const sampleId = options.sampleId ?? "default"
    const cases = yield* Effect.forEach(suite.cases, (suiteCase) => runCase(executor, suiteCase), {
      concurrency: suite.concurrency,
      discard: false
    })
    const scored = yield* score(cases, suite, scorer, suite.concurrency, at, runId, sampleId)
    return {
      runId,
      suite: suite.name,
      cases: scored,
      observations: scored.flatMap((caseResult) => caseResult.observations)
    }
  })

/**
 * Provides an unavailable scorer batch runner.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<Runner> = Layer.succeed(Runner)({
  runBatch: () => Effect.fail(new EvalError({ code: "executor", message: "No scorer batch runner is available" }))
})
