import * as Control from "@smthrs/control/Control"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000

interface RunnerFixture {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
  readonly active: Set<string>
  readonly cancels: Set<string>
  failures: number
}

const runnerFixture = (failures = 0): RunnerFixture => {
  const starts: Array<Scheduler.StartInput> = []
  const active = new Set<string>()
  const cancels = new Set<string>()
  const fixture: RunnerFixture = {
    starts,
    active,
    cancels,
    failures,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.suspend(() => {
          starts.push(input)
          if (fixture.failures > 0) {
            fixture.failures--
            return Effect.fail(
              new TriggerError({ code: "store", message: "runner launch failed" })
            )
          }
          const runId = `run-${starts.length}`
          active.add(runId)
          return Effect.succeed(runId)
        }),
      isActive: (runId) => Effect.sync(() => active.has(runId)),
      cancel: (runId) =>
        Effect.sync(() => {
          cancels.add(runId)
          active.delete(runId)
        })
    })
  }
  return fixture
}

const trigger = (
  overlap: Trigger["overlap"] = "skip",
  catchUp: Trigger["catchUp"] = "one"
): Trigger => ({
  id: "hourly",
  flowId: "flow",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap,
  catchUp,
  maxCatchUp: 3,
  enabled: true
})

const recordingStore = (
  results: Array<TriggerStore.Result>
): Layer.Layer<TriggerStore.TriggerStore> =>
  Layer.effect(
    TriggerStore.TriggerStore,
    Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      return TriggerStore.TriggerStore.of({
        ...store,
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          }).pipe(Effect.andThen(store.recordResult(result)))
      })
    })
  ).pipe(Layer.provide(TestTriggers.layer))

const provideTest = <A, E>(
  effect: Effect.Effect<A, E, TriggerStore.TriggerStore>,
  results: Array<TriggerStore.Result>
) =>
  effect.pipe(
    Effect.provide(recordingStore(results)),
    Effect.provide(TestClock.layer())
  )

const seed = (
  store: TriggerStore.Service,
  declaration: Trigger,
  fixture: RunnerFixture,
  outcome: TriggerStore.Outcome = "launched"
) =>
  Effect.gen(function*() {
    const registered = yield* store.register(declaration)
    yield* store.claimFire({
      triggerId: declaration.id,
      occurrence: 0,
      expectedRevision: registered.revision
    })
    if (outcome === "launched") fixture.active.add("seed")
    yield* store.recordResult({
      triggerId: declaration.id,
      occurrence: 0,
      outcome,
      ...(outcome === "launched" ? { runId: "seed" } : {})
    })
  })

