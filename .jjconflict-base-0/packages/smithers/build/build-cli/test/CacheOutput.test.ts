import { describe, expect, it } from "vitest"
import { decodeCacheOutput, encodeCacheOutput } from "../src/Executor.ts"

describe("cache output envelopes", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a plain record", { a: 1, b: [true, "x"] }]
  ])("round trips %s", (_name, value) => {
    const encoded = encodeCacheOutput(value)
    expect(encoded).toHaveProperty("output")
    if (!("output" in encoded)) throw new Error(encoded.reason)
    expect(decodeCacheOutput(encoded.output)).toEqual({ value })
  })

  it.each([
    ["a cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }],
    ["a nested undefined", () => ({ value: undefined })],
    ["NaN", () => ({ value: Number.NaN })],
    ["Infinity", () => ({ value: Number.POSITIVE_INFINITY })],
    ["a bigint", () => ({ value: 1n })],
    ["a function", () => ({ value: () => 1 })],
    ["a symbol", () => ({ value: Symbol("s") })],
    ["a Date", () => ({ value: new Date(0) })],
    ["a Map", () => ({ value: new Map([["a", 1]]) })],
    ["a class instance", () => ({
      value: new (class Holder {
        readonly a = 1
      })()
    })],
    ["a sparse array", () => ({ value: [1, , 3] })],
    ["negative zero", () => -0],
    ["an array property", () => Object.assign([1], { extra: 2 })],
    ["a symbol key", () => ({ [Symbol.for("smthrs/test")]: 1 })],
    ["a non-enumerable property", () => {
      const value = { visible: 1 }
      Object.defineProperty(value, "hidden", { value: 2, enumerable: false })
      return value
    }],
    ["a Proxy", () => new Proxy({ value: 1 }, {})]
  ])("refuses %s", (_name, build) => {
    expect(encodeCacheOutput(build())).toHaveProperty("reason")
  })

  it("refuses an accessor without invoking it", () => {
    let calls = 0
    const value = {}
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get: () => {
        calls += 1
        return "leaked"
      }
    })
    expect(encodeCacheOutput(value)).toHaveProperty("reason")
    expect(calls).toBe(0)
  })

  it("refuses malformed envelopes", () => {
    expect(decodeCacheOutput(null)).toHaveProperty("reason")
    expect(decodeCacheOutput({ _tag: "smithers-build/cache-output/undefined-v1", extra: true }))
      .toHaveProperty("reason")
    expect(decodeCacheOutput({ _tag: "unknown", value: 1 })).toHaveProperty("reason")
  })
})
