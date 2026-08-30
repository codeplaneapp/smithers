import { describe, it } from "@effect/vitest"
import { Flow, Graph, Node } from "@smthrs/core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Latch from "effect/Latch"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Sidecar from "../src/Sidecar.ts"

const flowNamed = (capability: string): Flow.Any =>
  Flow.make({
    name: capability,
    capabilities: [capability],
    input: Schema.Unknown,
    output: Schema.Unknown,
    body: (input) => Node.succeed(input)
  })

const primary = flowNamed("sidecar/primary")
const shadow = flowNamed("sidecar/shadow")
const score = flowNamed("sidecar/score")

const callsTo = (graph: Graph.Graph, capability: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    node.kind === "FlowCall" &&
    (node.keyMaterial.body as { readonly capabilities?: ReadonlyArray<string> }).capabilities?.includes(capability) ===
      true
  )

describe("Sidecar", () => {
  it("declares the primary and the shadow as one concurrent All", () => {
    const pattern = Sidecar.make({ primary, shadow })
    const graph = Graph.build(pattern, "prompt")

    expect(Flow.isFlow(pattern)).toBe(true)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
    expect(callsTo(graph, "sidecar/primary")).toHaveLength(1)
    expect(callsTo(graph, "sidecar/shadow")).toHaveLength(1)
    expect(callsTo(graph, "sidecar/score")).toHaveLength(0)
  })

  it("puts the shadow behind a catch and leaves the primary bare", () => {
    const graph = Graph.build(Sidecar.make({ primary, shadow }), "prompt")

    // One arm, on the shadow. A sidecar is not a fallback ladder: a failed
    // primary is a failed run, so the primary must not gain an arm of its own.
    expect(Graph.nodes(graph).filter((node) => node.kind === "Catch")).toHaveLength(1)
    expect(Graph.nodes(graph).find((node) => node.id.endsWith("all.shadow.recover"))?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: { error: { _tag: "PlannedInput", path: [] }, quarantined: true }
    })
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("hands the scorer the pair run hands it", () => {
    const graph = Graph.build(Sidecar.make({ primary, shadow, score }), "prompt")

    // The scorer reads the shadow's VALUE, not its quarantine wrapper, so the
    // declared scorer input is the same object `run` builds.
    expect(Graph.nodes(graph).find((node) => node.id.endsWith("then.map.flow"))?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: {
        primary: { _tag: "PlannedInput", path: ["primary"] },
        shadow: { _tag: "PlannedInput", path: ["shadow", "value"] }
      }
    })
  })

  it("declares the scorer call when one is configured", () => {
    const graph = Graph.build(Sidecar.make({ primary, shadow, score }), "prompt")

    expect(callsTo(graph, "sidecar/score")).toHaveLength(1)
    expect(Graph.nodes(graph).filter((node) => node.kind === "All")).toHaveLength(1)
  })

  it.effect("returns the primary value when the shadow fails", () =>
    Effect.gen(function*() {
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.fail("shadow is broken")
      })

      expect(result.primary).toBe("answer")
      expect(result.shadow.quarantined).toBe(true)
      if (result.shadow.quarantined) {
        expect(Cause.hasFails(result.shadow.cause)).toBe(true)
      }
    }))

  it.effect("quarantines a shadow defect as well as a typed failure", () =>
    Effect.gen(function*() {
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.die(new Error("shadow blew up"))
      })

      expect(result.primary).toBe("answer")
      expect(result.shadow.quarantined).toBe(true)
      if (result.shadow.quarantined) {
        expect(Cause.hasDies(result.shadow.cause)).toBe(true)
      }
    }))

  it.effect("fails when the primary fails, because the shadow is not a fallback", () =>
    Effect.gen(function*() {
      const failure = yield* Sidecar.run("prompt", {
        primary: () => Effect.fail("primary is broken"),
        shadow: () => Effect.succeed("cheap answer")
      }).pipe(Effect.flip)

      expect(failure).toBe("primary is broken")
    }))

  // Real clock: the handshake below never settles under a sequential
  // implementation, and the timeout that turns that into a failure has to
  // elapse on its own.
  it.live("starts the primary and the shadow concurrently", () =>
    Effect.gen(function*() {
      const primaryStarted = yield* Latch.make(false)
      const shadowStarted = yield* Latch.make(false)
      // Each side waits for the other to have started, so no sequential order
      // completes this run.
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.as(Effect.andThen(primaryStarted.open, shadowStarted.await), "answer"),
        shadow: () => Effect.as(Effect.andThen(shadowStarted.open, primaryStarted.await), "cheap answer")
      }).pipe(Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.die(new Error("the primary and the shadow did not overlap"))
      }))

      expect(result.primary).toBe("answer")
      expect(result.shadow).toEqual({ quarantined: false, value: "cheap answer" })
    }))

  it.effect("interleaves the primary and the shadow rather than sequencing them", () =>
    Effect.gen(function*() {
      const events: Array<string> = []
      const step = (name: string) =>
        Effect.sync(() => events.push(`start-${name}`)).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(Effect.sync(() => events.push(`end-${name}`))),
          Effect.as(name)
        )
      yield* Sidecar.run("prompt", { primary: () => step("primary"), shadow: () => step("shadow") })

      expect(events).toEqual(["start-primary", "start-shadow", "end-primary", "end-shadow"])
    }))

  it.effect("scores both outputs and reports the difference", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.succeed("cheap answer"),
        score: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return { primary: 0.8, shadow: 0.6 }
          })
      })

      expect(seen).toEqual([{ primary: "answer", shadow: "cheap answer" }])
      expect(result.delta).toEqual({ primary: 0.8, shadow: 0.6, difference: 0.2, cheaperWins: false })
    }))

  it.effect("does not score when the shadow is quarantined", () =>
    Effect.gen(function*() {
      let scored = 0
      const result = yield* Sidecar.run("prompt", {
        primary: () => Effect.succeed("answer"),
        shadow: () => Effect.fail("shadow is broken"),
        score: () => Effect.sync(() => (++scored, { primary: 1, shadow: 0 }))
      })

      expect(scored).toBe(0)
      expect(result.delta).toBeUndefined()
    }))

  it("computes a delta that survives floating-point subtraction", () => {
    expect(Sidecar.delta(0.3, 0.1)).toEqual({ primary: 0.3, shadow: 0.1, difference: 0.2, cheaperWins: false })
    expect(Sidecar.delta(0.6, 0.9)).toEqual({
      primary: 0.6,
      shadow: 0.9,
      difference: -0.3,
      cheaperWins: true
    })
    expect(Sidecar.delta(0.5, 0.5).cheaperWins).toBe(true)
  })
})
