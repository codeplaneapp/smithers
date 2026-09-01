import * as EffectVitest from "@effect/vitest"
import * as Journal from "@smthrs/journal"
import { Clock, Context, Effect, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as TestLayers from "../src/TestLayers.ts"
import { describe, expect, it, testEffect } from "../src/Vitest.ts"

const Counter = Context.Service<{ readonly ref: Ref.Ref<number> }>("flows/testing/Vitest.test/Counter")
const counterLayer = Layer.effect(Counter, Effect.map(Ref.make(0), (ref) => ({ ref })))
const test = testEffect(counterLayer)
const unitTest = testEffect(TestLayers.unit(EngineSubject.layerNoop()))

describe("Vitest", () => {
  // Importing this module used to write `scoped` into `@effect/vitest`'s own
  // exported `it`. That module is externalized and shared across every test
  // file in a worker process, so the library's own `it.scoped` was replaced
  // for every other file in the worker.
  it("leaves the peer dependency's own it.scoped alone", () => {
    expect(EffectVitest.it.scoped).not.toBe(EffectVitest.it.effect)
    expect(it.scoped).toBe(EffectVitest.it.effect)
    expect(it).not.toBe(EffectVitest.it)
  })

  it.effect("runs Effect test bodies", () => Effect.sync(() => expect(true).toBe(true)))

  it.effect("surfaces failed Effects as test failures", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Effect.fail("expected failure"))
      expect(exit._tag).toBe("Failure")
    }))

  test.effect("adjusts virtual time", () =>
    Effect.gen(function*() {
      const before = yield* Clock.currentTimeMillis
      yield* TestClock.adjust("1 second")
      const after = yield* Clock.currentTimeMillis
      expect(after - before).toBe(1_000)
    }))

  test.scoped("runs scoped finalizers", () =>
    Effect.gen(function*() {
      const ref = yield* Counter
      yield* Effect.addFinalizer(() => Ref.set(ref.ref, 1))
      yield* Ref.update(ref.ref, (value) => value + 10)
    }))

  test.effect("builds a fresh environment per test (no shared layer state)", () =>
    Effect.gen(function*() {
      const counter = yield* Counter
      // The previous test mutated its Counter; a fresh layer build per test
      // means this test observes the initial value, not the mutation.
      expect(yield* Ref.get(counter.ref)).toBe(0)
    }))

  unitTest.effect("provides the deterministic Host, Journal, and Engine bundle", () =>
    Effect.gen(function*() {
      const engine = yield* EngineSubject.EngineSubject
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const journal = yield* Journal.Journal.Journal
      expect(engine.name).toBe("unavailable")
      expect(yield* spawner.exitCode(ChildProcess.make("unlisted", { shell: true }))).toBe(127)
      expect(journal.emitDurable).toBeTypeOf("function")
    }))
})
