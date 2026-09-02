import * as Flow from "@smthrs/core/Flow"
import * as Binding from "@smthrs/scorers/Binding"
import type * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
import { ScorerError } from "@smthrs/scorers/ScorerError"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"
import { EvalError } from "../src/EvalError.ts"
import * as Report from "../src/Report.ts"
import * as Runner from "../src/Runner.ts"
import * as Suite from "../src/Suite.ts"

const target = Flow.make({ name: "target" })
const scorerFlow = Scorer.make({
  id: "packages/evals/test/Runner/exact",
  version: "1",
  name: "exact",
  score: ({ output, groundTruth }) =>
    Effect.succeed({
      score: Object.is(output, groundTruth ?? output) ? 1 : 0,
      reason: "exact"
    })
})
const binding = Binding.make({ scorer: scorerFlow, appliesTo: target })
const runOptions = { runId: "run", at: "2026-01-01T00:00:00.000Z" } as const

const executorFor = (
  run: (suiteCase: Suite.Case) => Effect.Effect<CaseExecutor.Execution, EvalError>
): Layer.Layer<CaseExecutor.CaseExecutor> => Layer.succeed(CaseExecutor.CaseExecutor)(CaseExecutor.make(run))

const succeeding = executorFor((suiteCase) =>
  Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
)

const suiteOf = (
  name: string,
  bindings: ReadonlyArray<Suite.Binding>,
  cases: ReadonlyArray<Suite.Case> = [{ name: "one", input: 1 }]
): Promise<Suite.Suite> => Effect.runPromise(Suite.make({ name, concurrency: 1, bindings, cases }))

/** Runs an effect that must fail and returns the typed failure it raised. */
const failureOf = (effect: Effect.Effect<unknown, EvalError, never>): Promise<EvalError> =>
  Effect.runPromise(Effect.flip(effect))

