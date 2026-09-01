import { Chunk, Option, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

const body = (value: unknown): unknown => Graph.nodes(Graph.build(Node.succeed(value)))[0]?.keyMaterial.body

const reflected = (value: unknown): unknown =>
  (body(value) as { readonly _tag: "Succeed"; readonly value: unknown }).value

describe("Graph reflection", () => {
  it("separates the formerly colliding exotic built-ins", () => {
    const bodies = [
      new Date(0),
      new Date(1),
      new Map([[1, 2]]),
      new Set([1, 2]),
      new Error("boom")
    ].map((value) => JSON.stringify(body(value)))

    expect(new Set(bodies).size).toBe(bodies.length)
    expect(body(new Uint8Array([1, 2]))).not.toEqual(body({ 0: 1, 1: 2 }))
    expect(body(() => 1)).not.toEqual(body(() => 2))
    expect(body(Symbol("a"))).not.toEqual(body(Symbol("a")))
  })

  it("escapes user objects that forge encoder tags", () => {
    const forged = reflected({ _tag: "Symbol", value: "a" })
    const actual = reflected(Symbol("a"))

    expect(forged).toEqual({
      _tag: "Escaped",
      value: { _tag: "Symbol", value: "a" }
    })
    expect(forged).not.toEqual(actual)
  })

  it("keeps local and registered symbol identities stable", () => {
    const local = Symbol("local")
    const registered = Symbol.for("@smthrs/core/test/reflection")

    expect(reflected(local)).toEqual(reflected(local))
    expect(reflected(registered)).toEqual({
      _tag: "Symbol",
      key: "@smthrs/core/test/reflection",
      description: "@smthrs/core/test/reflection",
      scope: "registered",
      id: "global:@smthrs/core/test/reflection"
    })
  })

  it("keys a well-known symbol by name and marks an unregistered one process-local", () => {
    expect(reflected(Symbol.iterator)).toEqual({
      _tag: "Symbol",
      key: null,
      description: "Symbol.iterator",
      scope: "well-known",
      id: "well-known:iterator"
    })

    const unregistered = reflected(Symbol("tenant")) as { readonly scope: string; readonly id: string }
    expect(unregistered.scope).toBe("process-local")
    // The nonce that seeds a process-local identity is the same one an
    // unannotated function's `sha256-source-ephemeral/v4` digest folds in, so
    // the encoding declares the cache miss instead of faking a stable key.
    expect(unregistered.id).toMatch(/^[0-9a-f]{32}:\d+$/)
  })

  it("describes accessors without invoking them", () => {
    let calls = 0
    const value = Object.defineProperty({}, "x", {
      enumerable: true,
      get: () => {
        calls++
        return "executed"
      }
    })

    expect(reflected(value)).toEqual({
      x: {
        _tag: "Accessor",
        get: {
          _tag: "FunctionIdentity",
          algorithm: "sha256-source-ephemeral/v4",
          digest: expect.any(String)
        },
        set: null
      }
    })
    expect(calls).toBe(0)
  })

  it("retains an own __proto__ data property", () => {
    const value = Object.create(null) as Record<string, unknown>
    Object.defineProperty(value, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { retained: true },
      writable: true
    })

    const result = reflected(value) as Record<string, unknown>
    expect(Object.hasOwn(result, "__proto__")).toBe(true)
    expect(result["__proto__"]).toEqual({ retained: true })
  })

  it("uses the documented structural encodings for supported built-ins", () => {
    expect(reflected(new Date(0))).toEqual({ _tag: "Date", epochMilliseconds: 0 })
    expect(reflected(new Date(Number.NaN))).toEqual({ _tag: "Date", epochMilliseconds: null })
    expect(reflected(/a+/gim)).toEqual({ _tag: "RegExp", source: "a+", flags: "gim" })
    expect(reflected(new Error("boom"))).toEqual({ _tag: "Error", name: "Error", message: "boom" })
    expect(reflected(new Map([[{ key: 1 }, { value: 2 }]]))).toEqual({
      _tag: "Map",
      entries: [[{ key: 1 }, { value: 2 }]]
    })
    expect(reflected(new Set([2, 1]))).toEqual({ _tag: "Set", values: [1, 2] })
    expect(reflected(new Uint8Array([1, 2]))).toEqual({
      _tag: "Bytes",
      kind: "Uint8Array",
      bytes: [1, 2]
    })
    expect(reflected(Option.none())).toEqual({ _tag: "Option", value: { _tag: "None" } })
    expect(reflected(Option.some({ revision: 1 }))).toEqual({
      _tag: "Option",
      value: { _tag: "Some", value: { revision: 1 } }
    })
    expect(reflected(Result.succeed(1))).toEqual({
      _tag: "Result",
      value: { _tag: "Success", value: 1 }
    })
    expect(reflected(Result.fail("boom"))).toEqual({
      _tag: "Result",
      value: { _tag: "Failure", error: "boom" }
    })
    expect(reflected(Chunk.make(2, 1))).toEqual({ _tag: "Chunk", values: [2, 1] })
    expect(reflected(new URL("https://example.test/a?b=1"))).toEqual({
      _tag: "URL",
      href: "https://example.test/a?b=1"
    })
  })

  it("canonicalizes Map insertion order", () => {
    const first = new Map<unknown, unknown>([["b", 2], ["a", 1]])
    const second = new Map<unknown, unknown>([["a", 1], ["b", 2]])

    expect(reflected(first)).toEqual(reflected(second))
  })

  it("rejects class instances with a typed path-bearing error", () => {
    class Client {}

    expect(() => Graph.build(Node.succeed({ config: { client: new Client() } }))).toThrow(Node.NodeBuildError)
    try {
      Graph.build(Node.succeed({ config: { client: new Client() } }))
    } catch (error) {
      expect(error).toMatchObject({
        code: "unrepresentable_value",
        member: "$.config.client",
        message:
          "Graph.build cannot derive identity for a \"Client\" instance at $.config.client; plan values must be plain data"
      })
    }
  })

  it("rejects non-finite numbers with a typed path-bearing error", () => {
    expect(() => Graph.build(Node.succeed({ config: { limit: Number.POSITIVE_INFINITY } })))
      .toThrow(Node.NodeBuildError)
    try {
      Graph.build(Node.succeed({ config: { limit: Number.POSITIVE_INFINITY } }))
    } catch (error) {
      expect(error).toMatchObject({
        code: "unrepresentable_value",
        member: "$.config.limit",
        message:
          "Graph.build cannot derive identity for a number at $.config.limit because it is not finite; plan values must be plain data"
      })
    }
  })

  it("pins exact JSON for stable representative values", () => {
    expect(JSON.stringify(body({ z: 3, a: [1, { b: "two" }] }))).toBe(
      "{\"_tag\":\"Succeed\",\"value\":{\"a\":[1,{\"b\":\"two\"}],\"z\":3}}"
    )
    expect(JSON.stringify(body(new Date(0)))).toBe(
      "{\"_tag\":\"Succeed\",\"value\":{\"_tag\":\"Date\",\"epochMilliseconds\":0}}"
    )
    expect(JSON.stringify(body({ _tag: "Symbol", value: "a" }))).toBe(
      "{\"_tag\":\"Succeed\",\"value\":{\"_tag\":\"Escaped\",\"value\":{\"_tag\":\"Symbol\",\"value\":\"a\"}}}"
    )
  })

  it("separates array shapes an index walk alone would collapse", () => {
    const decorated = Object.assign([1, 2], { extra: "x" })

    expect(reflected([1, 2])).toEqual([1, 2])
    expect(reflected(decorated)).toEqual({
      _tag: "Array",
      items: [1, 2],
      extra: { extra: "x" }
    })
    expect(reflected(decorated)).not.toEqual(reflected([1, 2]))
    // A key that only looks numeric is not an array index either.
    expect(reflected(Object.assign([1], { "01": "padded" }))).toEqual({
      _tag: "Array",
      items: [1],
      extra: { "01": "padded" }
    })

    // A hole and an explicit `undefined` both render as JSON null, so the
    // encoder has to separate them itself.
    // eslint-disable-next-line no-sparse-arrays
    expect(reflected([, 1])).toEqual([{ _tag: "Hole" }, 1])
    expect(reflected([undefined, 1])).toEqual([{ _tag: "Undefined" }, 1])
    // eslint-disable-next-line no-sparse-arrays
    expect(JSON.stringify(reflected([, 1]))).not.toBe(JSON.stringify(reflected([undefined, 1])))
  })

  it("names an unsupported data type in its refusal", () => {
    const tagged = Object.create({ _tag: "Some" }) as object

    expect(() => Graph.build(Node.succeed({ opt: tagged }))).toThrow(
      "Graph.build cannot derive identity for a \"Some\" instance at $.opt; plan values must be plain data"
    )
  })

  it("rejects forged Effect data without invoking accessors", () => {
    let calls = 0
    const option = Object.create(Object.getPrototypeOf(Option.some(1))) as object
    Object.defineProperty(option, "value", {
      enumerable: true,
      get: () => {
        calls++
        return 1
      }
    })
    const result = Object.create(Object.getPrototypeOf(Result.succeed(1))) as object

    expect(() => reflected(option)).toThrow(Node.NodeBuildError)
    expect(() => reflected(result)).toThrow(Node.NodeBuildError)
    expect(calls).toBe(0)
  })

  it("freezes the key material it hands back, including a literal input payload", () => {
    const accept = Flow.make({ input: Schema.Unknown, body: () => Node.succeed("ok") })
    const graph = Graph.build(accept({ nested: { revision: 1 } }))
    const literal = Graph.nodes(graph).find((node) => node.id === "root")?.keyMaterial.inputs
      .find((input) => input._tag === "Literal")

    if (literal?._tag !== "Literal") throw new Error("expected a literal input")
    const payload = literal.value as { readonly nested: { revision: number } }
    expect(Object.isFrozen(payload)).toBe(true)
    expect(Object.isFrozen(payload.nested)).toBe(true)
    expect(() => {
      ;(payload as { nested: unknown }).nested = 42
    }).toThrow(TypeError)
    expect(payload.nested.revision).toBe(1)
  })

  it("retains plan values by reference until graph construction", () => {
    const value = { revision: 1 }
    const node = Node.succeed(value)
    value.revision = 2

    expect(reflected(value)).toEqual({ revision: 2 })
    expect(Graph.nodes(Graph.build(node))[0]?.keyMaterial.body).toEqual({
      _tag: "Succeed",
      value: { revision: 2 }
    })
  })
})
