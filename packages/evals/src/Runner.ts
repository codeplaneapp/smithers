/**
 * Deterministic fixed-suite execution and bound scorer evaluation.
 *
 * A run executes every case through the injected {@link CaseExecutor}, then
 * grades each execution with the scorers bound to the flow it executed. The
 * timestamp and the run identity come from the caller, so two runs of the same
 * suite over the same inputs produce byte-identical observations.
 *
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
 * `scorer` is the scorer key, a digest of the scorer's own declaration, which
 * is what a baseline matches on. `scorerName` is the human name from the same
 * declaration, carried alongside so a report can be read without grepping for
 * the digest. `at` is the run's timestamp, not the scorer's: a run's
 * observations all carry one instant so a baseline stays reproducible.
 *
 * @category models
 * @since 0.1.0
 */
export type Observation =
  & {
    readonly case: string
    readonly scorer: string
    readonly scorerName?: string | undefined
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
 */
export type ScoreJob = ScorerRunner.Job

/**
 * Structural adapter for `/scorers`' blocking batch runner.
 *
 * The protocol is the part a caller has to honour, because the observation type
 * carries no way back to the job that produced it:
 *
 * 1. `runBatch` returns exactly one observation per job.
 * 2. The observations are in the order the jobs were given.
 * 3. Each observation repeats its job's `targetStepKey` and `scorerKey`.
 *
 * A run verifies all three and fails with `scorer_protocol` when one is broken,
 * rather than attributing one case's score to another. `@smthrs/scorers`'
 * `Runner.Service` satisfies this contract, so its service value can be used
 * directly.
 *
 * @category services
 * @since 0.1.0
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
 */
export type ScoreObservation = ScoreStore.Observation

/**
 * Per-case result retained by the deterministic runner.
 *
 * @category models
 * @since 0.1.0
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
 * {@link run} does not require it: a run scores with `options.scorer` when one
 * is passed, otherwise with this service when one is provided, otherwise
 * in process through {@link makeInline}.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, ScoreBatchRunner>()("flows/evals/Runner") {}

/** The longest cause summary a public reason carries. */
const maxReasonLength = 2048

const scorerKeyOf = (binding: Binding): string => binding.scorer.scorerKey

// A scorer is a flow, and a flow declared without a name is an anonymous
// function whose `name` is the empty string. That is an absent name, not a
// name, so it never reaches an observation.
const scorerNameOf = (binding: Binding): string | undefined => {
  const name = binding.scorer.name
  return name === undefined || name.length === 0 ? undefined : name
}

const label = (binding: Binding): string => `${scorerNameOf(binding) ?? "scorer"} (${scorerKeyOf(binding).slice(0, 8)})`

// One injective encoder for every tuple key this package builds. Joining
// caller-supplied strings on a delimiter is not injective: ["a", "b\u0000c"]
// and ["a\u0000b", "c"] produce the same key, so two distinct jobs could share
// one identity.
const tupleKey = (...parts: ReadonlyArray<string>): string => JSON.stringify(parts)

const inconclusive = (request: ScoreRequest, reason: string, at: string): Observation => {
  const name = scorerNameOf(request.binding)
  return {
    case: request.case,
    scorer: scorerKeyOf(request.binding),
    ...(name === undefined ? {} : { scorerName: name }),
    stepKey: request.stepKey,
    kind: "inconclusive",
    reason,
    at
  }
}

/**
 * Names what actually went wrong.
 *
 * A scorer that threw a `TypeError` is a bug in the scorer and an unreachable
 * judge is an outage. A fixed sentence made the two observations identical, so
 * a permanently broken scorer kept producing inconclusive observations, which
 * no gate reads as a result, with nothing to debug from. The summary is bounded
 * because it reaches a CI log and a committed report.
 */
const inconclusiveReason = (what: string, cause: Cause.Cause<unknown>): string => {
  const summary = String(Cause.squash(cause))
  return `${what}: ${summary.length <= maxReasonLength ? summary : `${summary.slice(0, maxReasonLength)}[truncated]`}`
}

const runCase = (executor: CaseExecutorService, suiteCase: Case): Effect.Effect<CaseResult> =>
  executor.run(suiteCase).pipe(
    Effect.match({
      onFailure: (cause: unknown) => ({
        case: suiteCase.name,
        error: cause instanceof EvalError
          ? new EvalError({
            code: cause.code,
            message: `Target failed for case '${suiteCase.name}': ${cause.message}`,
            ...(cause.path === undefined ? {} : { path: cause.path }),
            cause
          })
          : new EvalError({
            code: "executor",
            message: `Target failed for case '${suiteCase.name}': ${String(cause)}`,
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

const observationFor = (request: ScoreRequest, result: ScoreObservation, at: string): Observation => {
  if (result.kind === "inconclusive") return inconclusive(request, result.reason, at)
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1) {
    return inconclusive(
      request,
      `Scorer ${label(request.binding)} returned a score outside [0, 1]: ${String(result.score)}`,
      at
    )
  }
  const name = scorerNameOf(request.binding)
  return {
    case: request.case,
    scorer: scorerKeyOf(request.binding),
    ...(name === undefined ? {} : { scorerName: name }),
    stepKey: request.stepKey,
    kind: "score",
    score: result.score,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.meta === undefined ? {} : { meta: result.meta }),
    at
  }
}

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

/**
 * Builds the in-process batch runner a run scores with by default.
 *
 * Each job's scorer runs in the current process, its result is checked by
 * `/scorers`' own `Scorer.validate`, and a scorer that fails becomes an
 * inconclusive observation naming its cause rather than failing the run. It
 * honours the {@link ScoreBatchRunner} protocol, so it is also the reference
 * a custom adapter can be compared against.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeInline = (): ScoreBatchRunner => ({
  runBatch: (jobs, options) => Effect.forEach(jobs, executeInline, { concurrency: options?.concurrency ?? 1 })
})

/**
 * Provides the in-process batch runner built by {@link makeInline}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInline: Layer.Layer<Runner> = Layer.succeed(Runner)(makeInline())

const score = (
  cases: ReadonlyArray<CaseResult>,
  suite: Suite,
  scorer: ScoreBatchRunner,
  concurrency: number,
  at: string,
  runId: string,
  sampleId: string
): Effect.Effect<ReadonlyArray<CaseResult>, EvalError> =>
  Effect.gen(function*() {
    // `cases` is the result of one `Effect.forEach` over `suite.cases`, so the
    // two arrays are index-aligned by construction; nothing here has to look a
    // case back up by name.
    const candidates = cases.flatMap((caseResult, index) => {
      const execution = caseResult.execution
      if (execution === undefined) return []
      const suiteCase = suite.cases[index]!
      return suite.bindings
        .filter((binding) => binding.appliesTo === execution.target)
        .map((binding) => requestFor(suiteCase, execution, binding))
    })
    const sampled = yield* Effect.forEach(
      candidates,
      (request) =>
        Sampling.decide(
          request.binding.sampling,
          request.stepKey,
          scorerKeyOf(request.binding)
        ).pipe(
          Effect.map((selected) => selected ? request : undefined),
          Effect.mapError((cause) =>
            new EvalError({
              code: "invalid_suite",
              message: `Invalid sampling policy for scorer ${label(request.binding)}`,
              path: `bindings[${suite.bindings.indexOf(request.binding)}].sampling`,
              cause
            })
          )
        ),
      { concurrency }
    )
    const requests = sampled.filter((request): request is ScoreRequest => request !== undefined)
    if (requests.length === 0) return cases
    const jobs: Array<ScoreJob> = requests.map((request, index) => ({
      identity: tupleKey(
        suite.name,
        runId,
        sampleId,
        request.case,
        request.stepKey,
        scorerKeyOf(request.binding),
        `${index}`
      ),
      observation: { targetStepKey: request.stepKey, scorerKey: scorerKeyOf(request.binding) },
      score: request.binding.scorer.score(request.input),
      at: Date.parse(at)
    }))
    const results = yield* scorer.runBatch(jobs, { concurrency }).pipe(
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
    )
    if (results.length !== jobs.length) {
      return yield* Effect.fail(
        new EvalError({
          code: "scorer_protocol",
          message:
            `Scorer batch returned ${results.length} observations for ${jobs.length} jobs; a batch runner must return exactly one observation per job, in order`,
          path: "runBatch"
        })
      )
    }
    const observations: Array<Observation> = []
    for (const [index, request] of requests.entries()) {
      const result = results[index]!
      if (result.targetStepKey !== request.stepKey || result.scorerKey !== scorerKeyOf(request.binding)) {
        return yield* Effect.fail(
          new EvalError({
            code: "scorer_protocol",
            message:
              `Scorer batch returned an observation for '${result.scorerKey}' at step '${result.targetStepKey}' where job ${index} asked for '${
                scorerKeyOf(request.binding)
              }' at step '${request.stepKey}'; results must stay aligned with their jobs`,
            path: `runBatch[${index}]`
          })
        )
      }
      observations.push(observationFor(request, result, at))
    }
    const byCase = new Map<string, Array<Observation>>()
    for (const observation of observations) {
      const bucket = byCase.get(observation.case)
      if (bucket === undefined) byCase.set(observation.case, [observation])
      else bucket.push(observation)
    }
    return cases.map((caseResult) => ({
      ...caseResult,
      observations: byCase.get(caseResult.case) ?? []
    }))
  })

/**
 * Runs a fixed suite with bounded execution and declaration-order results.
 *
 * Cases run through the provided {@link CaseExecutor} at the suite's
 * concurrency and are returned in declaration order. Every execution is then
 * graded by the bindings whose `appliesTo` is the flow the execution reports as
 * its target, matched by reference identity, so a binding attached to another
 * flow contributes no observations.
 *
 * Scoring goes through `options.scorer` when the caller passes one, the
 * {@link Runner} service when one is provided, and {@link makeInline}
 * otherwise. A case whose target failed keeps its typed error and produces no
 * observations; a scorer that failed produces an inconclusive observation. The
 * run itself fails only with `invalid_run_options` for a non-canonical run
 * identity or timestamp, `invalid_suite` for an unusable sampling policy, and
 * `scorer_protocol` for a batch runner that broke the {@link ScoreBatchRunner}
 * contract.
 *
 * @category constructors
 * @since 0.1.0
 */
export const run = (
  suite: Suite,
  options: RunOptions
): Effect.Effect<RunResult, EvalError, CaseExecutor> =>
  Effect.gen(function*() {
    const executor = yield* CaseExecutor
    const injected = yield* Effect.serviceOption(Runner)
    const scorer = options.scorer ?? (injected._tag === "Some" ? injected.value : makeInline())
    const atMillis = Date.parse(options.at)
    if (options.runId.trim().length === 0) {
      return yield* Effect.fail(
        new EvalError({
          code: "invalid_run_options",
          message: "Deterministic runs require a non-empty runId",
          path: "options.runId"
        })
      )
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(options.at) ||
      !Number.isFinite(atMillis) ||
      new Date(atMillis).toISOString() !== options.at
    ) {
      return yield* Effect.fail(
        new EvalError({
          code: "invalid_run_options",
          message:
            `Deterministic runs require a canonical UTC timestamp such as 2026-01-01T00:00:00.000Z, got '${options.at}'`,
          path: "options.at"
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
 * Provides a batch runner that is never available.
 *
 * Every bound score under this layer becomes an inconclusive observation, which
 * a gate grades as an undecidable run rather than a red. Provide it to state
 * that a suite must not score, and {@link layerInline} to score in process.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Runner> = Layer.succeed(Runner)({
  runBatch: () =>
    Effect.fail(
      new EvalError({ code: "scorer_unavailable", message: "No scorer batch runner is available" })
    )
})
