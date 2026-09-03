import { describe, expect, it } from "vitest"
import * as CanonicalJson from "../src/CanonicalJson.ts"

describe("CanonicalJson", () => {
  it("encodes differently constructed objects as identical bytes", () => {
    const first: Record<string, unknown> = {}
    first["z"] = { b: 2, a: 1 }
    first["a"] = "value"
    const second: Record<string, unknown> = {}
    second["a"] = "value"
    second["z"] = { a: 1, b: 2 }

    expect([...CanonicalJson.bytes(first)]).toEqual([...CanonicalJson.bytes(second)])
    expect(CanonicalJson.stringify(first)).toBe("{\"a\":\"value\",\"z\":{\"a\":1,\"b\":2}}")
  })

  it("preserves array order", () => {
    expect(CanonicalJson.stringify({ a: [3, { a: 1 }, 2] })).toBe("{\"a\":[3,{\"a\":1},2]}")
  })

  it("rejects nested values which JSON.stringify would silently coerce", () => {
    for (
      const invalid of [
        { schema: { multipleOf: Number.NaN } },
        { schema: { generatedAt: new Date(0) } },
        { schema: { metadata: new Map([["key", "value"]]) } },
        { schema: { omitted: undefined } }
      ]
    ) {
      expect(() => CanonicalJson.stringify(invalid)).toThrow(/not valid JSON/)
    }
  })

  it("encodes an own __proto__ member instead of dropping it", () => {
    // `JSON.parse` produces `__proto__` as an own data property, and a tool's
    // JSON Schema may declare a property with that name. Copying members into a
    // `{}` literal would route it through `Object.prototype`'s setter and lose
    // it, so the sealed-step key would not describe the body actually sent.
    const parsed = JSON.parse("{\"a\":1,\"__proto__\":{\"changed\":true}}") as Record<string, unknown>

    expect(CanonicalJson.stringify(parsed)).toBe("{\"__proto__\":{\"changed\":true},\"a\":1}")
    expect(new TextDecoder().decode(CanonicalJson.bytes(parsed))).toBe(CanonicalJson.stringify(parsed))
    // `JSON.stringify` keeps the member too; only the key order differs.
    expect(JSON.stringify(parsed)).toContain("\"__proto__\"")
    // The member is data, never a prototype mutation.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(({} as { readonly changed?: unknown }).changed).toBeUndefined()
  })

  it("keeps pi's short-hash algorithm golden-vectored", () => {
    expect(CanonicalJson.shortHash("pi-tool-search")).toBe("10rp88s7t1h18")
  })

  it("rejects a self-referential array or object instead of recursing forever", () => {
    const cyclicArray: Array<unknown> = ["first"]
    cyclicArray.push(cyclicArray)
    expect(() => CanonicalJson.stringify({ items: cyclicArray })).toThrow("Value at $.items[1] is not valid JSON")

    const cyclicObject: Record<string, unknown> = { a: 1 }
    cyclicObject["self"] = cyclicObject
    expect(() => CanonicalJson.stringify(cyclicObject)).toThrow("Value at $.self is not valid JSON")

    // The same object twice is a diamond, not a cycle, and stays encodable.
    const shared = { b: 2 }
    expect(CanonicalJson.stringify({ left: shared, right: shared })).toBe("{\"left\":{\"b\":2},\"right\":{\"b\":2}}")
  })

  it("rejects symbol-keyed objects and non-finite numbers", () => {
    expect(() => CanonicalJson.stringify({ [Symbol("hidden")]: 1, visible: 2 })).toThrow(
      "Value at $ is not valid JSON"
    )
    expect(() => CanonicalJson.stringify({ a: Number.POSITIVE_INFINITY })).toThrow("Value at $.a is not valid JSON")
    expect(() => CanonicalJson.stringify({ a: Number.NEGATIVE_INFINITY })).toThrow("Value at $.a is not valid JSON")
    expect(() => CanonicalJson.stringify(() => 1)).toThrow("Value at $ is not valid JSON")
    expect(() => CanonicalJson.stringify(undefined)).toThrow("Value at $ is not valid JSON")
  })

  it("encodes the empty, single-member, and primitive boundaries", () => {
    expect(CanonicalJson.stringify({})).toBe("{}")
    expect(CanonicalJson.stringify([])).toBe("[]")
    expect(CanonicalJson.stringify({ only: [] })).toBe("{\"only\":[]}")
    expect(CanonicalJson.stringify({ "": "" })).toBe("{\"\":\"\"}")
    expect(CanonicalJson.stringify({ a: null })).toBe("{\"a\":null}")
    expect(CanonicalJson.stringify(null)).toBe("null")
    expect(CanonicalJson.stringify(true)).toBe("true")
    expect(CanonicalJson.stringify("text")).toBe("\"text\"")
    expect(CanonicalJson.stringify(0)).toBe("0")
    expect(CanonicalJson.stringify(-1.5)).toBe("-1.5")
  })

  it("keeps the digest stable across key insertion order at every nesting depth", () => {
    const deep = (order: "forward" | "reverse"): unknown => {
      const leaf: Record<string, unknown> = {}
      if (order === "forward") {
        leaf["a"] = "é😀"
        leaf["b"] = [1, { y: 2, x: 1 }]
      } else {
        leaf["b"] = [1, { x: 1, y: 2 }]
        leaf["a"] = "é😀"
      }
      const middle: Record<string, unknown> = {}
      if (order === "forward") {
        middle["nested"] = leaf
        middle["zero"] = 0
      } else {
        middle["zero"] = 0
        middle["nested"] = leaf
      }
      return { root: middle }
    }

    expect(CanonicalJson.stringify(deep("forward"))).toBe(CanonicalJson.stringify(deep("reverse")))
    expect([...CanonicalJson.bytes(deep("forward"))]).toEqual([...CanonicalJson.bytes(deep("reverse"))])
    expect(CanonicalJson.stringify(deep("forward"))).toBe(
      "{\"root\":{\"nested\":{\"a\":\"é😀\",\"b\":[1,{\"x\":1,\"y\":2}]},\"zero\":0}}"
    )
    // UTF-8 bytes, not UTF-16 code units: `é` is two bytes and the emoji four.
    expect(CanonicalJson.bytes({ k: "é😀" })).toHaveLength(14)
    expect(new TextDecoder().decode(CanonicalJson.bytes({ k: "é😀" }))).toBe("{\"k\":\"é😀\"}")
  })

  it("hashes the empty string and distinguishes single-character inputs", () => {
    expect(CanonicalJson.shortHash("")).toBe("k4n83c7h0j2b")
    expect(CanonicalJson.shortHash("a")).toBe("m8735310ae7sx")
    expect(CanonicalJson.shortHash("b")).toBe("jbf49n1hx4dkv")
    expect(CanonicalJson.shortHash("é😀")).toBe("102l7zrk951la")
    expect(CanonicalJson.shortHash("a")).toBe(CanonicalJson.shortHash("a"))
  })
})
