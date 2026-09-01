import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as SqlTriggerStore from "../src/SqlTriggerStore.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000

interface RunnerFixture {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
  readonly active: Set<string>
  readonly cancelled: Array<string>
  readonly inspected: Array<string>
}

const runnerFixture = (
  overrides: Partial<Scheduler.RunnerService> = {}
): RunnerFixture => {
  const starts: Array<Scheduler.StartInput> = []
  const active = new Set<string>()
  const cancelled: Array<string> = []
  const inspected: Array<string> = []
  return {
    starts,
    active,
    cancelled,
    inspected,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.sync(() => {
          starts.push(input)
          const runId = `run-${starts.length}`
          active.add(runId)
          return runId
        }),
      isActive: (runId) =>
        Effect.sync(() => {
          inspected.push(runId)
          return active.has(runId)
        }),
      cancel: (runId) =>
        Effect.sync(() => {
          cancelled.push(runId)
          active.delete(runId)
        }),
      ...overrides
    })
  }
}

const trigger = (
  overlap: Trigger["overlap"] = "skip",
  catchUp: Trigger["catchUp"] = "one",
  maxCatchUp = 3
): Trigger => ({
  id: "hourly",
  flowId: "flow",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap,
  catchUp,
  maxCatchUp,
  enabled: true
})

const seedFired = (store: TriggerStore.Service, declaration: Trigger) =>
  Effect.gen(function*() {
    const registered = yield* store.register(declaration)
    yield* store.claimFire({
      triggerId: declaration.id,
      occurrence: 0,
      expectedRevision: registered.revision
    })
    yield* store.recordResult({ triggerId: declaration.id, occurrence: 0, outcome: "skipped" })
    return registered
  })

const inMemory = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(TestTriggers.layer), Effect.provide(TestClock.layer()))
  )

