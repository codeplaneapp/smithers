import { Result } from "effect"
import { describe, expect, it } from "vitest"
import * as Digest from "../src/Digest.ts"
import * as Graph from "../src/Graph.ts"
import * as Node from "../src/Node.ts"

const canonicalMaterial = (value: unknown): string =>
  Digest.canonical(Result.getOrThrow(Graph.keyMaterial(Graph.build(Node.succeed(value)))))

const reflected = (value: unknown): unknown => {
  const body = Graph.nodes(Graph.build(Node.succeed(value)))[0]?.keyMaterial.body as {
    readonly _tag: "Succeed"
    readonly value: unknown
  }
  return body.value
}

describe("Graph injective reflection", () => {
  it("distinguishes undefined from null and array holes in full key material", () => {
    expect(canonicalMaterial([undefined, 1])).not.toBe(canonicalMaterial([null, 1]))
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalMaterial([, 1])).not.toBe(canonicalMaterial([undefined, 1]))
    expect(canonicalMaterial({ a: undefined })).not.toBe(canonicalMaterial({}))
  })

  it("distinguishes negative zero at root and nested positions", () => {
    expect(canonicalMaterial(-0)).not.toBe(canonicalMaterial(0))
    expect(canonicalMaterial([-0])).not.toBe(canonicalMaterial([0]))
  })

  it("refuses enumerable and non-enumerable symbol-keyed record properties", () => {
    for (const enumerable of [true, false]) {
      const key = Symbol("s")
      const value = { v: 1 }
      Object.defineProperty(value, key, { enumerable, value: 1 })

      expect(() => Graph.build(Node.succeed(value))).toThrow(Node.NodeBuildError)
      try {
        Graph.build(Node.succeed(value))
        throw new Error("expected symbol-keyed property to be refused")
      } catch (error) {
        expect(error).toMatchObject({
          code: "unrepresentable_value",
          member: "$",
          message:
            "Graph.build cannot derive identity for the symbol-keyed property Symbol(s) at $; plan values must use string keys"
        })
      }
    }
  })

  it("refuses symbol-keyed array properties", () => {
    const key = Symbol("s")
    const value = [1]
    Object.defineProperty(value, key, { enumerable: true, value: 2 })

    expect(() => Graph.build(Node.succeed(value))).toThrow(Node.NodeBuildError)
    try {
      Graph.build(Node.succeed(value))
      throw new Error("expected symbol-keyed property to be refused")
    } catch (error) {
      expect(error).toMatchObject({
        code: "unrepresentable_value",
        member: "$",
        message:
          "Graph.build cannot derive identity for the symbol-keyed property Symbol(s) at $; plan values must use string keys"
      })
    }
  })

  it("keys accessors by function identity without invoking them", () => {
    let calls = 0
    const first = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        calls++
        return 1
      }
    })
    const second = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        calls++
        return 2
      }
    })

    expect(canonicalMaterial(first)).not.toBe(canonicalMaterial(second))
    expect(canonicalMaterial(first)).toBe(canonicalMaterial(first))
    expect(calls).toBe(0)

    const setterOnly = Object.defineProperty({}, "value", {
      enumerable: true,
      set: () => {
        calls++
      }
    })
    expect(reflected(setterOnly)).toMatchObject({
      value: { _tag: "Accessor", get: null, set: { _tag: "FunctionIdentity" } }
    })
    expect(calls).toBe(0)
  })

  it("escapes literal Undefined and Number tags away from their real encodings", () => {
    const literalUndefined = { _tag: "Undefined" }
    const literalNegativeZero = { _tag: "Number", value: "-0" }

    expect(reflected(literalUndefined)).toEqual({ _tag: "Escaped", value: literalUndefined })
    expect(reflected(literalNegativeZero)).toEqual({ _tag: "Escaped", value: literalNegativeZero })
    expect(canonicalMaterial([literalUndefined])).not.toBe(canonicalMaterial([undefined]))
    expect(canonicalMaterial([literalNegativeZero])).not.toBe(canonicalMaterial([-0]))
  })
})
