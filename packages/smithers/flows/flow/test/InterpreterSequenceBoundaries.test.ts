import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Node, Plan } from "@smthrs/plan"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const First = Action.make("sequence-boundary/First", { payload: {}, success: Schema.Number, error: Schema.String })
const Middle = Action.make("sequence-boundary/Middle", { payload: {}, success: Schema.Number, error: Schema.String })
const Later = Action.make("sequence-boundary/Later", { payload: {}, success: Schema.String })
const Inline = Flow.make("sequence-boundary/Inline", {
  payload: {},
  success: Schema.String,
  body: () => Later.call({})
})
const cases: ReadonlyArray<{ name: string; next: () => Node.Any }> = [
  { name: "all", next: () => Node.all({ left: Later.call({}), right: Node.succeed("constant") }) },
  { name: "map", next: () => Later.call({}).pipe(Node.map((value) => value)) },
  { name: "inline flow", next: () => Inline.call({}) },
  {
    name: "branch",
    next: () =>
      Node.succeed(true).pipe(Node.branch({
        if: (value) => value,
        then: () => Later.call({}),
        else: () => Node.succeed("unused")
      }))
  },
  { name: "catch", next: () => Later.call({}).pipe(Node.catch({ onFailure: () => Node.succeed("unused") })) },
  { name: "nested sequence", next: () => Later.call({}).pipe(Node.andThen(Node.succeed("last"))) }
]

describe("explicit andThen subtree boundaries", () => {
  it.effect("keeps independent children concurrent after the boundary opens", () =>
    withCrypto(Effect.gen(function*() {
      const release = yield* Deferred.make<void>()
      let started = 0
      const implementation = Layer.mergeAll(
        First.toLayer(() => Effect.succeed(1)),
        Later.toLayer(() =>
          Effect.gen(function*() {
            started++
            if (started === 1) yield* Deferred.await(release)
            else yield* Deferred.succeed(release, undefined)
            return "done"
          })
        )
      ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(layerMemory))
      const result = yield* Interpreter.interpret(
        First.call({}).pipe(Node.andThen(Node.all({
          left: Later.call({}),
          right: Later.call({})
        })))
      ).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Inline, "sequence-concurrency")),
        Effect.provide(implementation)
      )
      expect(started).toBe(2)
      expect(result.value).toEqual({ left: "done", right: "done" })
    })))

  it.effect("does not activate the next subtree when the upstream is interrupted", () =>
    withCrypto(Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let later = 0
      const implementation = Layer.mergeAll(
        First.toLayer(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
        Later.toLayer(() =>
          Effect.sync(() => {
            later++
            return "done"
          })
        )
      ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(layerMemory))
      const fiber = yield* Interpreter.interpret(
        First.call({}).pipe(Node.andThen(Node.all({ later: Inline.call({}) })))
      ).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Inline, "sequence-interruption")),
        Effect.provide(implementation),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      expect(later).toBe(0)
    }))))

  for (const { name, next } of cases) {
    for (const fail of [false, true]) {
      it.effect(`${name} starts only after upstream success (${fail ? "failure" : "success"})`, () =>
        withCrypto(Effect.gen(function*() {
          const events: Array<string> = []
          const implementation = Layer.mergeAll(
            First.toLayer(() =>
              Effect.gen(function*() {
                events.push("first:start")
                // Yield scheduler turns, not elapsed time: downstream is already
                // runnable in the broken graph and must remain behind the boundary.
                for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow
                events.push(fail ? "first:failed" : "first:done")
                if (fail) return yield* Effect.fail("upstream failed")
                return 1
              })
            ),
            Later.toLayer(() =>
              Effect.sync(() => {
                events.push("later")
                return "later"
              })
            )
          ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(layerMemory))
          const result = yield* Interpreter.interpret(First.call({}).pipe(Node.andThen(next()))).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Inline, "sequence-boundary")),
            Effect.provide(implementation),
            Effect.exit
          )
          expect(events).toEqual(fail ? ["first:start", "first:failed"] : ["first:start", "first:done", "later"])
          expect(Exit.isFailure(result)).toBe(fail)
        })))
    }

    for (const fail of [false, true]) {
      it.effect(`nested ${name} waits for the nearest prerequisite (${fail ? "failure" : "success"})`, () =>
        withCrypto(Effect.gen(function*() {
          const events: Array<string> = []
          const implementation = Layer.mergeAll(
            First.toLayer(() =>
              Effect.sync(() => {
                events.push("first")
                return 1
              })
            ),
            Middle.toLayer(() =>
              Effect.gen(function*() {
                events.push("middle:start")
                for (let turn = 0; turn < 8; turn++) yield* Effect.yieldNow
                events.push(fail ? "middle:failed" : "middle:done")
                if (fail) return yield* Effect.fail("middle failed")
                return 2
              })
            ),
            Later.toLayer(() =>
              Effect.sync(() => {
                events.push("later")
                return "later"
              })
            )
          ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provideMerge(layerMemory))
          const result = yield* Interpreter.interpret(
            Node.andThen(First.call({}), Node.andThen(Middle.call({}), next()))
          ).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Inline, "nested-sequence-boundary")),
            Effect.provide(implementation),
            Effect.exit
          )
          expect(events).toEqual(
            fail
              ? ["first", "middle:start", "middle:failed"]
              : ["first", "middle:start", "middle:done", "later"]
          )
          expect(Exit.isFailure(result)).toBe(fail)
        })))
    }

    it.effect(`the compiled ${name} subtree retains a dependency path to the explicit prerequisite on every descendant`, () =>
      withCrypto(Effect.gen(function*() {
        const graph = Graph.build(First.call({}).pipe(Node.andThen(next())))
        const plan = yield* Plan.compile({
          planId: `sequence-${name}`,
          flow: "test/Sequence",
          nodes: Graph.drafts(graph)
        })
        const byId = new Map(plan.nodes.map((node) => [node.id, node]))
        for (const node of plan.nodes.filter((node) => node.id.startsWith("root.then"))) {
          // A nested sequence may reach the outer barrier through its nearest
          // prerequisite. Every descendant must still wait for outer success.
          const dependencies = new Set<string>()
          const pending = [...node.dependsOn]
          while (pending.length > 0) {
            const dependency = pending.pop()!
            if (dependencies.has(dependency)) continue
            dependencies.add(dependency)
            pending.push(...byId.get(dependency)!.dependsOn)
          }
          expect(dependencies, node.id).toContain("root.andThen")
        }
      })))
  }
})