describe("Scheduler recovery", () => {
  // The watermark used to advance before the work it gates, so a transient
  // claim failure was logged, abandoned, and never recomputed: the next tick
  // saw the occurrence as already observed and returned nothing.
  it("re-claims an occurrence whose claim failed rather than losing it", async () => {
    const runner = runnerFixture()
    let claims = 0
    const starts = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "one"))
          const flaky = TriggerStore.TriggerStore.of({
            ...store,
            claimFire: (fire) =>
              claims++ === 0
                ? Effect.fail(new TriggerError({ code: "store", message: "claim write failed" }))
                : store.claimFire(fire)
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, flaky),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          expect(runner.starts).toHaveLength(0)

          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return runner.starts
        })
      )
    )
    expect(claims).toBe(2)
    expect(starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  // The buffered occurrence is taken out of the row before it can be claimed.
  // A failure in between leaves nothing to re-derive it from, so the take is
  // re-armed on failure.
  it("re-arms a buffered occurrence when the claim after the take fails", async () => {
    const runner = runnerFixture()
    let resumes = 0
    const outcome = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* seedFired(store, trigger("buffer-one", "none"))
          yield* store.setPending({ triggerId: "hourly", occurrence: hour })
          const flaky = TriggerStore.TriggerStore.of({
            ...store,
            claimFire: (fire) =>
              fire.resumeBuffered === true && resumes++ === 0
                ? Effect.fail(new TriggerError({ code: "store", message: "claim write failed" }))
                : store.claimFire(fire)
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, flaky),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          expect(runner.starts).toHaveLength(0)
          const rearmed = yield* store.takePending("hourly")
          yield* store.setPending({ triggerId: "hourly", occurrence: hour })

          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return { rearmed, starts: runner.starts, revision: registered.revision }
        })
      )
    )
    expect(outcome.rearmed).toMatchObject({ _tag: "Some", value: hour })
    expect(outcome.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`
    ])
  })

  // A reservation is not a run: the runner has never heard of it, so asking
  // answers "not active" for a launch that is still in flight. Only its lease
  // may release it, and only the store enforces that.
  it("keeps a recovered launch reservation across ticks without asking the runner", async () => {
    const runner = runnerFixture()
    const outcome = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(trigger("skip", "one"))
          // The reservation another incarnation wrote while it was inside
          // `runner.start`.
          yield* store.claimFire({
            triggerId: "hourly",
            occurrence: 0,
            expectedRevision: registered.revision
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          const afterFirst = yield* store.activeRun("hourly")
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return { afterFirst, afterSecond: yield* store.activeRun("hourly") }
        })
      )
    )
    const reservation = TriggerStore.reservationId("hourly", 0)
    expect(outcome.afterFirst).toMatchObject({ _tag: "Some", value: reservation })
    expect(outcome.afterSecond).toMatchObject({ _tag: "Some", value: reservation })
    expect(runner.starts).toHaveLength(0)
    expect(runner.inspected).not.toContain(reservation)
  })

  // The runs are durable and outlive this process. Closing the scope must
  // detach the monitors, never cancel what they were watching: a deploy would
  // otherwise cancel every scheduled run it found in flight.
  it("detaches run monitors on scope closure instead of cancelling the runs", async () => {
    const runner = runnerFixture()
    await inMemory(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* seedFired(store, trigger("skip", "one"))
        yield* TestClock.setTime(hour)
        yield* Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make().pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            expect(runner.starts).toHaveLength(1)
          })
        )
      })
    )
    expect(runner.cancelled).toEqual([])
    expect(runner.active.has("run-1")).toBe(true)
  })

  it("cancels a superseded run exactly once", async () => {
    const runner = runnerFixture()
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("supersede", "one"))
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
      )
    )
    expect(runner.cancelled).toEqual(["run-1"])
  })

  // A bound the declaration cannot honour is a statement about how much
  // history to replay, not a reason to stop scheduling.
  it("abandons a backlog beyond its bound and keeps scheduling", async () => {
    const runner = runnerFixture()
    const starts = await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "all", 2))
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(10 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          expect(runner.starts).toHaveLength(0)

          yield* TestClock.setTime(11 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          return runner.starts
        })
      )
    )
    expect(starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(11 * hour).toISOString()}`
    ])
  })

  it("records a monitor failure against the run it was watching", async () => {
    let polls = 0
    const runner = runnerFixture({
      isActive: () =>
        polls++ === 0
          ? Effect.fail(new TriggerError({ code: "runner", message: "Control could not inspect run" }))
          : Effect.succeed(false)
    })
    const results: Array<TriggerStore.Result> = []
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "one"))
          const recording = TriggerStore.TriggerStore.of({
            ...store,
            recordResult: (result) =>
              Effect.sync(() => {
                results.push(result)
              }).pipe(Effect.andThen(store.recordResult(result)))
          })
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, recording),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(results).toContainEqual({
      triggerId: "hourly",
      occurrence: hour,
      outcome: "failed",
      error: "Control could not inspect run",
      runId: "run-1"
    })
  })

  it("skips an occurrence while its own launch is still in flight", async () => {
    const runner = runnerFixture()
    const results: Array<TriggerStore.Result> = []
    await inMemory(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* seedFired(store, trigger("skip", "one"))
          const recording = TriggerStore.TriggerStore.of({
            ...store,
            recordResult: (result) =>
              Effect.sync(() => {
                results.push(result)
              }).pipe(Effect.andThen(store.recordResult(result)))
          })
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, recording),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(2 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      )
    )
    expect(runner.starts).toHaveLength(1)
    expect(results.filter((result) => result.outcome === "skipped")).toHaveLength(1)
  })
})