describe("Runner", () => {
  it("keeps declaration order under bounded concurrency", async () => {
    const suite = await Effect.runPromise(
      Suite.make({
        name: "order",
        concurrency: 2,
        bindings: [binding],
        cases: [{ name: "slow", input: 1 }, { name: "fast", input: 2 }]
      })
    )
    const slowStarted = Deferred.makeUnsafe<void>()
    const releaseSlow = Deferred.makeUnsafe<void>()
    const executor = CaseExecutor.make((suiteCase) =>
      suiteCase.name === "slow"
        ? Deferred.succeed(slowStarted, void 0).pipe(
          Effect.andThen(Deferred.await(releaseSlow)),
          Effect.as({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 20, target })
        )
        : Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 1, target })
    )
    const scorer = {
      runBatch: (requests: ReadonlyArray<Runner.ScoreJob>) =>
        Effect.succeed(
          requests.map((request) => ({
            ...request.observation,
            kind: "score" as const,
            score: 1,
            reason: "ok",
            at: 0
          }))
        )
    }
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.forkChild())
        yield* Deferred.await(slowStarted)
        yield* Deferred.succeed(releaseSlow, void 0)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(executor)),
        Effect.scoped
      )
    )
    expect(result.cases.map((caseResult) => caseResult.case)).toEqual(["slow", "fast"])
  })

  // `Runner.run` used to declare the batch-runner service in its requirements
  // while resolving it with `Effect.serviceOption`, so the in-process path was
  // unreachable and every suite had to hand-copy an adapter to satisfy a type.
  it("scores in process when only a case executor is provided", async () => {
    const suite = await suiteOf("inline", [binding])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ kind: "score", score: 1, reason: "exact", scorerName: "exact" })
  })

  it("preserves a typed scorer failure code in the inline batch result", async () => {
    const result = await Effect.runPromise(
      Runner.makeInline().runBatch([{
        identity: "typed-failure",
        observation: { targetStepKey: "step", scorerKey: scorerFlow.scorerKey },
        score: Effect.fail(new ScorerError({ code: "store", message: "judge storage unavailable" })),
        at: 0
      }])
    )

    expect(result[0]).toMatchObject({
      kind: "inconclusive",
      code: "store",
      reason: expect.stringContaining("judge storage unavailable")
    })
  })

  it("scores through the provided Runner service and through the inline layer", async () => {
    const suite = await suiteOf("layers", [binding])
    const injected = await Effect.runPromise(
      Runner.run(suite, runOptions).pipe(Effect.provide(succeeding), Effect.provide(Runner.layerInline))
    )
    expect(injected.observations[0]?.kind).toBe("score")

    const explicit = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer: Runner.makeInline() }).pipe(Effect.provide(succeeding))
    )
    expect(explicit.observations[0]?.kind).toBe("score")
  })

  it("propagates scorer failures as inconclusive observations", async () => {
    const suite = await suiteOf("failure", [binding])
    const scorer = { runBatch: () => Effect.fail("judge unavailable") }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind).toBe("inconclusive")
    expect(observation?.kind === "inconclusive" && observation.reason).toContain("judge unavailable")
  })

  it("reports the unavailable batch runner rather than a target failure", async () => {
    const suite = await suiteOf("unavailable", [binding])
    const result = await Effect.runPromise(
      Runner.run(suite, runOptions).pipe(Effect.provide(succeeding), Effect.provide(Runner.layerNoop))
    )
    const observation = result.observations[0]
    expect(observation?.kind === "inconclusive" && observation.reason).toContain(
      "No scorer batch runner is available"
    )
  })

  it("bounds the cause it copies into a public reason", async () => {
    const suite = await suiteOf("bounded", [binding])
    const scorer = { runBatch: () => Effect.fail("x".repeat(5000)) }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind === "inconclusive" && observation.reason.endsWith("[truncated]")).toBe(true)
    expect(observation?.kind === "inconclusive" && observation.reason.length).toBeLessThan(2100)
  })

  // A scorer that threw a TypeError is a bug in the scorer; an unreachable
  // judge is an outage. Both used to arrive as the same fixed sentence, so a
  // permanently broken scorer read as an unavailable one forever.
  it("names the scorer's own cause in the inconclusive reason", async () => {
    const broken = Scorer.make({
      id: "packages/evals/test/Runner/broken",
      version: "1",
      name: "broken",
      score: () =>
        Effect.sync(() => {
          throw new TypeError("scorerKey is not a function")
        })
    })
    const suite = await suiteOf("broken-scorer", [Binding.make({ scorer: broken, appliesTo: target })])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    const observation = result.observations[0]
    expect(observation?.kind).toBe("inconclusive")
    expect(observation?.kind === "inconclusive" && observation.reason).toContain("scorerKey is not a function")
  })

  it("identifies an unnamed scorer by its key alone", async () => {
    const anonymous = Scorer.make({
      id: "packages/evals/test/Runner/anonymous",
      version: "1",
      score: () => Effect.succeed({ score: 1 })
    })
    const suite = await suiteOf("anonymous", [Binding.make({ scorer: anonymous, appliesTo: target })])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.observations[0]?.scorer).toBe(anonymous.scorerKey)
    expect(result.observations[0]?.scorerName).toBeUndefined()
  })

  it("retains a typed target failure with its own code and message, without re-running the target", async () => {
    const suite = await suiteOf("target-failure", [])
    let attempts = 0
    const executor = executorFor(() => {
      attempts += 1
      return Effect.fail(
        new EvalError({
          code: "invalid_suite",
          message: "the fixture is missing its expected column",
          path: "cases[0].expected"
        })
      )
    })
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases[0]?.error?.code).toBe("invalid_suite")
    expect(result.cases[0]?.error?.message).toBe(
      "Target failed for case 'one': the fixture is missing its expected column"
    )
    expect(result.cases[0]?.error?.path).toBe("cases[0].expected")
    expect(attempts).toBe(1)
  })

  it("names an untyped target failure instead of dropping it", async () => {
    const suite = await suiteOf("untyped-failure", [])
    const executor = Layer.succeed(CaseExecutor.CaseExecutor)({
      run: () => Effect.fail("raw failure" as unknown as EvalError)
    })
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases[0]?.error?.code).toBe("executor")
    expect(result.cases[0]?.error?.message).toBe("Target failed for case 'one': raw failure")
    expect(result.cases[0]?.error?.path).toBe("cases['one']")
  })

  it("locates a typed target failure that named no path at the case", async () => {
    const suite = await suiteOf("pathless-failure", [])
    const executor = executorFor(() => Effect.fail(new EvalError({ code: "executor", message: "the host is gone" })))
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases[0]?.error?.code).toBe("executor")
    expect(result.cases[0]?.error?.path).toBe("cases['one']")
  })

  it("applies deterministic scorer sampling before batch execution", async () => {
    const unsampled = Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: "none" })
    const suite = await suiteOf("sampling", [unsampled])
    let batches = 0
    const scorer = {
      runBatch: (_requests: ReadonlyArray<Runner.ScoreJob>) =>
        Effect.sync(() => {
          batches += 1
          return []
        })
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    expect(batches).toBe(0)
    expect(result.observations).toEqual([])
  })

  it("rejects a sampling policy the scorers package cannot decide", async () => {
    const suite = await suiteOf("bad-sampling", [
      Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: { ratio: 2, seed: "s" } as Sampling.Sampling })
    ])
    const error = await failureOf(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(error.code).toBe("invalid_suite")
    expect(error.message).toContain("Invalid sampling policy for scorer exact (")
    expect(error.path).toBe("bindings[0].sampling")
  })

  it("collects every binding's observation under its own case", async () => {
    const second = Scorer.make({
      id: "packages/evals/test/Runner/second",
      version: "1",
      name: "second",
      score: () => Effect.succeed({ score: 0.5 })
    })
    const suite = await suiteOf(
      "two-bindings",
      [binding, Binding.make({ scorer: second, appliesTo: target })],
      [{ name: "one", input: 1 }, { name: "two", input: 2 }]
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.cases.map((caseResult) => caseResult.observations.length)).toEqual([2, 2])
    expect(result.observations).toHaveLength(4)
  })

  it("runs sampled bound scorers and omits unsampled bindings", async () => {
    const unsampled = Binding.make({ scorer: scorerFlow, appliesTo: target, sampling: "none" })
    const suite = await suiteOf("mixed-sampling", [binding, unsampled])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]?.kind).toBe("score")
  })

  it("keeps a case with no observations beside a case that has them", async () => {
    const suite = await suiteOf("partial", [binding], [{ name: "ok", input: 1 }, { name: "broken", input: 2 }])
    const executor = executorFor((suiteCase) =>
      suiteCase.name === "ok"
        ? Effect.succeed({ output: suiteCase.input, stepKey: "step", latencyMs: 0, target })
        : Effect.fail(new EvalError({ code: "executor", message: "no" }))
    )
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(executor)))
    expect(result.cases.map((caseResult) => caseResult.observations.length)).toEqual([1, 0])
  })

  it("runs the in-process batch runner at concurrency 1 when given no options", async () => {
    const observations = await Effect.runPromise(
      Runner.makeInline().runBatch([{
        identity: "one",
        observation: { targetStepKey: "step", scorerKey: scorerFlow.scorerKey },
        score: Effect.succeed({ score: 1 }),
        at: 0
      }])
    )
    expect(observations).toEqual([{
      targetStepKey: "step",
      scorerKey: scorerFlow.scorerKey,
      kind: "score",
      score: 1,
      at: 0
    }])
  })

  it("names an unnamed scorer generically when it misbehaves", async () => {
    const anonymous = Scorer.make({
      id: "packages/evals/test/Runner/anonymous-liar",
      version: "1",
      score: () => Effect.succeed({ score: 1 })
    })
    const suite = await suiteOf("anonymous-liar", [Binding.make({ scorer: anonymous, appliesTo: target })])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(jobs.map((job) => ({ ...job.observation, kind: "score" as const, score: 7, at: job.at })))
        }
      }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.scorerName).toBeUndefined()
    expect(observation?.kind === "inconclusive" && observation.reason).toBe(
      `Scorer scorer (${anonymous.scorerKey.slice(0, 8)}) returned a score outside [0, 1]: 7`
    )
  })

  it("propagates fiber interruption from the target and from the scorer", async () => {
    const suite = await suiteOf("interrupt", [])
    const hangingTarget = await Effect.runPromiseExit(
      Runner.run(suite, runOptions).pipe(
        Effect.provide(executorFor(() => Effect.never)),
        Effect.timeout("10 millis")
      )
    )
    expect(hangingTarget._tag).toBe("Failure")

    const scored = await suiteOf("interrupt-scorer", [binding])
    const hangingBatch = await Effect.runPromiseExit(
      Runner.run(scored, { ...runOptions, scorer: { runBatch: () => Effect.never } }).pipe(
        Effect.provide(succeeding),
        Effect.timeout("10 millis")
      )
    )
    expect(hangingBatch._tag).toBe("Failure")
  })

  // An interrupted scorer is not an inconclusive score: recording one would
  // turn a cancelled run into a measured one.
  it("interrupts rather than scoring when a scorer or a batch is interrupted", async () => {
    const interrupted = Scorer.make({
      id: "packages/evals/test/Runner/interrupted",
      version: "1",
      name: "interrupted",
      score: () => Effect.interrupt
    })
    const inline = await suiteOf("interrupt-inline", [Binding.make({ scorer: interrupted, appliesTo: target })])
    const inlineExit = await Effect.runPromiseExit(
      Runner.run(inline, runOptions).pipe(Effect.provide(succeeding))
    )
    expect(inlineExit._tag).toBe("Failure")

    const batched = await suiteOf("interrupt-batch", [binding])
    const batchExit = await Effect.runPromiseExit(
      Runner.run(batched, { ...runOptions, scorer: { runBatch: () => Effect.interrupt } }).pipe(
        Effect.provide(succeeding)
      )
    )
    expect(batchExit._tag).toBe("Failure")
  })

  it("applies bindings only to their target and forwards ground truth and context", async () => {
    const other = Flow.make({ name: "other" })
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/evals/test/Runner/inspect",
      version: "1",
      name: "inspect",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1, meta: { seen: true } }
        })
    })
    const suite = await suiteOf(
      "bindings",
      [
        Binding.make({ scorer: inspecting, appliesTo: target, groundTruth: "answer", context: { rubric: "exact" } }),
        Binding.make({ scorer: inspecting, appliesTo: other })
      ],
      [{ name: "one", input: "question" }]
    )
    const executor = executorFor(() => Effect.succeed({ output: "answer", stepKey: "step", latencyMs: 1, target }))
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, sampleId: "sample" }).pipe(Effect.provide(executor))
    )
    expect(result.observations).toHaveLength(1)
    expect(result.observations[0]).toMatchObject({ kind: "score", meta: { seen: true } })
    expect(seen).toMatchObject({
      input: "question",
      output: "answer",
      groundTruth: "answer",
      context: { rubric: "exact" }
    })
  })

  it("prefers a case's own expected value as ground truth", async () => {
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/evals/test/Runner/ground-truth",
      version: "1",
      name: "ground-truth",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1 }
        })
    })
    const suite = await suiteOf(
      "ground-truth",
      [Binding.make({ scorer: inspecting, appliesTo: target, groundTruth: "binding" })],
      [{ name: "one", input: 1, expected: "case" }]
    )
    await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(seen?.groundTruth).toBe("case")
    expect(Object.hasOwn(seen!, "context")).toBe(false)
  })

  it("omits ground truth when neither the case nor the binding declares it", async () => {
    let seen: Scorer.Input | undefined
    const inspecting = Scorer.make({
      id: "packages/evals/test/Runner/no-ground-truth",
      version: "1",
      name: "no-ground-truth",
      score: (input) =>
        Effect.sync(() => {
          seen = input
          return { score: 1 }
        })
    })
    const suite = await suiteOf("bare", [Binding.make({ scorer: inspecting, appliesTo: target })])
    await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(Object.hasOwn(seen!, "groundTruth")).toBe(false)
  })

  it("requires deterministic run identity and a canonical UTC timestamp", async () => {
    const suite = await suiteOf("identity", [])
    const provided = (options: Runner.RunOptions) => Runner.run(suite, options).pipe(Effect.provide(succeeding))

    const blankId = await failureOf(provided({ runId: " ", at: runOptions.at }))
    expect(blankId.code).toBe("invalid_run_options")
    expect(blankId.message).toBe("Deterministic runs require a non-empty runId")
    expect(blankId.path).toBe("options.runId")

    for (const at of ["2026-01-01", "2026-13-01T00:00:00.000Z"]) {
      const badAt = await failureOf(provided({ runId: "run", at }))
      expect(badAt.code).toBe("invalid_run_options")
      expect(badAt.path).toBe("options.at")
      expect(badAt.message).toContain(`got '${at}'`)
    }
  })

  // Correlating batch results by array position attributed one case's score to
  // another the moment an adapter returned them in a different order.
  it("refuses a batch runner that returns results out of order", async () => {
    const suite = await suiteOf("reordered", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const executor = executorFor((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: `step-${suiteCase.name}`, latencyMs: 0, target })
    )
    const reversing: Runner.ScoreBatchRunner = {
      runBatch: (jobs) =>
        Effect.succeed(
          [...jobs].reverse().map((job, index) => ({
            ...job.observation,
            kind: "score" as const,
            score: index === 0 ? 0.99 : 0.11,
            at: job.at
          }))
        )
    }
    const error = await failureOf(
      Runner.run(suite, { ...runOptions, scorer: reversing }).pipe(Effect.provide(executor))
    )
    expect(error.code).toBe("scorer_protocol")
    expect(error.message).toContain("results must stay aligned with their jobs")
    expect(error.path).toBe("runBatch[0]")
  })

  it("refuses ambiguous jobs before calling an order-only batch runner", async () => {
    const suite = await suiteOf("ambiguous", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    let called = false
    const reversing: Runner.ScoreBatchRunner = {
      runBatch: (jobs) => {
        called = true
        return Effect.succeed(
          [...jobs].reverse().map((job, index) => ({
            ...job.observation,
            kind: "score" as const,
            score: index === 0 ? 0.99 : 0.11,
            at: job.at
          }))
        )
      }
    }
    const error = await failureOf(
      Runner.run(suite, { ...runOptions, scorer: reversing }).pipe(Effect.provide(succeeding))
    )
    expect(called).toBe(false)
    expect(error.code).toBe("ambiguous_score_job")
    expect(error.message).toContain("cases 'a' and 'b'")
    expect(error.message).toContain("step key 'step'")
    expect(error.message).toContain(`scorer exact (${scorerFlow.scorerKey.slice(0, 8)})`)
    expect(error.message).toContain(
      "Give each case its own step key, or provide a batch runner that implements runBatchCorrelated"
    )
    expect(error.path).toBe("runBatch")
  })

  it("scores ambiguous jobs through the correlated inline runner", async () => {
    const suite = await suiteOf("inline-ambiguous", [binding], [
      { name: "a", input: 1 },
      { name: "b", input: 2 }
    ])
    const result = await Effect.runPromise(Runner.run(suite, runOptions).pipe(Effect.provide(succeeding)))
    expect(result.cases.map((caseResult) => caseResult.observations[0]?.kind)).toEqual(["score", "score"])
    expect(result.observations.map((observation) => observation.kind === "score" && observation.score)).toEqual([1, 1])
  })

  it("correlates reversed batch results by job identity", async () => {
    const suite = await suiteOf("correlated", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const scorer: Runner.ScoreBatchRunner = {
      runBatch: () => Effect.die("order-only path used"),
      runBatchCorrelated: (jobs) =>
        Effect.succeed(
          jobs.map((job, index) => ({
            identity: job.identity,
            observation: {
              ...job.observation,
              kind: "score" as const,
              score: index === 0 ? 0.11 : 0.99,
              at: job.at
            }
          })).reverse()
        )
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    expect(result.cases.map((caseResult) => {
      const observation = caseResult.observations[0]
      return observation?.kind === "score" ? observation.score : undefined
    })).toEqual([0.11, 0.99])
  })

  it("rejects duplicate and unknown correlated identities", async () => {
    const suite = await suiteOf("bad-identities", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const observation = (job: Runner.ScoreJob): Runner.ScoreObservation => ({
      ...job.observation,
      kind: "score",
      score: 1,
      at: job.at
    })
    const adapter = (
      runBatchCorrelated: NonNullable<Runner.ScoreBatchRunner["runBatchCorrelated"]>
    ): Runner.ScoreBatchRunner => ({ runBatch: () => Effect.die("order-only path used"), runBatchCorrelated })

    let duplicateIdentity = ""
    const duplicate = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) => {
          duplicateIdentity = jobs[0]!.identity
          return Effect.succeed([
            { identity: jobs[0]!.identity, observation: observation(jobs[0]!) },
            { identity: jobs[0]!.identity, observation: observation(jobs[1]!) }
          ])
        })
      }).pipe(Effect.provide(succeeding))
    )
    expect(duplicate.code).toBe("scorer_protocol")
    expect(duplicate.message).toContain(`duplicate identity '${duplicateIdentity}'`)
    expect(duplicate.message).toContain("result index 1")

    const unknown = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) =>
          Effect.succeed([
            { identity: "not-a-job", observation: observation(jobs[0]!) },
            { identity: jobs[1]!.identity, observation: observation(jobs[1]!) }
          ])
        )
      }).pipe(Effect.provide(succeeding))
    )
    expect(unknown.code).toBe("scorer_protocol")
    expect(unknown.message).toContain("unknown identity 'not-a-job'")
    expect(unknown.message).toContain("result index 0")
  })

  it("rejects correlated arity and echoed identity mismatches", async () => {
    const suite = await suiteOf("bad-correlated-results", [binding], [
      { name: "a", input: 1 },
      { name: "b", input: 2 }
    ])
    const adapter = (
      runBatchCorrelated: NonNullable<Runner.ScoreBatchRunner["runBatchCorrelated"]>
    ): Runner.ScoreBatchRunner => ({ runBatch: () => Effect.die("order-only path used"), runBatchCorrelated })

    const wrongArity = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) =>
          Effect.succeed([{
            identity: jobs[0]!.identity,
            observation: { ...jobs[0]!.observation, kind: "score", score: 1, at: jobs[0]!.at }
          }])
        )
      }).pipe(Effect.provide(succeeding))
    )
    expect(wrongArity.code).toBe("scorer_protocol")
    expect(wrongArity.message).toContain("returned 1 results for 2 jobs")
    expect(wrongArity.path).toBe("runBatchCorrelated")

    const wrongEcho = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: adapter((jobs) =>
          Effect.succeed(jobs.map((job, index) => ({
            identity: job.identity,
            observation: {
              ...job.observation,
              targetStepKey: index === 0 ? "wrong-step" : job.observation.targetStepKey,
              kind: "score" as const,
              score: 1,
              at: job.at
            }
          })))
        )
      }).pipe(Effect.provide(succeeding))
    )
    expect(wrongEcho.code).toBe("scorer_protocol")
    expect(wrongEcho.message).toContain("where job 0 asked for")
    expect(wrongEcho.message).toContain("at step 'step'")
    expect(wrongEcho.message).toContain("returned step 'wrong-step'")
    expect(wrongEcho.path).toBe("runBatchCorrelated[0]")
  })

  it("turns a correlated batch failure into identity-tagged inconclusive results", async () => {
    const suite = await suiteOf("correlated-failure", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const scorer: Runner.ScoreBatchRunner = {
      runBatch: () => Effect.die("order-only path used"),
      runBatchCorrelated: () => Effect.fail("correlated judge unavailable")
    }
    const result = await Effect.runPromise(
      Runner.run(suite, { ...runOptions, scorer }).pipe(Effect.provide(succeeding))
    )
    expect(result.observations).toHaveLength(2)
    expect(
      result.observations.every((item) =>
        item.kind === "inconclusive" && item.reason.includes("correlated judge unavailable")
      )
    ).toBe(true)
  })

  it("refuses a batch runner that drops or duplicates results", async () => {
    const suite = await suiteOf("arity", [binding], [{ name: "a", input: 1 }, { name: "b", input: 2 }])
    const executor = executorFor((suiteCase) =>
      Effect.succeed({ output: suiteCase.input, stepKey: suiteCase.name, latencyMs: 0, target })
    )
    const observations = (jobs: ReadonlyArray<Runner.ScoreJob>) =>
      jobs.map((job) => ({ ...job.observation, kind: "score" as const, score: 1, at: job.at }))

    const dropping = await failureOf(
      Runner.run(suite, { ...runOptions, scorer: { runBatch: (jobs) => Effect.succeed(observations(jobs).slice(1)) } })
        .pipe(Effect.provide(executor))
    )
    expect(dropping.code).toBe("scorer_protocol")
    expect(dropping.message).toBe(
      "Scorer batch returned 1 observations for 2 jobs; a batch runner must return exactly one observation per job, in order"
    )
    expect(dropping.path).toBe("runBatch")

    const duplicating = await failureOf(
      Runner.run(suite, {
        ...runOptions,
        scorer: { runBatch: (jobs) => Effect.succeed([...observations(jobs), ...observations(jobs)]) }
      }).pipe(Effect.provide(executor))
    )
    expect(duplicating.message).toContain("4 observations for 2 jobs")
  })

  // A lying adapter used to have its out-of-range score copied straight into an
  // observation and relabelled with the identity the run expected.
  it("turns an out-of-range or non-finite score into a named inconclusive observation", async () => {
    const suite = await suiteOf("liar", [binding])
    for (const score of [2, Number.NaN, -1]) {
      const result = await Effect.runPromise(
        Runner.run(suite, {
          ...runOptions,
          scorer: {
            runBatch: (jobs) =>
              Effect.succeed(jobs.map((job) => ({ ...job.observation, kind: "score" as const, score, at: job.at })))
          }
        }).pipe(Effect.provide(succeeding))
      )
      const observation = result.observations[0]
      expect(observation?.kind).toBe("inconclusive")
      expect(observation?.kind === "inconclusive" && observation.reason).toBe(
        `Scorer exact (${scorerFlow.scorerKey.slice(0, 8)}) returned a score outside [0, 1]: ${String(score)}`
      )
    }
  })

  it("carries an inconclusive batch observation through with its own reason", async () => {
    const suite = await suiteOf("inconclusive", [binding])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(
              jobs.map((job) => ({
                ...job.observation,
                kind: "inconclusive" as const,
                code: "inconclusive" as const,
                reason: "judge down",
                at: job.at
              }))
            )
        }
      }).pipe(Effect.provide(succeeding))
    )
    expect(result.observations[0]).toMatchObject({ kind: "inconclusive", reason: "judge down", scorerName: "exact" })
  })

  it("replaces an inconclusive observation without a reason and renders it", async () => {
    const suite = await suiteOf("missing-reason", [binding])
    for (const reason of [undefined, ""]) {
      const result = await Effect.runPromise(
        Runner.run(suite, {
          ...runOptions,
          scorer: {
            runBatch: (jobs) =>
              Effect.succeed(jobs.map((job) =>
                ({
                  ...job.observation,
                  kind: "inconclusive",
                  reason,
                  at: job.at
                }) as unknown as Runner.ScoreObservation
              ))
          }
        }).pipe(Effect.provide(succeeding))
      )
      const observation = result.observations[0]
      expect(observation?.kind).toBe("inconclusive")
      expect(observation?.kind === "inconclusive" && observation.reason).toBe(
        `Scorer exact (${scorerFlow.scorerKey.slice(0, 8)}) returned an inconclusive observation with no reason`
      )
      const inconclusive = result.observations.filter((item): item is Extract<Runner.Observation, {
        kind: "inconclusive"
      }> => item.kind === "inconclusive")
      const rendered = Report.markdown({
        suite: result.suite,
        baseline: { version: 1, suite: result.suite, records: [] },
        run: result,
        regressions: [],
        nondeterminism: [],
        missing: [],
        samples: [],
        inconclusive
      })
      expect(rendered).toContain("returned an inconclusive observation with no reason")
    }
  })

  it("bounds the generated reason for an inconclusive observation without one", async () => {
    const named = Scorer.make({
      id: "packages/evals/test/Runner/long-name",
      version: "1",
      name: "x".repeat(5000),
      score: () => Effect.succeed({ score: 1 })
    })
    const suite = await suiteOf("bounded-missing-reason", [Binding.make({ scorer: named, appliesTo: target })])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(jobs.map((job) =>
              ({
                ...job.observation,
                kind: "inconclusive",
                reason: undefined,
                at: job.at
              }) as unknown as Runner.ScoreObservation
            ))
        }
      }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind === "inconclusive" && observation.reason.endsWith("[truncated]")).toBe(true)
    expect(observation?.kind === "inconclusive" && observation.reason.length).toBeLessThan(2100)
  })

  it("turns an unknown observation kind into a named inconclusive observation", async () => {
    const suite = await suiteOf("unknown-kind", [binding])
    const result = await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        scorer: {
          runBatch: (jobs) =>
            Effect.succeed(jobs.map((job) =>
              ({
                ...job.observation,
                kind: "mystery",
                at: job.at
              }) as unknown as Runner.ScoreObservation
            ))
        }
      }).pipe(Effect.provide(succeeding))
    )
    const observation = result.observations[0]
    expect(observation?.kind).toBe("inconclusive")
    expect(observation?.kind === "inconclusive" && observation.reason).toBe(
      `Scorer exact (${scorerFlow.scorerKey.slice(0, 8)}) returned an unusable observation kind 'mystery'`
    )
  })

  it("bounds string reasons and drops a non-string score reason", async () => {
    const suite = await suiteOf("score-reasons", [binding])
    for (const reason of ["x".repeat(5000), 42]) {
      const result = await Effect.runPromise(
        Runner.run(suite, {
          ...runOptions,
          scorer: {
            runBatch: (jobs) =>
              Effect.succeed(jobs.map((job) =>
                ({
                  ...job.observation,
                  kind: "score",
                  score: 0.5,
                  reason,
                  meta: { kept: true },
                  at: job.at
                }) as unknown as Runner.ScoreObservation
              ))
          }
        }).pipe(Effect.provide(succeeding))
      )
      const observation = result.observations[0]
      expect(observation?.kind).toBe("score")
      expect(observation?.meta).toEqual({ kept: true })
      if (typeof reason === "string") {
        expect(observation?.reason?.endsWith("[truncated]")).toBe(true)
        expect(observation?.reason?.length).toBeLessThan(2100)
      } else {
        expect(Object.hasOwn(observation!, "reason")).toBe(false)
      }
    }
  })

  it("builds an injective job identity", async () => {
    const suite = await suiteOf("identity-encoding", [binding])
    let seen: ReadonlyArray<Runner.ScoreJob> = []
    await Effect.runPromise(
      Runner.run(suite, {
        ...runOptions,
        sampleId: "sample",
        scorer: {
          runBatch: (jobs) => {
            seen = jobs
            return Effect.succeed(
              jobs.map((job) => ({ ...job.observation, kind: "score" as const, score: 1, at: job.at }))
            )
          }
        }
      }).pipe(Effect.provide(succeeding))
    )
    expect(JSON.parse(seen[0]!.identity)).toEqual([
      "identity-encoding",
      "run",
      "sample",
      "one",
      "step",
      scorerFlow.scorerKey,
      "0"
    ])
  })
})
