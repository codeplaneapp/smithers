import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as internal from "../src/internal/node.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const declaration = Effects.make({
  reads: ["src/**"],
  writes: ["dist/**"],
  mode: "hermetic",
  onConflict: "serialize"
})

describe("Node", () => {
  it("constructs succeed, all, and dynamic AST nodes", () => {
    const name = Node.succeed("Ada")
    const age = Node.succeed(37)
    const combined = Node.all({ name, age })
    const dynamic = Node.dynamic({
      model: "test-model",
      flows: ["lookup"],
      output: { Type: "" },
      prompt: "Summarize",
      effects: declaration
    })

    expect(name.ast).toMatchObject({ _tag: "Succeed", value: "Ada" })
    expect(combined.ast).toMatchObject({
      _tag: "All",
      nodes: {
        name: name.ast,
        age: age.ast
      }
    })
    expect(dynamic.ast).toMatchObject({
      _tag: "Dynamic",
      model: "test-model",
      flows: ["lookup"],
      output: { Type: "" },
      prompt: "Summarize",
      effects: declaration
    })
    expect(Node.dynamic({}).ast).toMatchObject({ _tag: "Dynamic", flows: [] })
    expect(Node.isNode(combined)).toBe(true)
    expect(Node.isNode({ ast: combined.ast })).toBe(false)
  })

  it("supports data-first and data-last map", () => {
    const source = Node.succeed(2)
    const increment = (value: number) => value + 1
    const dataFirst = Node.map(source, increment)
    const dataLast = source.pipe(Node.map((value) => value * 3))

    expect(dataFirst.ast._tag).toBe("Map")
    expect(dataLast.ast._tag).toBe("Map")
    if (dataFirst.ast._tag === "Map" && dataLast.ast._tag === "Map") {
      expect(dataFirst.ast.first).toBe(source.ast)
      expect(dataFirst.ast.mapper).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataLast.ast.first).toBe(source.ast)
      expect(dataLast.ast.mapper).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataFirst.ast.mapper).not.toEqual(dataLast.ast.mapper)
      expect(JSON.stringify(dataFirst.ast)).not.toContain("increment")
    }
  })

  it("supports data-first and data-last andThen with deferred continuations", () => {
    const source = Node.succeed(2)
    let continuationCalls = 0
    const stringify = (value: number) => {
      continuationCalls++
      return Node.succeed(String(value))
    }
    const dataFirst = Node.andThen(source, stringify)
    const dataLast = source.pipe(Node.andThen((value) => Node.succeed(value * 3)))
    const next = Node.succeed("done")
    const staticFirst = Node.andThen(source, next)
    const staticLast = source.pipe(Node.andThen(next))

    expect(continuationCalls).toBe(0)
    for (const node of [dataFirst, dataLast, staticFirst, staticLast]) {
      expect(node.ast._tag).toBe("AndThen")
    }
    if (
      dataFirst.ast._tag === "AndThen" &&
      dataLast.ast._tag === "AndThen" &&
      staticFirst.ast._tag === "AndThen" &&
      staticLast.ast._tag === "AndThen"
    ) {
      expect(dataFirst.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataLast.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "sha256-source-ephemeral/v4"
      })
      expect(dataFirst.ast.continuation).not.toEqual(dataLast.ast.continuation)
      expect(staticFirst.ast.continuation).toMatchObject({
        _tag: "FunctionIdentity",
        algorithm: "static-node/v1",
        digest: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
      expect(staticLast.ast.continuation).toEqual(staticFirst.ast.continuation)
      expect(staticFirst.ast.next).toBe(next.ast)
      expect(staticLast.ast.next).toBe(next.ast)
      expect(continuationCalls).toBe(0)
    }
  })

  it("supports data-first and data-last within", () => {
    const source = Node.succeed("value")
    const placement = Placement.sandbox({ image: "flows:test" })
    const dataFirst = Node.within(source, placement)
    const dataLast = source.pipe(Node.within(placement))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Placement))).toBe(
      placement
    )
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Placement))).toBe(
      placement
    )
  })

  it("supports data-first and data-last lane", () => {
    const source = Node.succeed("value")
    const options = { id: "review", landing: "merge-queue" } as const
    const dataFirst = Node.lane(source, options)
    const dataLast = source.pipe(Node.lane(options))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Lane))).toBe(options)
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Lane))).toBe(options)
  })

  it("supports data-first and data-last withEffects", () => {
    const source = Node.succeed("value")
    const dataFirst = Node.withEffects(source, declaration)
    const dataLast = source.pipe(Node.withEffects(declaration))

    expect(Option.getOrUndefined(Annotations.getOption(dataFirst.ast.annotations, Annotations.Effects))).toBe(
      declaration
    )
    expect(Option.getOrUndefined(Annotations.getOption(dataLast.ast.annotations, Annotations.Effects))).toBe(
      declaration
    )
  })

  it("does not mutate the original AST or annotations while piping", () => {
    const source = Node.succeed({ value: 1 })
    const originalAst = source.ast
    const placed = source.pipe(Node.within(Placement.local()))
    const mapped = source.pipe(Node.map((value) => value.value))

    expect(source.ast).toBe(originalAst)
    expect(placed).not.toBe(source)
    expect(placed.ast).not.toBe(source.ast)
    expect(mapped).not.toBe(source)
    expect(mapped.ast).not.toBe(source.ast)
    expect(Option.isNone(Annotations.getOption(source.ast.annotations, Annotations.Placement))).toBe(true)
  })

  it("constructs structurally identical ASTs deterministically", () => {
    const build = () =>
      Node.all({
        input: Node.succeed({ id: 42 }),
        model: Node.dynamic({
          model: "test-model",
          flows: ["lookup"],
          prompt: "Inspect"
        })
      })

    expect(build().ast).toEqual(build().ast)
  })

  it("uses full SHA-256 identities without source normalization collisions", () => {
    function f2152() {
      return 2152
    }
    function f19965() {
      return 19965
    }
    const identity = (operation: () => unknown) => {
      const ast = Node.map(Node.succeed(undefined), operation).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }

    const one = identity(f2152)
    const two = identity(f19965)
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(one).not.toEqual(two)
    expect(identity(Function("return 'one space'") as () => unknown))
      .not.toEqual(identity(Function("return 'one  space'") as () => unknown))
  })

  it("fails closed when separate raw closures have indistinguishable source", () => {
    const make = (offset: number) => (value: number) => value + offset
    const one = make(1)
    const alsoOne = make(1)
    const identity = (operation: (value: number) => number) => {
      const ast = Node.map(Node.succeed(1), operation).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }

    expect(identity(one)).toEqual(identity(one))
    expect(identity(one)).not.toEqual(identity(alsoOne))
    expect(() => internal.functionIdentity(null)).toThrow(/requires a function/)
  })

  it("includes declared closure captures in identity and freezes them", () => {
    const make = (offset: number) => {
      const captures = { offset, nested: { stable: true } }
      const operation = Node.capture(captures, (value: number) => value + offset)
      return { captures, operation, node: Node.map(Node.succeed(1), operation) }
    }
    const one = make(1)
    const same = make(1)
    const two = make(2)
    const identity = (node: Node.Node<number>) => {
      if (node.ast._tag !== "Map") throw new Error("expected Map")
      return node.ast.mapper
    }

    expect(one.operation(2)).toBe(3)
    expect(identity(one.node)).toEqual(identity(same.node))
    expect(identity(one.node)).not.toEqual(identity(two.node))
    expect(identity(one.node).algorithm).toBe("sha256-source-captures/v4")
    expect(Node.functionIdentity(one.operation)).toEqual(identity(one.node))
    expect(Object.isFrozen(one.captures)).toBe(true)
    expect(Object.isFrozen(one.captures.nested)).toBe(true)
    expect(() => Node.capture({ value: Number.NaN }, () => undefined)).toThrow(/is not finite/)
  })

  it("composes nested capture identity without erasing the inner operation", () => {
    const identity = (operation: (value: number) => number) => {
      const ast = Node.map(Node.succeed(1), operation).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }
    const add = (value: number) => value + 1
    const multiply = (value: number) => value * 2

    expect(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, add))))
      .not.toEqual(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, multiply))))
    expect(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, add))))
      .not.toEqual(identity(Node.capture({ outer: 1 }, Node.capture({ inner: 3 }, add))))
  })

  it("keeps identical nested captures stable and distinct from a single capture", () => {
    const operation = (value: number) => value + 1
    const identity = (captured: (value: number) => number) => {
      const ast = Node.map(Node.succeed(1), captured).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }
    const nested = () => Node.capture({ outer: 1 }, Node.capture({ inner: 2 }, operation))

    expect(identity(nested())).toEqual(identity(nested()))
    expect(identity(nested())).not.toEqual(identity(Node.capture({ inner: 2, outer: 1 }, operation)))
  })

  it("rejects a malformed capture operation with the package-shaped message", () => {
    expect(() => Node.capture({}, "nope" as unknown as () => unknown))
      .toThrow(new TypeError("Node.capture requires a function operation"))
  })

  it("canonicalizes every supported capture shape and rejects ambiguous data", () => {
    const operation = () => undefined
    const identity = (captures: Readonly<Record<string, unknown>>) => {
      const ast = Node.map(Node.succeed(undefined), Node.capture(captures, operation)).ast
      if (ast._tag !== "Map") throw new Error("expected Map")
      return ast.mapper
    }

    expect(identity({ a: 1, b: 2 })).toEqual(identity({ b: 2, a: 1 }))
    expect(identity({ value: -0 })).not.toEqual(identity({ value: 0 }))
    expect(() => identity({ array: [null, true, false, "text"], empty: Object.create(null) })).not.toThrow()
    const shared = { value: 1 }
    expect(() => identity({ left: shared, right: shared })).not.toThrow()

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => identity(cyclic)).toThrow(/is cyclic/)
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 })
    expect(() => identity(accessor)).toThrow(/is an accessor/)
    expect(() => identity({ [Symbol("key")]: 1 })).toThrow(/has symbol key/)
    expect(() => identity({ date: new Date(0) })).toThrow(/non-plain prototype/)
    expect(() => identity({ values: Array(1) })).toThrow(/is an array hole/)
    for (const value of [undefined, 1n, Symbol("value"), operation]) {
      expect(() => identity({ value })).toThrow(/has unsupported type/)
    }

    const arrayAccessor: Array<unknown> = []
    Object.defineProperty(arrayAccessor, "0", { enumerable: true, get: () => 1 })
    expect(() => identity({ arrayAccessor })).toThrow(/is an accessor/)
    const arrayProperty: Array<unknown> = []
    Object.defineProperty(arrayProperty, "extra", { enumerable: true, value: 1 })
    expect(() => identity({ arrayProperty })).toThrow(/unsupported array key extra/)
    const arraySymbol: Array<unknown> = []
    Object.defineProperty(arraySymbol, Symbol("extra"), { enumerable: true, value: 1 })
    expect(() => identity({ arraySymbol })).toThrow(/unsupported array key Symbol\(extra\)/)

    const baseline = identity({ array: [1, 2, 3] })
    expect(identity({ array: [1, 2, 3] })).toEqual(baseline)

    const ghost = [1, 2, 3]
    Object.defineProperty(ghost, "4294967295", { enumerable: true, value: 4 })
    expect(() => identity({ array: ghost })).toThrow(
      new TypeError(
        "Node.capture: capture at $.array has unsupported array key 4294967295; captures must be finite, inert data"
      )
    )

    let outOfRangeDescriptor: PropertyDescriptor | undefined
    const outOfRange = new Proxy([1, 2, 3], {
      defineProperty: (target, key, descriptor) => {
        if (key !== "10") return Reflect.defineProperty(target, key, descriptor)
        outOfRangeDescriptor = { ...descriptor, configurable: true }
        return true
      },
      getOwnPropertyDescriptor: (target, key) =>
        key === "10" ? outOfRangeDescriptor : Reflect.getOwnPropertyDescriptor(target, key),
      ownKeys: (target) => [...Reflect.ownKeys(target), "10"]
    })
    Object.defineProperty(outOfRange, "10", { configurable: true, enumerable: true, value: 4 })
    expect(Object.hasOwn(outOfRange, "10")).toBe(true)
    expect(() => identity({ array: outOfRange })).toThrow(
      new TypeError(
        "Node.capture: capture at $.array has unsupported array key 10; captures must be finite, inert data"
      )
    )
  })

  it("bounds capture nesting with an exact typed error", () => {
    const nested = (depth: number): Readonly<Record<string, unknown>> => {
      let value: unknown = "leaf"
      for (let index = 0; index < depth; index++) value = { value }
      return value as Readonly<Record<string, unknown>>
    }
    const operation = () => undefined

    expect(() => Node.capture(nested(256), operation)).not.toThrow()
    const path = `$${".value".repeat(257)}`
    expect(() => Node.capture(nested(257), operation)).toThrow(
      new TypeError(
        `Node.capture: capture at ${path} exceeds the maximum capture depth of 256; captures must be finite, inert data`
      )
    )
  })

  it("rejects non-Node members with NodeBuildError", () => {
    const invalid = { valid: Node.succeed("ok"), invalid: 42 } as unknown as Readonly<Record<string, Node.Any>>

    expect(() => Node.all(invalid)).toThrow(Node.NodeBuildError)
    try {
      Node.all(invalid)
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "flows/core/NodeBuildError",
        code: "invalid_all_member",
        member: "invalid"
      })
    }
  })

  it("retains prototype-like Node.all member names", () => {
    const combined = Node.all({
      ["__proto__"]: Node.succeed("proto"),
      constructor: Node.succeed("constructor"),
      prototype: Node.succeed("prototype")
    })

    if (combined.ast._tag !== "All") throw new Error("expected All")
    expect(Object.getPrototypeOf(combined.ast.nodes)).toBeNull()
    expect(Object.keys(combined.ast.nodes)).toEqual(["__proto__", "constructor", "prototype"])
  })
})
