/**
 * The `jsx-single.migrated` fixture is the definition of a clean migration, so
 * what it holds is asserted against the packages themselves, not only read by
 * the deterministic checks.
 *
 * The module carries two declarations because flows HEAD needs two. The default
 * export is the `@smthrs/core` descriptor the registry reads without evaluating
 * anything; the named `SimpleExample` is the `@smthrs/flow` flow that runs. The
 * descriptor is not a second, unrelated declaration: it admits that flow's own
 * `payload` and `success`, which is the whole binding flows can express at this
 * version. Core's `body` returns a `@smthrs/core/Node` and `SimpleExample.call`
 * returns a `@smthrs/plan/Node`, so binding them by body is `TS2322` until the
 * core-runtime bridge lands. Both halves are pinned here against the real
 * packages so that bridge has to change this file deliberately.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Graph } from "@smthrs/flow"

const module = await import("./fixtures/jsx-single.migrated/flows/simple-workflow/flow.ts")

describe("the migrated fixture's flow module", () => {
  it("default-exports the descriptor the registry reads", () => {
    expect(module.default.description).toBe("Researches a topic and writes a short article about it.")
    expect(module.default.capabilities).toEqual([])
    expect(module.default.effects?.mode).toBe("hermetic")
  })

  it("admits the contract the durable flow declares, and no other", () => {
    // The binding flows can express today. `@smthrs/core`'s `body` returns a
    // `@smthrs/core/Node` while `SimpleExample.call` returns a
    // `@smthrs/plan/Node`, so the descriptor cannot delegate by body until the
    // core-runtime bridge lands; what it can do is admit the same contract.
    expect(Object.keys(module.default.input.fields)).toEqual(Object.keys(module.SimpleExample.payloadSchema.fields))
    expect(module.default.output).toBe(module.SimpleExample.successSchema)
    // Without a body core derives no implementation, and calling the descriptor
    // is an error rather than a silent no-op. This is the shape at this
    // version, pinned so the bridge has to change it deliberately.
    expect(module.default.body).toBeUndefined()
    expect(module.default.implementation).toBeUndefined()
    expect(() => (module.default as unknown as (input: unknown) => unknown)({ topic: "effect" }))
      .toThrow(/without a body/)
  })

  it("names the durable flow that runs, with the two agent steps in order", () => {
    const graph = Graph.build(module.SimpleExample, { topic: "effect" })
    const nodes = Graph.nodes(graph)

    expect(Graph.diagnostics(graph)).toEqual([])
    // Two agent calls, the second waiting on the first, under one flow call.
    expect(nodes.map((node) => `${node.id}:${node.kind}`)).toEqual([
      "root.flow.andThen:ActionCall",
      "root.flow.then:ActionCall",
      "root.flow:AndThen",
      "root:FlowCall"
    ])
    expect(nodes[1]?.dependencies).toEqual(["root.flow.andThen"])
    expect(Graph.edges(graph).length).toBeGreaterThan(0)
  })
})