describe("Scheduler revision fencing", () => {
  const registered = (revision: number): TriggerStore.Registered => ({
    ...trigger("skip", "one"),
    revision,
    lastFiredAt: 0
  })

  const fenced = (
    stored: Option.Option<TriggerStore.Registered>,
    claims: Array<number>
  ): TriggerStore.Service =>
    TriggerStore.makeNoop({
      listEnabled: () => Effect.succeed([registered(1)]),
      get: () => Effect.succeed(stored),
      activeRun: () => Effect.succeed(Option.none()),
      takePending: () => Effect.succeed(Option.none()),
      recordResult: () => Effect.void,
      clearActive: () => Effect.void,
      claimFire: (fire) =>
        Effect.suspend(() => {
          claims.push(fire.expectedRevision)
          return fire.expectedRevision === 2
            ? Effect.succeed({
              claimed: true as const,
              action: "fire" as const,
              reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
            })
            : Effect.fail(
              new TriggerError({ code: "revision_mismatch", message: "trigger hourly is at revision 2" })
            )
        })
    })

  const tick = (store: TriggerStore.Service, runner: RunnerFixture) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )

  // A claim is fenced on the declaration the occurrence was computed from. One
  // refresh and one retry is enough: the next tick re-reads anyway.
  it("refreshes the declaration once and retries the claim", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    await tick(fenced(Option.some(registered(2)), claims), runner)
    expect(claims).toEqual([1, 2])
    expect(runner.starts).toHaveLength(1)
  })

  it("gives up when the refreshed declaration is the one it already had", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    await tick(fenced(Option.some(registered(1)), claims), runner)
    expect(claims).toEqual([1])
    expect(runner.starts).toHaveLength(0)
  })

  it("gives up when the trigger is gone by the time it re-reads", async () => {
    const claims: Array<number> = []
    const runner = runnerFixture()
    await tick(fenced(Option.none(), claims), runner)
    expect(claims).toEqual([1])
    expect(runner.starts).toHaveLength(0)
  })
})