describe("Scheduler", () => {
  for (const overlap of ["skip", "buffer-one", "supersede"] as const) {
    for (const catchUp of ["none", "one", "all"] as const) {
      it(`${overlap} × ${catchUp}`, async () => {
        const results: Array<TriggerStore.Result> = []
        const runner = runnerFixture()
        await Effect.runPromise(
          provideTest(
            Effect.scoped(
              Effect.gen(function*() {
                const store = yield* TriggerStore.TriggerStore
                yield* seed(store, trigger(overlap, catchUp), runner)
                results.length = 0
                yield* TestClock.setTime(3 * hour)
                const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
                  Effect.provideService(Scheduler.Runner, runner.service)
                )
                yield* scheduler.runOnce
                yield* Effect.yieldNow
              })
            ),
            results
          )
        )

        const count = catchUp === "none" ? 0 : catchUp === "one" ? 1 : 3
        if (overlap === "skip") {
          expect(runner.starts).toHaveLength(0)
          expect(results.filter((result) => result.outcome === "skipped")).toHaveLength(count)
        } else if (overlap === "buffer-one") {
          expect(runner.starts).toHaveLength(0)
          expect(results.filter((result) => result.outcome === "buffered")).toHaveLength(count)
        } else {
          expect(runner.starts).toHaveLength(count)
          expect(results.filter((result) => result.outcome === "launched")).toHaveLength(count)
        }
      })
    }
  }

  it("coalesces buffer-one to the latest pending occurrence and launches it after terminal", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("buffer-one", "all"), runner)
            results.length = 0
            yield* TestClock.setTime(3 * hour)
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            expect(runner.starts).toHaveLength(0)

            runner.active.delete("seed")
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(1)
    expect(runner.starts[0]?.idempotencyKey).toBe(
      `hourly:${new Date(3 * hour).toISOString()}`
    )
  })

  it("supersedes by interrupting the prior child and cancelling its run", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("supersede", "one"), runner, "skipped")
            results.length = 0
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )

            yield* TestClock.setTime(hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(2)
    expect(runner.cancels.has("run-1")).toBe(true)
    expect(results.some((result) => result.outcome === "superseded")).toBe(true)
  })

  it("recovers missed work from durable lastFiredAt after restart", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seed(store, trigger("skip", "one"), runner, "skipped")
          results.length = 0

          yield* TestClock.setTime(hour)
          yield* Effect.scoped(
            Effect.gen(function*() {
              const scheduler = yield* Scheduler.make().pipe(
                Effect.provideService(Scheduler.Runner, runner.service)
              )
              yield* scheduler.runOnce
              yield* Effect.yieldNow
            })
          )
          runner.active.clear()

          yield* TestClock.setTime(3 * hour)
          yield* Effect.scoped(
            Effect.gen(function*() {
              const scheduler = yield* Scheduler.make().pipe(
                Effect.provideService(Scheduler.Runner, runner.service)
              )
              yield* scheduler.runOnce
              yield* Effect.yieldNow
            })
          )
        }),
        results
      )
    )

    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(3 * hour).toISOString()}`
    ])
  })

  it("allows only one claim winner across two competing schedulers", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("skip", "one"), runner, "skipped")
            results.length = 0
            yield* TestClock.setTime(hour)
            const first = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            const second = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* Effect.all([first.runOnce, second.runOnce], {
              concurrency: "unbounded",
              discard: true
            })
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(1)
    expect(results.filter((result) => result.outcome === "launched")).toHaveLength(1)
  })

  it("records launch failure and advances to the next occurrence", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture(1)
    let lastFiredAt: number | undefined
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("skip", "one"), runner, "skipped")
            results.length = 0
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )

            yield* TestClock.setTime(hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            lastFiredAt = (yield* store.get("hourly")).pipe(
              (option) => option._tag === "Some" ? option.value.lastFiredAt : undefined
            )
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(2)
    expect(results.some((result) => result.outcome === "failed")).toBe(true)
    expect(results.some((result) => result.outcome === "launched")).toBe(true)
    expect(lastFiredAt).toBe(2 * hour)
  })

  it("does not dispatch after an interrupted claim", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* seed(store, trigger("skip", "one"), runner, "skipped")
            results.length = 0
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const blocked = TriggerStore.TriggerStore.of({
              ...store,
              claimFire: (fire) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(store.claimFire(fire))
                )
            })
            yield* TestClock.setTime(hour)
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(TriggerStore.TriggerStore, blocked),
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            const fiber = yield* Effect.forkScoped(scheduler.runOnce)
            yield* Deferred.await(entered)
            yield* Fiber.interrupt(fiber)
            yield* Deferred.succeed(release, undefined)
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  it("uses Control planning and leaves approval-required plans parked", async () => {
    const calls: Array<string> = []
    let runAttempts = 0
    const control = Layer.succeed(
      Control.Control,
      Control.make({
        plan: (input) =>
          Effect.sync(() => {
            calls.push("plan")
            return {
              planId: "plan-1",
              flowId: input.flowId,
              digest: "digest",
              inputSummary: "input",
              envelope: { capabilities: [], flows: [], budget: {} },
              deployClass: true,
              nodes: [],
              approval: {
                target: {
                  _tag: "Plan" as const,
                  planId: "plan-1",
                  digest: "digest",
                  envelope: { capabilities: [], flows: [], budget: {} }
                },
                scope: "run" as const,
                idempotencyKey: "approval"
              }
            }
          }),
        run: () =>
          Effect.sync(() => {
            calls.push("run")
            runAttempts++
            return runAttempts === 1
              ? {
                _tag: "Parked" as const,
                receiptId: "parked",
                planId: "plan-1",
                status: "waiting-approval" as const
              }
              : {
                _tag: "Accepted" as const,
                receiptId: "started",
                runId: "run-1"
              }
          }),
        approve: () =>
          Effect.sync(() => {
            calls.push("approve")
            return { _tag: "Accepted" as const, receiptId: "approved" }
          }),
        deny: () => Effect.die("unused"),
        steer: () => Effect.die("unused"),
        signal: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        resume: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        watch: () => Stream.empty
      })
    )
    const runId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runner = yield* Scheduler.Runner
          const fiber = yield* Effect.forkScoped(
            runner.start({
              flowId: "flow",
              input: {},
              idempotencyKey: "trigger:occurrence"
            })
          )
          yield* TestClock.adjust("1 second")
          return yield* Fiber.join(fiber)
        })
      ).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provide(
          Scheduler.layerControlRunner.pipe(Layer.provide(control))
        )
      )
    )

    expect(runId).toBe("run-1")
    expect(calls).toEqual(["plan", "run", "run"])
    expect(calls).not.toContain("approve")
  })

  // The store orders due triggers by id, so an aborting trigger takes every
  // trigger after it alphabetically down with it. The in-memory store is used
  // as the durable store's stand-in for a row written before registration
  // refused an unsatisfiable expression.
  it("keeps one failing trigger from silencing the triggers after it", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* store.register({ ...trigger("skip", "none"), id: "a-february-30", cron: "0 0 30 2 *" })
            yield* store.register({ ...trigger("skip", "none"), id: "b-hourly" })
            yield* TestClock.setTime(hour + 30 * 60 * 1_000)
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )

    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `b-hourly:${new Date(2 * hour).toISOString()}`
    ])
  })

  it("keeps the supervisor polling after a tick fails", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    let dueCalls = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* store.register(trigger("skip", "none"))
          const failing = TriggerStore.TriggerStore.of({
            ...store,
            // The first tick dies the way an exhausted occurrence search used
            // to: a defect, which `Effect.catch` does not handle.
            listEnabled: () =>
              dueCalls++ === 0 ? Effect.die(new Error("Unable to find cron date")) : store.listEnabled()
          })
          // A minute and a half before the hour, so the tick after the failing
          // one establishes the watermark and the tick after that crosses the
          // boundary and fires. A supervisor that stopped at the defect never
          // reaches either.
          yield* TestClock.setTime(hour - 90_000)
          yield* Effect.provide(
            TestClock.adjust("2 minutes").pipe(Effect.andThen(Effect.yieldNow)),
            Scheduler.layer({ pollInterval: "1 minute" }).pipe(
              Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(failing)),
              Layer.provide(Layer.succeed(Scheduler.Runner)(runner.service))
            )
          )
        })
      ).pipe(
        Effect.provide(TestTriggers.layer),
        Effect.provide(TestClock.layer())
      )
    )

    expect(dueCalls).toBeGreaterThan(1)
    expect(runner.starts).toHaveLength(1)
    expect(results).toHaveLength(0)
  })

  // A trigger that has never fired owes nothing for the occurrence that
  // happened to pass before it existed: `catchUp: "none"` says exactly that.
  // The first poll establishes the watermark, and the trigger fires from the
  // next boundary.
  it("establishes a watermark without firing a stale occurrence on a new trigger's first poll", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture()
    await Effect.runPromise(
      provideTest(
        Effect.scoped(
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            yield* store.register(trigger("skip", "none"))
            yield* TestClock.setTime(hour + 30 * 60 * 1_000)
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            expect(runner.starts).toHaveLength(0)

            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        ),
        results
      )
    )
    expect(runner.starts).toHaveLength(1)
    expect(runner.starts[0]?.idempotencyKey).toBe(
      `hourly:${new Date(2 * hour).toISOString()}`
    )
  })
})
