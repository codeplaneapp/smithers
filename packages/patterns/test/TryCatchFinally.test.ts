import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import { PatternError } from "../src/PatternError.ts"
import * as TryCatchFinally from "../src/TryCatchFinally.ts"

class Timeout extends Schema.TaggedError<Timeout>()("Timeout", { seconds: Schema.Number }) {}
class Denied extends Schema.TaggedError<Denied>()("Denied", { who: Schema.String }) {}

// Each flow echoes its own name, so a built graph can name the flow behind
// every `FlowCall` node.
const named = (name: string) =>
  Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: Node.capture({ name }, () => Node.succeed({ from: name }))
  })

const flowName = (graph: Graph.Graph, callId: string): string => {
  const body = Graph.nodes(graph).find((node) => node.id === `${callId}.flow`)?.keyMaterial.body
  return (body as { readonly value: { readonly from: string } }).value.from
}

const calledFlows = (graph: Graph.Graph): ReadonlyArray<string> =>
  Graph.nodes(graph)
    .filter((node) => node.kind === "FlowCall")
    .map((call) => flowName(graph, call.id))

const kindsById = (graph: Graph.Graph): Readonly<Record<string, string>> =>
  Object.fromEntries(Graph.nodes(graph).map((node) => [node.id, node.kind]))