describe("Scheduler over real SQLite", () => {
  const declaration = trigger("skip", "one")
  const database = TestDatabase.layer
  const store = SqlTriggerStore.layer.pipe(Layer.provide(database))

  // A restart is two schedulers over one database. The second one has no
  // in-process state at all, so everything it knows about the run in flight it
  // has to read back out of the store.
  it("re-attaches to a run in flight after the process that started it dies", async () => {
    const runner = runnerFixture()
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const triggers = yield* TriggerStore.TriggerStore
        yield* triggers.register(declaration)
        yield* TestClock.setTime(hour)

        yield* Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* TestClock.setTime(2 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
          })
        )
        const acrossDeath = yield* triggers.activeRun(declaration.id)

        yield* TestClock.setTime(3 * hour)
        const afterRestart = yield* Effect.scoped(
          Effect.gen(function*() {
            const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
              Effect.provideService(Scheduler.Runner, runner.service)
            )
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            const held = yield* triggers.activeRun(declaration.id)
            runner.active.clear()
            yield* TestClock.setTime(4 * hour)
            yield* scheduler.runOnce
            yield* Effect.yieldNow
            return held
          })
        )
        return { acrossDeath, afterRestart, cursor: yield* triggers.get(declaration.id) }
      }).pipe(Effect.provide(store), Effect.provide(TestClock.layer()))
    )

    expect(outcome.acrossDeath).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(outcome.afterRestart).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(runner.cancelled).toEqual([])
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(2 * hour).toISOString()}`,
      `hourly:${new Date(4 * hour).toISOString()}`
    ])
    expect(
      outcome.cursor._tag === "Some" ? outcome.cursor.value.lastFiredAt : undefined
    ).toBe(4 * hour)
  })
})

describe("Scheduler dispatch edges", () => {
  const base: TriggerStore.Registered = { ...trigger("skip", "one"), revision: 1, lastFiredAt: 0 }

  const scripted = (
    overrides: Partial<TriggerStore.Service>,
    stored: TriggerStore.Registered = base
  ): TriggerStore.Service =>
    TriggerStore.makeNoop({
      listEnabled: () => Effect.succeed([stored]),
      get: () => Effect.succeed(Option.some(stored)),
      activeRun: () => Effect.succeed(Option.none()),
      takePending: () => Effect.succeed(Option.none()),
      recordResult: () => Effect.void,
      clearActive: () => Effect.void,
      setPending: () => Effect.void,
      claimFire: (fire) =>
        Effect.succeed({
          claimed: true as const,
          action: "fire" as const,
          reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
        }),
      ...overrides
    })

  const tick = (
    store: TriggerStore.Service,
    runner: RunnerFixture,
    at: number = hour,
    options: Scheduler.Options = {}
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make(options).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(at)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )

  it("records a run that finished before the first poll as completed", async () => {
    const results: Array<TriggerStore.Result> = []
    const runner = runnerFixture({ isActive: () => Effect.succeed(false) })
    await tick(
      scripted({
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          })
      }),
      runner
    )
    expect(results.map((result) => result.outcome)).toEqual(["launched", "completed"])
    expect(results[1]).toMatchObject({ runId: "run-1", occurrence: hour })
  })

  it("does nothing when another worker already holds the occurrence", async () => {
    const runner = runnerFixture()
    await tick(scripted({ claimFire: () => Effect.succeed({ claimed: false as const }) }), runner)
    expect(runner.starts).toHaveLength(0)
  })

  // The active run the claim reports may belong to another process entirely,
  // in which case there is no local fiber to interrupt and the store's run id
  // is all this scheduler has to cancel.
  it("supersedes a run this process never launched", async () => {
    const runner = runnerFixture()
    runner.active.add("foreign-run")
    const results: Array<TriggerStore.Result> = []
    const store = scripted({
      claimFire: (fire) =>
        Effect.succeed({
          claimed: true as const,
          action: "supersede" as const,
          reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence),
          activeRunId: "foreign-run"
        }),
      recordResult: (result) =>
        Effect.sync(() => {
          results.push(result)
        })
    }, { ...trigger("supersede", "one"), revision: 1 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(2 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(runner.cancelled).toEqual(["foreign-run"])
    expect(runner.starts).toHaveLength(1)
    // The superseded occurrence belongs to a process this one never met, so
    // there is no occurrence of its own to record the supersession against.
    expect(results.map((result) => result.outcome)).toEqual(["launched"])
  })

  it("re-attaches to a stored run that has no recorded fire cursor", async () => {
    const runner = runnerFixture()
    runner.active.add("foreign-run")
    await tick(
      scripted({ activeRun: () => Effect.succeed(Option.some("foreign-run")) }, {
        ...base,
        lastFiredAt: undefined
      }),
      runner
    )
    expect(runner.inspected).toContain("foreign-run")
    expect(runner.starts).toHaveLength(0)
  })

  // The bound guard is not the only refusal a catch-up computation can raise.
  // A stored bound one greater than the largest safe integer makes the
  // occurrence search itself refuse, and that is not a backlog to abandon.
  it("propagates a catch-up failure that is not a bound refusal", async () => {
    const runner = runnerFixture()
    const results: Array<TriggerStore.Result> = []
    await tick(
      scripted({
        recordResult: (result) =>
          Effect.sync(() => {
            results.push(result)
          })
      }, {
        ...trigger("skip", "all", Number.MAX_SAFE_INTEGER),
        revision: 1,
        lastFiredAt: 0
      }),
      runner
    )
    expect(runner.starts).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  it("fires the backlog and the current occurrence in order", async () => {
    const runner = runnerFixture()
    const store = scripted({}, { ...trigger("supersede", "all"), revision: 1, lastFiredAt: 0 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* TestClock.setTime(4 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(runner.starts.map((input) => input.idempotencyKey)).toEqual([
      `hourly:${new Date(hour).toISOString()}`,
      `hourly:${new Date(2 * hour).toISOString()}`,
      `hourly:${new Date(3 * hour).toISOString()}`,
      `hourly:${new Date(4 * hour).toISOString()}`
    ])
  })

  // The watermark stops at the last occurrence this tick finished dispatching,
  // so the occurrence whose dispatch failed is recomputed on the next tick and
  // the ones before it are not.
  it("advances the watermark only past the occurrences it dispatched", async () => {
    const runner = runnerFixture()
    const claimed: Array<number> = []
    let failures = 1
    const store = scripted({
      claimFire: (fire) =>
        Effect.suspend(() => {
          claimed.push(fire.occurrence)
          if (fire.occurrence === 3 * hour && failures > 0) {
            failures--
            return Effect.fail(new TriggerError({ code: "store", message: "claim write failed" }))
          }
          return Effect.succeed({
            claimed: true as const,
            action: "fire" as const,
            reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
          })
        })
    }, { ...trigger("supersede", "all"), revision: 1, lastFiredAt: 0 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make({ runPollInterval: "1 hour" }).pipe(
            Effect.provideService(TriggerStore.TriggerStore, store),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(3 * hour)
          yield* scheduler.runOnce
          yield* Effect.yieldNow
          yield* scheduler.runOnce
          yield* Effect.yieldNow
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(claimed).toEqual([hour, 2 * hour, 3 * hour, 3 * hour])
  })

  // Interruption is the scope closing, not a trigger failing, so it is
  // re-raised rather than logged and swallowed like an ordinary tick failure.
  it("re-raises an interrupt out of a tick instead of logging it", async () => {
    const runner = runnerFixture()
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function*() {
          const scheduler = yield* Scheduler.make().pipe(
            Effect.provideService(
              TriggerStore.TriggerStore,
              scripted({ claimFire: () => Effect.interrupt })
            ),
            Effect.provideService(Scheduler.Runner, runner.service)
          )
          yield* TestClock.setTime(hour)
          yield* scheduler.runOnce
        })
      ).pipe(Effect.provide(TestClock.layer()))
    )
    expect(exit._tag).toBe("Failure")
    expect(runner.starts).toHaveLength(0)
  })

  it("stops the supervisor when the poll loop itself is interrupted", async () => {
    const runner = runnerFixture()
    let calls = 0
    const store = TriggerStore.makeNoop({
      listEnabled: () =>
        Effect.suspend(() => {
          calls++
          return Effect.interrupt
        })
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.provide(
          TestClock.adjust("5 minutes"),
          Scheduler.layer().pipe(
            Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(store)),
            Layer.provide(Layer.succeed(Scheduler.Runner)(runner.service))
          )
        )
      }).pipe(Effect.provide(TestClock.layer()))
    )
    expect(calls).toBe(1)
  })

  // The claim may report a supersession with nothing to supersede: the run the
  // store knew about settled between the read and the decision.
  it("launches a supersede claim that names no active run", async () => {
    const runner = runnerFixture()
    await tick(
      scripted({
        claimFire: (fire) =>
          Effect.succeed({
            claimed: true as const,
            action: "supersede" as const,
            reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence)
          })
      }),
      runner
    )
    expect(runner.cancelled).toEqual([])
    expect(runner.starts).toHaveLength(1)
  })

  // A prior launch that never got past its reservation has no run for the
  // runtime to cancel; only the store can release the reservation.
  it("never asks the runner to cancel a reservation", async () => {
    const runner = runnerFixture()
    const reservation = TriggerStore.reservationId("hourly", 0)
    runner.active.add(reservation)
    await tick(
      scripted({
        claimFire: (fire) =>
          Effect.succeed({
            claimed: true as const,
            action: "supersede" as const,
            reservationId: TriggerStore.reservationId(fire.triggerId, fire.occurrence),
            activeRunId: reservation
          })
      }),
      runner
    )
    expect(runner.cancelled).toEqual([])
    expect(runner.starts).toHaveLength(1)
  })
})
