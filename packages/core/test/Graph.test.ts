import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const effect = (input: Partial<Effects.MakeOptions> = {}): Effects.Declaration =>
  Effects.make({
    reads: input.reads ?? [],
    writes: input.writes ?? [],
    mode: input.mode ?? "expected",
    onConflict: input.onConflict ?? "serialize",
    ...(input.tier === undefined ? {} : { tier: input.tier })
  })

const keyMaterial = (graph: Graph.Graph) => Result.getOrThrow(Graph.keyMaterial(graph))

describe("Graph", () => {
  it("uses structural ids and records value and continuation edges", () => {
    const read = Flow.make({
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.String,
      body: (input) => Node.succeed(input.id)
    })
    const graph = Graph.build(
      Node.andThen(Node.all({ pr: read({ id: "pr" }), tests: read({ id: "tests" }) }), () => Node.succeed("done"))
    )

    expect(Graph.nodes(graph).map((node) => node.id)).toEqual([
      "root",
      "root.andThen",
      "root.andThen.all.pr",
      "root.andThen.all.pr.flow",
      "root.andThen.all.tests",
      "root.andThen.all.tests.flow",
      "root.then"
    ])
    expect(Graph.edges(graph)).toEqual([
      { from: "root.andThen.all.pr.flow", to: "root.andThen.all.pr", reason: "value" },
      { from: "root.andThen.all.pr", to: "root.andThen", reason: "value" },
      { from: "root.andThen.all.tests.flow", to: "root.andThen.all.tests", reason: "value" },
      { from: "root.andThen.all.tests", to: "root.andThen", reason: "value" },
      { from: "root.andThen", to: "root.then", reason: "continuation" },
      { from: "root.then", to: "root", reason: "value" }
    ])
  })

  it("inherits placement lexically and lets a node override it", () => {
    const flow = Flow.within(
      Flow.make({ body: () => Node.within(Node.succeed("ok"), Placement.client()) }),
      Placement.sandbox({ image: "base" })
    )
    const graph = Graph.build(flow)

    expect(Graph.nodes(graph)[0]?.placement).toEqual(Placement.client())
    expect(Graph.placements(graph)).toEqual([
      { nodeId: "root", placement: Placement.client() }
    ])
  })

  it("uses the same lane projection for explicit and conflict-derived lanes", () => {
    const writes = effect({ writes: ["out/result"], onConflict: "lane" })
    const graph = Graph.build(Node.all({
      explicit: Node.lane(Node.withEffects(Node.dynamic({}), writes), { id: "lane:explicit" }),
      implicit: Node.withEffects(Node.dynamic({}), writes)
    }))
    const [root, explicit, implicit] = Graph.nodes(graph)

    expect(root).toBeDefined()
    expect(explicit?.annotations.lane).toEqual({ id: "lane:explicit" })
    expect(implicit?.annotations.lane).toEqual({ id: "lane:root.all.implicit" })
  })

  it("reports envelope escapes as diagnostics", () => {
    const flow = Flow.make({
      effects: effect({ writes: ["out/**"] }),
      body: () => Node.withEffects(Node.dynamic({}), effect({ writes: ["secret.txt"] }))
    })

    expect(Graph.diagnostics(Graph.build(flow))).toMatchObject([
      { code: "effect_outside_envelope", paths: ["secret.txt"] }
    ])
  })

  it("distinguishes node declarations from inherited flow envelopes", () => {
    const envelope = effect({ reads: ["src/**"], writes: ["out/**"], mode: "hermetic" })
    const declaration = effect({ reads: ["src/index.ts"], writes: ["out/result"], mode: "hermetic" })
    const graph = Graph.build(Flow.make({
      effects: envelope,
      body: () => Node.withEffects(Node.dynamic({}), declaration)
    }))

    expect(Graph.effects(graph)).toEqual([
      {
        nodeId: "root",
        declared: declaration,
        effective: declaration
      }
    ])
    expect(Graph.nodes(graph)[0]?.keyMaterial.effects).toBe(declaration)
  })

  it("applies a group effect declaration as a child envelope without exposing internal state", () => {
    const envelope = effect({ writes: ["out/**"], mode: "hermetic" })
    const graph = Graph.build(
      Node.withEffects(
        Node.all({
          first: Node.dynamic({}),
          second: Node.dynamic({})
        }),
        envelope
      )
    )

    expect(Graph.effects(graph)).toEqual([
      { nodeId: "root", declared: envelope, effective: undefined },
      { nodeId: "root.all.first", declared: undefined, effective: envelope },
      { nodeId: "root.all.second", declared: undefined, effective: envelope }
    ])
    expect(Graph.conflicts(graph)).toEqual([
      {
        nodes: ["root.all.first", "root.all.second"],
        paths: ["out/**"],
        strategy: "serialize"
      }
    ])
    expect(() => JSON.stringify(Graph.nodes(graph))).not.toThrow()
    expect(Object.keys(Graph.nodes(graph)[0] ?? {})).not.toContain("continuationDependencies")
    expect(Object.keys(Graph.nodes(graph)[0] ?? {})).not.toContain("work")
  })

  it("checks a child flow envelope against its caller's envelope", () => {
    const child = Flow.make({
      effects: effect({ writes: ["secret.txt"] }),
      body: () => Node.dynamic({})
    })
    const parent = Flow.make({
      effects: effect({ writes: ["out/**"] }),
      body: () => child(undefined)
    })

    expect(Graph.diagnostics(Graph.build(parent))).toMatchObject([
      {
        code: "effect_outside_envelope",
        paths: ["secret.txt"]
      }
    ])
  })

  it("cannot widen a caller capability envelope through a nested flow", () => {
    const child = Flow.make({
      capabilities: ["fs:read:/workspace/**", "proc:spawn:**"],
      body: () => Node.dynamic({})
    })
    const parent = Flow.make({
      capabilities: ["fs:read:/workspace/**"],
      body: () => child(undefined)
    })

    expect(Graph.nodes(Graph.build(parent)).find((node) => node.id === "root.flow")?.capabilities).toEqual([
      "fs:read:/workspace/**"
    ])
  })

  it("returns a typed failure when a node has no key material", () => {
    const graph = Graph.build(Node.succeed("ok"))
    const node = (graph as unknown as { nodes: Array<{ keyMaterial?: unknown }> }).nodes[0]
    if (node !== undefined) delete node.keyMaterial

    expect(Graph.keyMaterial(graph)).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "flows/core/GraphBuildError",
        code: "missing_key_material",
        nodeId: "root"
      }
    })
  })

  it("projects declared literal inputs without coupling siblings", () => {
    const read = Flow.make({
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      body: (input) => Node.dynamic({ output: Schema.String, prompt: input.value })
    })
    const one = Graph.build(Node.all({ left: read({ value: "one" }), right: read({ value: "two" }) }))
    const two = Graph.build(
      Node.all({ left: read({ value: "one" }), right: read({ value: "changed" }), extra: Node.succeed(1) })
    )
    const material = (graph: Graph.Graph, id: string) =>
      keyMaterial(graph).find((entry) => entry.nodeId === id)?.material

    expect(material(one, "root.all.left")?.inputs).toEqual([{ _tag: "Literal", value: { value: "one" } }, {
      _tag: "Ref",
      from: "root.all.left.flow",
      path: []
    }])
    expect(material(one, "root.all.right")).not.toEqual(material(two, "root.all.right"))
    expect(material(one, "root.all.left")).toEqual(material(two, "root.all.left"))
  })

  it("keeps names and tree position out of key material while retaining resolved layers", () => {
    const declaration = (name: string) =>
      Flow.make({
        name,
        input: Schema.String,
        output: Schema.String,
        body: Node.succeed
      })
    const first = Graph.build(Node.all({ named: declaration("first")("value") }), undefined, {
      resolveLayers: () => ["host:v1"]
    })
    const renamed = Graph.build(Node.all({ named: declaration("renamed")("value") }), undefined, {
      resolveLayers: () => ["host:v1"]
    })

    expect(Graph.nodes(first).find((node) => node.id === "root.all.named")?.keyMaterial).toEqual(
      Graph.nodes(renamed).find((node) => node.id === "root.all.named")?.keyMaterial
    )
    expect(keyMaterial(first).every((entry) => entry.material.layers[0] === "host:v1")).toBe(true)
    expect(keyMaterial(first).map((entry) => entry.nodeId)).toEqual([
      "root.all.named.flow",
      "root.all.named",
      "root"
    ])
    expect(JSON.stringify(keyMaterial(first)[0]?.material)).not.toContain("\"nodeId\"")
  })

  it("projects schemas and callable flows into closure-free key material", () => {
    const callable = Flow.make({
      name: "lookup",
      description: "Looks up a value",
      input: Schema.String,
      output: Schema.String,
      body: Node.succeed
    })
    const graph = Graph.build(Node.dynamic({
      model: "smart",
      flows: [callable],
      output: Schema.String
    }))
    const material = keyMaterial(graph)[0]?.material

    expect(material?.body).toMatchObject({
      _tag: "Dynamic",
      flows: [{ _tag: "Flow" }],
      output: { _tag: "Schema" }
    })
    expect(JSON.stringify(material)).not.toContain("lookup")
    expect(JSON.stringify(material)).not.toContain("Looks up a value")
    expect(() => JSON.stringify(material)).not.toThrow()
    expect(JSON.stringify(material)).not.toContain("function")
  })

  it("keeps callable-flow names and descriptions out of key material", () => {
    const declaration = (name: string, description: string) =>
      Flow.make({
        name,
        description,
        input: Schema.String,
        output: Schema.String,
        body: Node.succeed
      })
    const first = keyMaterial(
      Graph.build(Node.dynamic({ flows: [declaration("first", "first description")] }))
    )[0]?.material
    const renamed = keyMaterial(
      Graph.build(Node.dynamic({ flows: [declaration("renamed", "renamed description")] }))
    )[0]?.material

    expect(first).toEqual(renamed)
  })

  it("invalidates a dynamic flow declaration when its body changes", () => {
    const firstFlow = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (value) => Node.succeed(`first:${value}`)
    })
    const secondFlow = Flow.make({
      input: Schema.String,
      output: Schema.String,
      body: (value) => Node.succeed(`second:${value}`)
    })
    const first = keyMaterial(Graph.build(Node.dynamic({ flows: [firstFlow] })))[0]?.material
    const second = keyMaterial(Graph.build(Node.dynamic({ flows: [secondFlow] })))[0]?.material

    expect(first?.body).not.toEqual(second?.body)
  })

  it("evaluates pure topology builders but not value mappers while planning", () => {
    let mapCalls = 0
    let continuationCalls = 0
    const mapped = Node.dynamic<string>({}).pipe(
      Node.map((value) => {
        mapCalls++
        return value.toUpperCase()
      }),
      Node.andThen((value) => {
        continuationCalls++
        return Node.succeed(value.length)
      })
    )

    expect(() => Graph.build(mapped)).not.toThrow()
    expect(mapCalls).toBe(0)
    expect(continuationCalls).toBe(1)
    expect(Graph.nodes(Graph.build(mapped)).map((node) => node.id)).toContain("root.then")
  })

  it("records callback-produced downstream topology and symbolic value paths", () => {
    const summarize = Flow.make({
      input: Schema.Struct({ pr: Schema.String, tests: Schema.String }),
      output: Schema.String,
      body: (input) => Node.dynamic({ prompt: `${input.pr}:${input.tests}` })
    })
    const graph = Graph.build(
      Node.all({ pr: Node.dynamic<string>({}), tests: Node.dynamic<string>({}) }).pipe(
        Node.andThen(({ pr, tests }) => summarize({ pr, tests }))
      )
    )
    const call = Graph.nodes(graph).find((node) => node.id === "root.then")

    expect(Graph.nodes(graph).map((node) => node.id)).toContain("root.then.flow")
    expect(call?.keyMaterial.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.andThen",
      path: ["pr"]
    })
    expect(call?.keyMaterial.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.andThen",
      path: ["tests"]
    })
  })

  it("does not report already-sequenced writers as conflicts", () => {
    const writes = effect({ writes: ["out/result"], onConflict: "fail" })
    const graph = Graph.build(
      Node.andThen(
        Node.withEffects(Node.dynamic({}), writes),
        Node.withEffects(Node.dynamic({}), writes)
      )
    )

    expect(Graph.conflicts(graph)).toEqual([])
    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.edges(graph)).toContainEqual({
      from: "root.andThen",
      to: "root.then",
      reason: "continuation"
    })
  })

  it("turns serialize conflicts into dependency edges and key inputs", () => {
    const writes = effect({ writes: ["out/result"], onConflict: "serialize" })
    const graph = Graph.build(Node.all({
      first: Node.withEffects(Node.dynamic({}), writes),
      second: Node.withEffects(Node.dynamic({}), writes)
    }))
    const second = keyMaterial(graph).find((entry) => entry.nodeId === "root.all.second")

    expect(Graph.edges(graph)).toContainEqual({
      from: "root.all.first",
      to: "root.all.second",
      reason: "conflict"
    })
    expect(second?.material.inputs).toContainEqual({
      _tag: "Ref",
      from: "root.all.first",
      path: []
    })
  })

  it("represents lane conflict resolution with two lanes and a merge node", () => {
    const lane = effect({ writes: ["out/result"], onConflict: "lane" })
    const serialize = effect({ writes: ["out/result"], onConflict: "serialize" })
    const graph = Graph.build(Node.all({
      first: Node.withEffects(Node.dynamic({}), lane),
      second: Node.withEffects(Node.dynamic({}), serialize)
    }))
    const merge = Graph.nodes(graph).find((node) => node.kind === "LaneMerge")

    expect(Graph.nodes(graph).find((node) => node.id === "root.all.first")?.lane).toEqual({
      id: "lane:root.all.first"
    })
    expect(Graph.nodes(graph).find((node) => node.id === "root.all.second")?.lane).toEqual({
      id: "lane:root.all.second"
    })
    expect(merge).toMatchObject({
      id: "lane.merge.0",
      dependencies: ["root.all.first", "root.all.second"]
    })
    expect(Graph.conflicts(graph)).toEqual([{
      nodes: ["root.all.first", "root.all.second"],
      paths: ["out/result"],
      strategy: "lane",
      mergeNodeId: "lane.merge.0"
    }])
  })

  it("resolves layer identities independently for each node", () => {
    const graph = Graph.build(
      Node.all({
        cheap: Node.dynamic({ model: "cheap" }),
        smart: Node.dynamic({ model: "smart" })
      }),
      undefined,
      {
        resolveLayers: ({ model }) => model === undefined ? ["host:test"] : ["host:test", `model:${model}`]
      }
    )

    expect(Graph.nodes(graph).find((node) => node.id === "root.all.cheap")?.keyMaterial.layers).toEqual([
      "host:test",
      "model:cheap"
    ])
    expect(Graph.nodes(graph).find((node) => node.id === "root.all.smart")?.keyMaterial.layers).toEqual([
      "host:test",
      "model:smart"
    ])
  })

  it("throws the typed flow error for declaration-only graphs", () => {
    expect(() => Graph.build(Flow.make({ name: "declared" }))).toThrow(Flow.FlowError)
  })
})