describe("TryCatchFinally", () => {
  it("declares a filtered catch and a finalizer on both arms", () => {
    const graph = Graph.build(
      TryCatchFinally.make({
        try: named("try"),
        catch: named("catch"),
        catchErrors: Timeout,
        finally: named("finally")
      }),
      "request"
    )
    const catches = Graph.nodes(graph).filter((node) => node.kind === "Catch")

    expect(calledFlows(graph)).toEqual(["try", "catch", "finally", "finally"])
    expect(catches).toHaveLength(2)
    expect((catches[0]?.keyMaterial.body as { readonly error?: unknown }).error).toBeUndefined()
    expect((catches[1]?.keyMaterial.body as { readonly error?: unknown }).error).toBeDefined()
  })

  // The outer boundary exists to catch what the BODY raised. The success-arm
  // finalizer must sit outside it: inside, a finalizer that fails on the
  // success path would be caught by the boundary that then calls the finalizer
  // a second time and re-raises: a topology `run` does not implement, which
  // calls the finalizer exactly once and maps that case to `finalizer_failed`.
  it("keeps the success-arm finalizer outside the unhandled-failure boundary", () => {
    const graph = Graph.build(
      TryCatchFinally.make({
        try: named("try"),
        catch: named("catch"),
        catchErrors: Timeout,
        finally: named("finally")
      }),
      "request"
    )
    const kinds = kindsById(graph)
    const boundary = Graph.nodes(graph).filter((node) => node.kind === "Catch").map((node) => node.id).sort()

    // Root sequences the boundary into the success-arm finalizer, so the
    // finalizer is downstream of the boundary rather than protected by it.
    expect(kinds["root"]).toBe("AndThen")
    expect(kinds["root.andThen"]).toBe("Catch")
    // What the outer boundary protects is the try/catch node itself.
    expect(kinds["root.andThen.catch"]).toBe("Catch")
    expect(boundary).toEqual(["root.andThen", "root.andThen.catch"])
    // The success-arm finalizer is the root's continuation, outside the catch.
    expect(flowName(graph, "root.then.map")).toBe("finally")
    // The unhandled arm still calls the finalizer and re-raises.
    expect(flowName(graph, "root.andThen.recover.andThen")).toBe("finally")
    expect(kinds["root.andThen.recover.then"]).toBe("Fail")
  })

  it("declares the unhandled arm as a re-raise", () => {
    const graph = Graph.build(
      TryCatchFinally.make({ try: named("try"), finally: named("finally") }),
      "request"
    )

    expect(calledFlows(graph)).toEqual(["try", "finally", "finally"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Fail")).toHaveLength(1)
  })

  it("declares nothing extra without a catch or a finalizer", () => {
    const graph = Graph.build(TryCatchFinally.make({ try: named("try") }), "request")

    expect(calledFlows(graph)).toEqual(["try"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(0)
  })

  it("declares an unfiltered catch when no error schema is supplied", () => {
    const graph = Graph.build(TryCatchFinally.make({ try: named("try"), catch: named("catch") }), "request")

    expect(calledFlows(graph)).toEqual(["try", "catch"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(1)
  })

  it("refuses a declaration that filters errors without a catch", () => {
    let refusal: unknown
    try {
      TryCatchFinally.make({ try: named("try"), catchErrors: Timeout })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(PatternError)
    expect((refusal as PatternError).code).toBe("invalid_decorator")
    expect((refusal as PatternError).message).toBe("TryCatchFinally catchErrors requires catch")
  })

  // Content-addressed step identity requires that the same declaration key the
  // same way every time it is built. A recovery arm written as a bare arrow
  // takes `sha256-source-ephemeral/v4` identity, whose digest folds in a
  // per-process nonce and a fresh ordinal for every closure the body creates,
  // so a second build of the same boundary would key differently.
  it("builds the same key material twice", () => {
    const boundary = TryCatchFinally.make({
      try: named("try"),
      catch: named("catch"),
      catchErrors: Timeout,
      finally: named("finally")
    })
    const material = () => Graph.nodes(Graph.build(boundary, "request")).map((node) => node.keyMaterial)
    const handlers = Graph.nodes(Graph.build(boundary, "request"))
      .filter((node) => node.kind === "Catch")
      .map((node) => (node.keyMaterial.body as { readonly handler: { readonly algorithm: string } }).handler.algorithm)

    expect(material()).toEqual(material())
    expect(handlers).toEqual(["sha256-source-captures/v4", "sha256-source-captures/v4"])
  })

  it.effect("runs the finalizer once after a successful body", () =>
    Effect.gen(function*() {
      let finalized = 0
      const value = yield* TryCatchFinally.run("request", {
        try: (input) => Effect.succeed(`${input}-ok`),
        finally: () =>
          Effect.sync(() => {
            finalized = finalized + 1
          })
      })

      expect(value).toBe("request-ok")
      expect(finalized).toBe(1)
    }))

  it.effect("defers protected body construction and rebuilds it for every execution", () =>
    Effect.gen(function*() {
      let constructions = 0
      const protectedBody = TryCatchFinally.run("request", {
        try: (input) => {
          constructions += 1
          return Effect.succeed(`${input}-${constructions}`)
        }
      })

      expect(constructions).toBe(0)
      expect(yield* protectedBody).toBe("request-1")
      expect(constructions).toBe(1)
      expect(yield* protectedBody).toBe("request-2")
      expect(constructions).toBe(2)
    }))

  it.effect("reports a synchronously thrown body factory as a defect and still finalizes", () =>
    Effect.gen(function*() {
      const defect = new Error("factory exploded")
      let finalized = false
      const protectedBody = TryCatchFinally.run("request", {
        try: (): Effect.Effect<never> => {
          throw defect
        },
        finally: () =>
          Effect.sync(() => {
            finalized = true
          })
      })

      expect(finalized).toBe(false)
      const exit = yield* Effect.exit(protectedBody)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Die")).toMatchObject({
          _tag: "Die",
          defect
        })
      }
      expect(finalized).toBe(true)
    }))

  it.effect("recovers a matching failure and still runs the finalizer", () =>
    Effect.gen(function*() {
      let finalized = 0
      const value = yield* TryCatchFinally.run("request", {
        try: () => Effect.fail(new Timeout({ seconds: 30 })),
        catchErrors: (error) => error._tag === "Timeout",
        catch: (error) => Effect.succeed(`recovered-${error.seconds}`),
        finally: () =>
          Effect.sync(() => {
            finalized = finalized + 1
          })
      })

      expect(value).toBe("recovered-30")
      expect(finalized).toBe(1)
    }))

  it.effect("propagates a non-matching failure and still runs the finalizer", () =>
    Effect.gen(function*() {
      let finalized = 0
      let handled = 0
      const exit = yield* Effect.exit(
        TryCatchFinally.run("request", {
          try: (): Effect.Effect<string, Timeout | Denied> => Effect.fail(new Denied({ who: "root" })),
          catchErrors: (error) => error._tag === "Timeout",
          catch: () =>
            Effect.sync(() => {
              handled = handled + 1
              return "recovered"
            }),
          finally: () =>
            Effect.sync(() => {
              finalized = finalized + 1
            })
        })
      )

      expect(exit._tag).toBe("Failure")
      expect(handled).toBe(0)
      expect(finalized).toBe(1)
    }))

  it.effect("fails finalizer_failed when the finalizer fails after a successful body", () =>
    Effect.gen(function*() {
      const finalizerError = new Denied({ who: "cleanup" })
      const error = yield* Effect.flip(
        TryCatchFinally.run("request", {
          try: () => Effect.succeed("ok"),
          finally: () => Effect.fail(finalizerError)
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("finalizer_failed")
      expect((error as PatternError).message).toBe(
        "The TryCatchFinally finalizer failed after the protected body succeeded"
      )
      expect((error as PatternError).cause).toEqual(finalizerError)
    }))

  it.effect("returns the protected body directly when no finalizer is configured", () =>
    Effect.gen(function*() {
      const value = yield* TryCatchFinally.run("request", {
        try: (input) => Effect.succeed(`${input}-ok`)
      })

      expect(value).toBe("request-ok")
    }))

  it.effect("refuses a runtime filter without a catch before the body runs", () =>
    Effect.gen(function*() {
      let ran = 0
      const error = yield* Effect.flip(
        TryCatchFinally.run("request", {
          try: (): Effect.Effect<string, Timeout> => Effect.sync(() => (ran += 1, "ok")),
          catchErrors: () => true
        })
      )

      expect(error).toBeInstanceOf(PatternError)
      expect((error as PatternError).code).toBe("invalid_decorator")
      expect((error as PatternError).message).toBe("TryCatchFinally catchErrors requires catch")
      expect(ran).toBe(0)
    }))

  it.effect("keeps the body failure when the finalizer fails too", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        TryCatchFinally.run("request", {
          try: () => Effect.fail(new Denied({ who: "root" })),
          finally: () => Effect.fail(new Timeout({ seconds: 1 }))
        })
      )

      expect(error).toBeInstanceOf(Denied)
    }))

  it.effect("runs the finalizer when the body is interrupted", () =>
    Effect.gen(function*() {
      let finalized = 0
      const fiber = yield* Effect.forkChild(
        TryCatchFinally.run("request", {
          try: () => Effect.never,
          finally: () =>
            Effect.sync(() => {
              finalized = finalized + 1
            })
        }),
        { startImmediately: true }
      )
      yield* Fiber.interrupt(fiber)

      expect(finalized).toBe(1)
    }))
})
