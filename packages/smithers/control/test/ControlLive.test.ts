/**
 * The in-memory `ControlRuntime` against the shared `ControlLive` contract,
 * plus the checks that are specific to this repo's ownership of the modules.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer, Stream } from "effect"
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { PersistenceError } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as TestControl from "../src/test/TestControl.ts"
import { contract, type Stack } from "./ControlContract.ts"
import { live } from "./TestStack.ts"

contract("memory", (executor) => TestControl.layer(undefined, executor) as unknown as Layer.Layer<Stack>)

describe("ControlLive", () => {
  it("repairs a failed memory plan creation event exactly once on keyed retry", async () => {
    let fail = true
    const journal = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (base) =>
        Journal.make({
          ...base,
          emitDurableUnfenced: (input) =>
            Effect.suspend(() => {
              if (fail) {
                fail = false
                return Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "injected failure" }))
              }
              return base.emitDurableUnfenced(input)
            })
        }))
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const request = { flowId: "system/test", input: {}, idempotencyKey: "retry:plan" }
        const failure = yield* Effect.flip(control.plan(request))
        const card = yield* control.plan(request)
        const replay = yield* control.plan(request)
        const events = yield* control.watch({ follow: false }).pipe(Stream.runCollect)
        return { failure, card, replay, events }
      }).pipe(Effect.provide(live({ journal })), Effect.scoped, Effect.orDie)
    )

    expect(observed.failure).toBeInstanceOf(PersistenceError)
    expect(observed.replay).toEqual(observed.card)
    expect(observed.events.filter((event) => event.kind === "control.plan.created")).toHaveLength(1)
  })

  it("finds a repaired creation beyond the first journal page without duplicating it", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const control = yield* Control
        const journal = yield* Journal.Journal
        const request = { flowId: "system/test", input: {}, idempotencyKey: "paged:plan" }
        const { card } = yield* runtime.plan(request)
        const runId = JournalEvent.RunId.make(`plan:${card.planId}`)
        // An older plan can have other entries before its creation is repaired.
        // An event from another producer is not the control plane's creation.
        for (let index = 0; index < 1024; index++) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId,
              sourceId: JournalEvent.SourceId.make(index === 0 ? "/control" : "/other"),
              eventType: index === 0 ? "control.approval.approved" : "control.plan.created",
              payload: { index }
            })
          )
        }
        yield* control.plan(request)
        const replay = yield* control.plan(request)
        const tail = yield* journal.entries({ runId, after: JournalEvent.Seq.make(1023), limit: 10 })
        return { card, replay, tail }
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.orDie)
    )

    expect(observed.replay).toEqual(observed.card)
    expect(observed.tail.entries.map((entry) => [entry.sourceId, entry.eventType])).toEqual([
      ["/control", "control.plan.created"]
    ])
  })

  it.each(["transact", "entries"] as const)("reports plan %s failures as persistence errors", async (operation) => {
    const journal = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (base) =>
        Journal.make({
          ...base,
          [operation]: () => Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "injected failure" }))
        }))
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const control = yield* Control
        const request = { flowId: "system/test", input: {}, idempotencyKey: "failed:plan" }
        yield* runtime.plan(request)
        return yield* Effect.flip(control.plan(request))
      }).pipe(Effect.provide(live({ journal })), Effect.scoped, Effect.orDie)
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("plan")
  })

  it("owned modules contain no Node or platform-node imports", () => {
    const files = [
      "src/Control.ts",
      "src/ControlRuntime.ts",
      "src/ControlLive.ts",
      "src/SqlControlRuntime.ts",
      "src/internal/planning.ts",
      "src/test/TestControl.ts",
      "test/ControlContract.ts"
    ]
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
      expect(source, file).not.toMatch(/(?:from|import\s*)\s*["']node:/)
      expect(source, file).not.toContain(["@effect", "platform-node"].join("/"))
    }
  })
})
