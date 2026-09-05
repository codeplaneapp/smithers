import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const stable = { callbackIdentity: "stable" } as const
const version = { implementationVersion: "stable-tests/v1" }
const callbackDiagnostics = (node: Node.Any | Flow.Any) => Graph.build(node, {}, stable).diagnostics

describe("stable callback admission", () => {
  it("names all unstable callback sites and keeps the graph inspectable but not compilable", () => {
    const flow = Flow.make("stable/refuse", {
      payload: {},
      success: Schema.String,
      body: () =>
        Node.succeed(1).pipe(
          Node.map((value) => value + 1),
          Node.bindPlanned(() =>
            Node.branch(Node.succeed(1), {
              if: (value) => value > 0,
              then: () => Node.succeed("positive"),
              else: () => Node.succeed("negative")
            })
          )
        )
    })
    const graph = Graph.build(flow, {}, stable)
    expect(graph.nodes).toHaveLength(8)
    expect(graph.diagnostics.map(({ code, node, path }) => ({ code, node, path }))).toEqual([
      { code: "unstable_callback", node: "root.flow", path: ["continuation"] },
      { code: "unstable_callback", node: "root.flow.andThen", path: ["mapper"] },
      { code: "unstable_callback", node: "root.flow.then", path: ["predicate"] },
      { code: "unstable_callback", node: "root", path: ["body"] }
    ])
    expect(() => Graph.drafts(graph)).toThrow(/Node.capture with every semantic capture/)
    expect(Graph.build(flow, {}).diagnostics).toEqual([])
    expect(Graph.build(flow, {}, { callbackIdentity: "process-local" }).diagnostics).toEqual([])
  })

  it("checks child and handoff body identities even when their graph is left as a leaf", () => {
    const child = Flow.make("stable/child", { payload: {}, success: Schema.Number, body: () => Node.succeed(1) })
    for (const node of [child.child({}), child.to({})]) {
      expect(callbackDiagnostics(node)).toMatchObject([
        { code: "unstable_callback", node: "root", path: ["body"] }
      ])
    }
    const captured = Flow.make("stable/captured-child", {
      payload: {},
      success: Schema.Number,
      body: Node.capture(version, () => Node.succeed(1))
    })
    expect(callbackDiagnostics(captured.child({}))).toEqual([])
    expect(callbackDiagnostics(captured.to({}))).toEqual([])
    for (const node of [captured.child({}), captured.to({})]) {
      const detached = { ...node, ast: JSON.parse(JSON.stringify(node.ast)) as Node.Ast }
      expect(callbackDiagnostics(detached)).toMatchObject([
        { code: "unstable_callback", path: ["body"], message: expect.stringContaining("unavailable identity") }
      ])
    }
  })

  it("accepts complete captures and function-free sequencing without allocating ephemeral identity", () => {
    const configuration = { increment: 2, implementationVersion: "stable-tests/v1" }
    const flow = Flow.make("stable/accept", {
      payload: { seed: Schema.Number },
      success: Schema.String,
      body: Node.capture(configuration, ({ seed }) =>
        Node.succeed(seed).pipe(
          Node.map(Node.capture(configuration, (value: number) => value + configuration.increment)),
          Node.bindPlanned(Node.capture(version, () =>
            Node.branch(Node.succeed(1), {
              if: Node.capture(version, (value: number) => value > 0),
              then: () => Node.succeed("positive"),
              else: () => Node.succeed("negative")
            }))),
          Node.andThen(Node.succeed("done"))
        ))
    })
    const graph = Graph.build(flow, { seed: 1 }, stable)
    expect(graph.diagnostics).toEqual([])
    expect(Graph.drafts(graph)).toHaveLength(graph.nodes.length)
    expect(Graph.drafts(graph)).toEqual(Graph.drafts(Graph.build(flow, { seed: 1 })))
  })

  it.effect("the canonical interpreter refuses unstable callbacks before the first action", () =>
    withCrypto(Effect.gen(function*() {
      let runs = 0
      const step = Action.make("stable/action", { payload: {}, success: Schema.Number })
      const flow = Flow.make("stable/dispatch", { payload: {}, success: Schema.Number, body: () => step.call({}) })
      const implementations = step.toLayer(() => Effect.sync(() => ++runs))
      const exit = yield* Effect.exit(
        flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(flow, implementations).pipe(Layer.provideMerge(layerMemory))
        ))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "incomplete_graph",
          node: "root",
          message: expect.stringContaining("process-local identity")
        })
      }
      expect(runs).toBe(0)
      expect(
        yield* flow.execute({}).pipe(Effect.provide(
          Interpreter.layerWithImplementations(flow, implementations, { callbackIdentity: "process-local" }).pipe(
            Layer.provideMerge(layerMemory)
          )
        ))
      ).toBe(1)
    })))
})

describe("independent process identity", () => {
  it("rebuilds equal plans across fresh processes and re-keys each semantic change", () => {
    const fixture = fileURLToPath(new URL("./fixtures/stableIdentity.ts", import.meta.url))
    const base = { offset: 2, implementationVersion: "counter/v1", changedSource: false, unrelated: 0, stable: true }
    const compile = (changes: Partial<typeof base> = {}) =>
      JSON.parse(execFileSync(process.execPath, [
        fixture,
        JSON.stringify({ ...base, ...changes })
      ], { encoding: "utf8", timeout: 30_000 })) as { digest: string; keys: Array<[string, string]> }
    const first = compile()
    expect(compile()).toEqual(first)
    expect(compile({ unrelated: 19 })).toEqual(first)
    for (const changes of [{ offset: 3 }, { implementationVersion: "counter/v2" }, { changedSource: true }]) {
      const changed = compile(changes)
      expect(changed.digest).not.toBe(first.digest)
      expect(changed.keys[0]).toEqual(first.keys[0])
      expect(changed.keys.slice(1)).not.toEqual(first.keys.slice(1))
    }
    expect(compile({ stable: false }).digest).not.toBe(compile({ stable: false }).digest)
  }, 120_000)
})
