import { expectTypeOf, test } from "vitest"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

/**
 * `Graph` is a handle, not a record. `build` deep-freezes its storage, so a
 * published storage field would hand every consumer a mutable-looking view of
 * a frozen object: a write typechecks and then throws at runtime. The named
 * key set of the published type must stay empty.
 */
test("the published graph type names no storage field", () => {
  expectTypeOf<keyof Graph.Graph & string>().toEqualTypeOf<never>()
})

test("graph readers answer readonly projections", () => {
  const graph = Graph.build(Node.succeed("value"))

  expectTypeOf(graph).toEqualTypeOf<Graph.Graph>()
  expectTypeOf(Graph.nodes(graph)).toEqualTypeOf<ReadonlyArray<Graph.GraphNode>>()
  expectTypeOf(Graph.edges(graph)).toEqualTypeOf<ReadonlyArray<Graph.Edge>>()
  expectTypeOf(Graph.conflicts(graph)).toEqualTypeOf<ReadonlyArray<Graph.Conflict>>()
  expectTypeOf(Graph.diagnostics(graph)).toEqualTypeOf<ReadonlyArray<Graph.GraphBuildError>>()
})

test("an observed node publishes readonly fields and a readonly dependency list", () => {
  expectTypeOf<Pick<Graph.GraphNode, "id" | "dependencies">>().toEqualTypeOf<{
    readonly id: string
    readonly dependencies: ReadonlyArray<string>
  }>()
})
