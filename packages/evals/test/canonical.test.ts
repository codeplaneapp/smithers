import { describe, expect, it } from "vitest"
import { compareText, encode, maxDepth, stringify } from "../src/internal/canonical.ts"

describe("canonical", () => {
  it("orders text by code unit and reports equality", () => {
    expect(compareText("a", "b")).toBe(-1)
    expect(compareText("b", "a")).toBe(1)
    expect(compareText("a", "a")).toBe(0)
  })

  it("sorts keys by code unit and normalises minus zero", () => {
    expect(stringify({ z: 1, "é": 2, a: -0, b: undefined })).toBe("{\"a\":0,\"z\":1,\"é\":2}\n")
  })

  it("marks a cycle instead of overflowing the stack", () => {
    const value: { self?: unknown; name: string } = { name: "root" }
    value.self = value
    expect(encode(value)).toEqual({ name: "root", self: "[circular]" })
  })

  it("keeps a value referenced twice without a cycle", () => {
    const shared = { a: 1 }
    expect(encode({ left: shared, right: shared })).toEqual({ left: { a: 1 }, right: { a: 1 } })
  })

  it("marks nesting past the declared depth", () => {
    let value: unknown = "leaf"
    for (let index = 0; index <= maxDepth + 1; index++) value = { next: value }
    expect(JSON.stringify(encode(value))).toContain("[depth exceeded]")
  })

  it("names every value JSON cannot express", () => {
    expect(encode({
      nan: Number.NaN,
      positive: Number.POSITIVE_INFINITY,
      negative: Number.NEGATIVE_INFINITY,
      big: 1n,
      fn: () => 1,
      sym: Symbol("s"),
      date: new Date("2026-01-01T00:00:00.000Z"),
      invalidDate: new Date(Number.NaN),
      error: new TypeError("boom"),
      set: new Set([1, 2]),
      map: new Map([["k", 1]]),
      list: [1, "two"]
    })).toEqual({
      big: "[bigint 1]",
      date: "2026-01-01T00:00:00.000Z",
      error: "[TypeError: boom]",
      fn: "[function]",
      invalidDate: "[invalid Date]",
      list: [1, "two"],
      map: [["k", 1]],
      nan: "[NaN]",
      negative: "[-Infinity]",
      positive: "[Infinity]",
      set: [1, 2],
      sym: "[symbol]"
    })
  })

  it("reports a getter that threw instead of throwing out of the encoder", () => {
    const value = {
      get boom(): string {
        throw new TypeError("no")
      }
    }
    expect(encode(value)).toEqual({ boom: "[unreadable: TypeError: no]" })
  })

  it("caps an embedded string and says how much it dropped", () => {
    expect(encode({ text: "abcdef" }, { maxStringLength: 3 })).toEqual({ text: "abc[truncated 3 chars]" })
    expect(encode({ text: "abc" }, { maxStringLength: 3 })).toEqual({ text: "abc" })
    expect(encode({ error: new TypeError("abcdef") }, { maxStringLength: 3 })).toEqual({
      error: "[TypeError: abc[truncated 3 chars]]"
    })
  })

  it("passes null and booleans through untouched", () => {
    expect(encode({ nothing: null, yes: true })).toEqual({ nothing: null, yes: true })
  })
})
