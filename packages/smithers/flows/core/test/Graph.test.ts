import { JsonSchema, Result, Schema, SchemaAST } from "effect"
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
      { code: "effect_outside_envelope", paths: ["secret.txt"], nodeId: "root" }
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
    expect(Graph.nodes(graph)[0]?.keyMaterial.effects).toEqual(declaration)
    expect(Graph.nodes(graph)[0]?.keyMaterial.effects).not.toBe(declaration)
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
        paths: ["secret.txt"],
        nodeId: "root"
      }
    ])
  })

  describe.each([
    {
      dimension: "reads",
      restricted: effect({ reads: ["src/**"] }),
      escaped: effect({ reads: ["secret.txt"] }),
      code: "effect_outside_envelope",
      paths: ["secret.txt"]
    },
    {
      dimension: "writes",
      restricted: effect({ writes: ["out/**"] }),
      escaped: effect({ writes: ["secret.txt"] }),
      code: "effect_outside_envelope",
      paths: ["secret.txt"]
    },
    {
      dimension: "mode",
      restricted: effect({ mode: "hermetic" }),
      escaped: effect({ mode: "expected" }),
      code: "effect_mode_widening",
      paths: []
    },
    {
      dimension: "tier",
      restricted: effect(),
      escaped: effect({ tier: "irreversible" }),
      code: "effect_tier_widening",
      paths: []
    }
  ])("flow call $dimension envelopes", ({ restricted, escaped, code, paths }) => {
    it.each([false, true])("rejects a callee escape with annotated=%s", (annotated) => {
      const child = Flow.make({ effects: escaped, body: () => Node.dynamic({}) })
      const graph = Graph.build(Flow.make({
        effects: restricted,
        body: () => annotated ? Node.withEffects(child(undefined), restricted) : child(undefined)
      }))

      expect(Graph.diagnostics(graph)).toMatchObject([{ code, paths, nodeId: "root" }])
      expect(Graph.keyMaterial(graph)._tag).toBe("Failure")
      expect(Graph.nodes(graph).find((node) => node.id === "root.flow")?.effectiveEffects).toEqual(restricted)
    })

    it("checks the callee against its call annotation without a parent envelope", () => {
      const child = Flow.make({ effects: escaped, body: () => Node.dynamic({}) })
      const graph = Graph.build(Node.withEffects(child(undefined), restricted))

      expect(Graph.diagnostics(graph)).toMatchObject([{ code, paths, nodeId: "root" }])
      expect(Graph.keyMaterial(graph)._tag).toBe("Failure")
      expect(Graph.nodes(graph).find((node) => node.id === "root.flow")?.effectiveEffects).toEqual(restricted)
    })

    it("rejects a call annotation that escapes its parent even when the callee fits", () => {
      const child = Flow.make({ effects: restricted, body: () => Node.dynamic({}) })
      const graph = Graph.build(Flow.make({
        effects: restricted,
        body: () => Node.withEffects(child(undefined), escaped)
      }))

      expect(Graph.diagnostics(graph)).toMatchObject([{ code, paths, nodeId: "root" }])
      expect(Graph.keyMaterial(graph)._tag).toBe("Failure")
      expect(Graph.nodes(graph).find((node) => node.id === "root.flow")?.effectiveEffects).toEqual(restricted)
    })
  })

  it("narrows the parent, call annotation and callee declaration in order", () => {
    const parentEffects = effect({ reads: ["**"], writes: ["**"], tier: "irreversible" })
    const callEffects = effect({ reads: ["src/**"], writes: ["out/**"], tier: "compensable" })
    const childEffects = effect({ reads: ["src/index.ts"], writes: ["out/result"], mode: "hermetic" })
    const child = Flow.make({ effects: childEffects, body: () => Node.dynamic({}) })
    const graph = Graph.build(Flow.make({
      effects: parentEffects,
      body: () => Node.withEffects(child(undefined), callEffects)
    }))

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.keyMaterial(graph)._tag).toBe("Success")
    expect(Graph.nodes(graph).find((node) => node.id === "root.flow")?.effectiveEffects).toEqual(childEffects)
  })

  it.each([false, true])("inherits the call envelope when the callee has no declaration, annotated=%s", (annotated) => {
    const parentEffects = effect({ writes: ["out/**"] })
    const callEffects = effect({ writes: ["out/result"], mode: "hermetic" })
    const child = Flow.make({ body: () => Node.dynamic({}) })
    const graph = Graph.build(Flow.make({
      effects: parentEffects,
      body: () => annotated ? Node.withEffects(child(undefined), callEffects) : child(undefined)
    }))

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.keyMaterial(graph)._tag).toBe("Success")
    expect(Graph.nodes(graph).find((node) => node.id === "root.flow")?.effectiveEffects)
      .toEqual(annotated ? callEffects : parentEffects)
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

    const graph = Graph.build(parent)
    expect(Graph.nodes(graph).find((node) => node.id === "root.flow")?.capabilities).toEqual([
      "fs:read:/workspace/**"
    ])
    expect(Graph.diagnostics(graph)).toMatchObject([{
      code: "capability_outside_grant",
      paths: ["proc:spawn:**"],
      nodeId: "root"
    }])
  })

  it("returns a typed failure when a node has no key material", () => {
    const built = Graph.build(Node.succeed("ok"))
    const graph = {
      ...built,
      nodes: Graph.nodes(built).map((node) => ({ ...node, keyMaterial: undefined }))
    } as unknown as Graph.Graph

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

  it("refuses opaque declarations at nested schema positions", () => {
    const numeric = Schema.declare((value: unknown): value is number => typeof value === "number")
    const textual = Schema.declare((value: unknown): value is string => typeof value === "string")
    for (const value of [numeric, textual]) {
      expect(() => Graph.build(Node.dynamic({ output: Schema.Struct({ v: value }) })))
        .toThrow(Node.NodeBuildError)
    }
  })

  it.each(
    [
      ["transformation", Schema.NumberFromString, Schema.String],
      ["date", Schema.Date, Schema.String],
      ["brands", Schema.String.pipe(Schema.brand("A")), Schema.String.pipe(Schema.brand("B"))],
      ["parameters", Schema.Option(Schema.String), Schema.Option(Schema.Number)],
      [
        "filters",
        Schema.String.check(Schema.makeFilter((value) => value === "a")),
        Schema.String.check(Schema.makeFilter((value) => value === "b"))
      ]
    ] as const
  )("preserves nested schema %s identity", (_, first, second) => {
    const material = (v: Schema.Top) => keyMaterial(Graph.build(Node.dynamic({ output: Schema.Struct({ v }) })))
    expect(material(first)).not.toEqual(material(second))
    expect(material(first)).toEqual(material(first))
  })

  it.each(["Struct", "Array"] as const)("bounds nested %s schemas with a typed payload refusal", (kind) => {
    let output: Schema.Top = Schema.String
    for (let index = 0; index <= Graph.maximumPayloadDepth; index++) {
      output = kind === "Struct" ? Schema.Struct({ child: output }) : Schema.Array(output)
    }
    expect(() => Graph.build(Node.dynamic({ output }))).toThrow(Graph.GraphBuildError)
    try {
      Graph.build(Node.dynamic({ output }))
    } catch (error) {
      expect(error).toMatchObject({ code: "payload_too_deep", nodeId: "root" })
    }
  })

  it("charges wide schema structure to the payload member budget", () => {
    const fields: Record<string, typeof Schema.String> = {}
    for (let index = 0; index < Graph.maximumPayloadMembers / 4; index++) fields[`v${index}`] = Schema.String
    const output = Schema.Struct(fields)
    expect(() => Graph.build(Node.dynamic({ output }))).toThrow(Graph.GraphBuildError)
    try {
      Graph.build(Node.dynamic({ output }))
    } catch (error) {
      expect(error).toMatchObject({ code: "payload_too_large", nodeId: "root" })
    }
  })

  it("bounds the generated JSON Schema document even when the AST is shallow", () => {
    const output = (levels: number) =>
      Schema.String.check(Schema.makeFilter(() => true, {
        toJsonSchema: () => {
          let document: JsonSchema.JsonSchema = { type: "string" }
          for (let index = 0; index < levels; index++) document = { properties: { v: document } }
          return document
        }
      }))
    expect(() => Graph.build(Node.succeed(output(61)))).not.toThrow()
    expect(() => Graph.build(Node.succeed(output(62)))).toThrow(Graph.GraphBuildError)
    try {
      Graph.build(Node.succeed(output(62)))
    } catch (error) {
      expect(error).toMatchObject({ code: "payload_too_deep", nodeId: "root" })
    }
  })

  it("charges generated document members to the AST's remaining budget", () => {
    const output = (count: number) =>
      Schema.String.check(Schema.makeFilter(() => true, {
        toJsonSchema: () => ({ enum: Array.from({ length: count }, (_, index) => String(index)) })
      }))
    expect(() => Graph.build(Node.succeed(output(Graph.maximumPayloadMembers - 22)))).not.toThrow()
    expect(() => Graph.build(Node.succeed(output(Graph.maximumPayloadMembers - 21)))).toThrow(Graph.GraphBuildError)
    try {
      Graph.build(Node.succeed(output(Graph.maximumPayloadMembers - 21)))
    } catch (error) {
      expect(error).toMatchObject({
        code: "payload_too_large",
        paths: ["$.document.schema.allOf[0].enum"],
        nodeId: "root"
      })
    }
  })

  it("walks recursive suspended schemas without losing nested declaration guards", () => {
    let recursive: Schema.Top
    recursive = Schema.Struct({ next: Schema.suspend(() => Schema.NullOr(recursive)) })
    expect(keyMaterial(Graph.build(Node.dynamic({ output: recursive })))).toEqual(
      keyMaterial(Graph.build(Node.dynamic({ output: recursive })))
    )
    const opaque = Schema.declare((value: unknown): value is string => typeof value === "string")
    expect(() => Graph.build(Node.dynamic({ output: Schema.suspend(() => Schema.Struct({ v: opaque })) })))
      .toThrow(Node.NodeBuildError)
  })

  it.each(
    [
      ["array", (v: Schema.Top) => Schema.Array(v)],
      ["tuple", (v: Schema.Top) => Schema.Tuple([v])],
      ["union", (v: Schema.Top) => Schema.Union([v, Schema.Null])],
      ["record", (v: Schema.Top) => Schema.Record(Schema.String, v)],
      ["suspend", (v: Schema.Top) => Schema.suspend(() => v)]
    ] as const
  )("preserves annotations under a schema %s", (_, wrap) => {
    const material = (brand: string) =>
      keyMaterial(Graph.build(Node.dynamic({
        output: wrap(Schema.String.pipe(Schema.brand(brand)))
      })))
    expect(material("A")).not.toEqual(material("B"))
  })

  it.each(
    [
      [
        "template parts",
        Schema.TemplateLiteral(["prefix", Schema.String.pipe(Schema.brand("A"))]),
        Schema.TemplateLiteral(["prefix", Schema.String.pipe(Schema.brand("B"))])
      ],
      ["enum values", Schema.Enum({ A: "a" }), Schema.Enum({ A: "b" })],
      ["unique symbols", Schema.UniqueSymbol(Symbol.for("a")), Schema.UniqueSymbol(Symbol.for("b"))]
    ] as const
  )("preserves schema %s in structural identity", (_, first, second) => {
    const material = (output: Schema.Top) => keyMaterial(Graph.build(Node.dynamic({ output })))
    expect(material(first)).not.toEqual(material(second))
  })

  it("describes schema structural accessors without invoking them", () => {
    let calls = 0
    const context = new SchemaAST.Context(false, false)
    Object.defineProperty(context, "annotations", {
      enumerable: true,
      get: () => {
        calls++
        throw new Error("must not read structural accessor")
      }
    })
    const output = Schema.make(new SchemaAST.String(undefined, undefined, undefined, context))
    expect(keyMaterial(Graph.build(Node.dynamic({ output })))[0]?.material.body).toMatchObject({
      output: { ast: { context: { annotations: { _tag: "Accessor" } } } }
    })
    expect(calls).toBe(0)
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

  it("expands a catch into the protected node and its recovery arm", () => {
    const graph = Graph.build(
      Node.catch(Node.dynamic({ model: "writer" }), { onFailure: () => Node.succeed("fallback") })
    )

    expect(Graph.nodes(graph).map((node) => node.id)).toEqual(["root", "root.catch", "root.recover"])
    expect(Graph.nodes(graph)[0]?.kind).toBe("Catch")
    expect(Graph.edges(graph)).toEqual([
      { from: "root.catch", to: "root", reason: "value" },
      { from: "root.catch", to: "root.recover", reason: "continuation" },
      { from: "root.recover", to: "root", reason: "value" }
    ])
    expect(Graph.nodes(graph).find((node) => node.id === "root.recover")?.keyMaterial.inputs).toContainEqual({
      _tag: "Pending",
      from: "root.catch"
    })
  })

  it("records the catch filter schema in key material", () => {
    const filtered = Graph.build(
      Node.catch(Node.dynamic({ model: "writer" }), {
        error: Schema.Struct({ _tag: Schema.Literal("Timeout") }),
        onFailure: () => Node.succeed("fallback")
      })
    )
    const unfiltered = Graph.build(
      Node.catch(Node.dynamic({ model: "writer" }), { onFailure: () => Node.succeed("fallback") })
    )
    const body = (graph: Graph.Graph) => Graph.nodes(graph)[0]?.keyMaterial.body as { readonly error?: unknown }

    expect(body(filtered).error).toBeDefined()
    expect(body(unfiltered).error).toBeUndefined()
    expect(body(filtered)).not.toEqual(body(unfiltered))
  })

  it("hands the recovery arm a symbolic error that names the protected node", () => {
    const graph = Graph.build(
      Node.catch(Node.dynamic({ model: "writer" }), {
        onFailure: (error) => Node.succeed({ reason: (error as { readonly message: string }).message })
      })
    )

    expect(Graph.nodes(graph).find((node) => node.id === "root.recover")?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: { reason: { _tag: "PlannedInput", path: ["message"] } }
    })
  })

  it("rejects a recovery arm that does not return a node", () => {
    const invalid = Node.catch(Node.succeed("ok"), {
      onFailure: (() => "not a node") as unknown as () => Node.Node<string>
    })

    expect(() => Graph.build(invalid)).toThrow(Node.NodeBuildError)
  })

  it("plans a failing leaf and carries the failure into key material", () => {
    const graph = Graph.build(Node.fail({ _tag: "Timeout", after: 30 }))
    const other = Graph.build(Node.fail({ _tag: "Timeout", after: 60 }))

    expect(Graph.nodes(graph).map((node) => node.id)).toEqual(["root"])
    expect(Graph.nodes(graph)[0]?.kind).toBe("Fail")
    expect(Graph.nodes(graph)[0]?.keyMaterial.body).toEqual({
      _tag: "Fail",
      error: { _tag: "Timeout", after: 30 }
    })
    expect(Graph.nodes(other)[0]?.keyMaterial.body).not.toEqual(Graph.nodes(graph)[0]?.keyMaterial.body)
  })

  it("re-raises from a recovery arm", () => {
    const graph = Graph.build(
      Node.catch(Node.dynamic({ model: "writer" }), {
        onFailure: (error) => Node.fail(error)
      })
    )

    expect(Graph.nodes(graph).map((node) => node.id)).toEqual(["root", "root.catch", "root.recover"])
    expect(Graph.nodes(graph).find((node) => node.id === "root.recover")?.kind).toBe("Fail")
    expect(Graph.nodes(graph).find((node) => node.id === "root.recover")?.keyMaterial.body).toEqual({
      _tag: "Fail",
      error: { _tag: "PlannedInput", path: [] }
    })
  })

  it("carries an explicit priority onto the graph node and inherits it lexically", () => {
    const graph = Graph.build(
      Node.andThen(
        Node.priority(Node.all({ scan: Node.succeed("scan") }), 5),
        () => Node.succeed("done")
      )
    )
    const node = (id: string) => Graph.nodes(graph).find((candidate) => candidate.id === id)

    expect(node("root.andThen")?.priority).toBe(5)
    expect(node("root.andThen")?.annotations.priority).toBe(5)
    expect(node("root.andThen.all.scan")?.priority).toBe(5)
    expect(node("root.then")?.priority).toBeUndefined()
    expect(node("root")?.priority).toBeUndefined()
  })

  it("lets a child priority override the inherited one", () => {
    const graph = Graph.build(
      Node.priority(Node.all({ urgent: Node.priority(Node.succeed("a"), 9), normal: Node.succeed("b") }), 1)
    )
    const node = (id: string) => Graph.nodes(graph).find((candidate) => candidate.id === id)

    expect(node("root.all.urgent")?.priority).toBe(9)
    expect(node("root.all.normal")?.priority).toBe(1)
  })

  it("keeps priority out of key material so scheduling order cannot change step identity", () => {
    const body = () => Node.succeed("scan")
    const plain = keyMaterial(Graph.build(Flow.make({ body })))
    const prioritized = keyMaterial(Graph.build(Flow.make({ body: () => Node.priority(body(), 7) })))

    expect(prioritized).toEqual(plain)
  })

  it("rejects a priority that is not a safe integer", () => {
    expect(() => Node.priority(Node.succeed("a"), 1.5)).toThrow(Node.NodeBuildError)
    try {
      Node.priority(Node.succeed("a"), 1.5)
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_priority", member: "priority" })
    }
  })

  it("throws the typed flow error for declaration-only graphs", () => {
    expect(() => Graph.build(Flow.make({ name: "declared" }))).toThrow(Flow.FlowError)
  })
})
