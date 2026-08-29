/**
 * How an authored scheduling priority reaches a node draft.
 *
 * A priority is the one thing `@smthrs/plan` nodes carry beyond their own
 * shape, and it is JSON rather than a `Context` annotation so a stored plan
 * keeps it. Graph building is where it becomes a draft field the compiler and
 * the scheduler read, and where inheritance is decided: lexical, nearest
 * enclosing node wins, a node that states its own keeps it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Read = Action.make("priority/read", {
  payload: { path: Schema.String },
  success: Schema.Number
})

const Write = Action.make("priority/write", {
  payload: { path: Schema.String },
  success: Schema.Number
})

const priorities = (graph: Graph.Graph): Readonly<Record<string, number | undefined>> =>
  Object.fromEntries(Graph.nodes(graph).map((node) => [node.id, node.draft.priority]))

describe("Graph priority", () => {
  it("copies an authored priority onto the node draft", () => {
    const flow = Flow.make("priority/one", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) => Node.priority(Read.call({ path }), 5)
    })

    expect(priorities(Graph.build(flow, { path: "a" }))["root.flow"]).toBe(5)
  })

  it("inherits a container priority lexically and lets a child override it", () => {
    const flow = Flow.make("priority/container", {
      payload: { path: Schema.String },
      success: Schema.Unknown,
      body: ({ path }) =>
        Node.priority(
          Node.all({
            quiet: Read.call({ path }),
            loud: Node.priority(Write.call({ path }), 9)
          }),
          3
        )
    })
    const found = priorities(Graph.build(flow, { path: "a" }))

    // The container states 3, so the member that states nothing runs at 3.
    expect(found["root.flow"]).toBe(3)
    expect(found["root.flow.all.quiet"]).toBe(3)
    // The member that states its own keeps it.
    expect(found["root.flow.all.loud"]).toBe(9)
    // Nothing encloses the entry, so it inherits nothing.
    expect(found["root"]).toBeUndefined()
  })

  it("leaves a draft without a priority when nothing declares one", () => {
    const flow = Flow.make("priority/none", {
      payload: { path: Schema.String },
      success: Schema.Number,
      body: ({ path }) => Read.call({ path })
    })

    for (const value of Object.values(priorities(Graph.build(flow, { path: "a" })))) {
      expect(value).toBeUndefined()
    }
  })

  // Priority orders work; it never changes what the work produces. Folding it
  // into key material would throw away a legitimate cache hit every time a
  // scheduler hint changed.
  it("keeps priority out of key material", () => {
    const call = Read.call({ path: "a" })
    const material = (node: Node.Any) => Graph.nodes(Graph.build(node)).map((observed) => observed.draft.material)

    // The same call, once plain and once prioritized: the drafts differ in
    // `priority` and in nothing the key is computed from.
    expect(material(Node.priority(call, 7))).toEqual(material(call))
    expect(Graph.nodes(Graph.build(Node.priority(call, 7)))[0]?.draft.priority).toBe(7)
    expect(Graph.nodes(Graph.build(call))[0]?.draft.priority).toBeUndefined()
  })
})
