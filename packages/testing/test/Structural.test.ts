/**
 * The one structural canonicalizer four modules used to each carry a private,
 * subtly wrong copy of.
 */
import { describe, expect, it } from "vitest"
import { canonical, compare, same, snapshot } from "../src/internal/Structural.ts"
import * as ModelLike from "../src/ModelLike.ts"

describe("same", () => {
  it("separates the values Object.keys collapsed to an empty record", () => {
    expect(same(new Date(0), new Date(1))).toBe(false)
    expect(same(new Map([["a", 1]]), new Set([1]))).toBe(false)
    expect(same(-0, 0)).toBe(false)
    expect(same(Number.NaN, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it("still answers true for the values it always compared correctly", () => {
    expect(same({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true)
    expect(same([1, [2, 3]], [1, [2, 3]])).toBe(true)
    expect(same("a", "a")).toBe(true)
    expect(same(undefined, undefined)).toBe(true)
  })

  it("separates a missing key from an undefined one, and arrays from records", () => {
    expect(same({ a: undefined }, {})).toBe(false)
    expect(same([1], { 0: 1 })).toBe(false)
  })
})

describe("compare", () => {
  it("orders by code unit, so a rendering is byte-identical under any locale", () => {
    expect(["zebra", "äpple", "banana"].sort(compare)).toEqual(["banana", "zebra", "äpple"])
    // Matches the bare `.sort()` the effects list already uses.
    expect(["step-a", "stepa", "Step"].sort(compare)).toEqual(["step-a", "stepa", "Step"].sort())
  })
})

describe("canonical", () => {
  it("tags every value JSON cannot express instead of dropping it", () => {
    expect(canonical(undefined)).toContain("Undefined")
    expect(canonical(1n)).toContain("BigInt")
    expect(canonical(Symbol("s"))).toContain("Symbol")
    expect(canonical(() => 1)).toContain("Function")
    expect(canonical(/a/g)).toContain("RegExp")
    expect(canonical(new Date(Number.NaN))).toContain("Invalid Date")
  })

  it("keeps a foreign object's constructor name so two classes never look alike", () => {
    class Ticket {}
    expect(canonical(new Ticket())).toContain("Ticket")
  })

  it("renders a null-prototype record as a plain record", () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.a = 1
    expect(canonical(bare)).toBe(canonical({ a: 1 }))
  })
})

describe("snapshot", () => {
  it("deep-copies the plain spine", () => {
    const source = { a: { b: [1, { c: 2 }] } }
    const copied = snapshot(source)
    source.a.b.push(3)
    ;(source.a.b[1] as { c: number }).c = 99
    expect(copied).toEqual({ a: { b: [1, { c: 2 }] } })
  })

  it("passes a non-plain value through rather than throwing on it", () => {
    const when = new Date(0)
    expect(snapshot({ when }).when).toBe(when)
    const fn = () => 1
    expect(snapshot({ fn }).fn).toBe(fn)
  })

  it("terminates on a cycle in a record and in an array", () => {
    const cyclic: Record<string, unknown> = { name: "a" }
    cyclic.self = cyclic
    expect((snapshot(cyclic).self as Record<string, unknown>).name).toBe("a")
    const loop: Array<unknown> = [1]
    loop.push(loop)
    expect((snapshot(loop)[1] as Array<unknown>)[0]).toBe(1)
  })

  it("keeps a symbol-keyed property so the fixture encoder can still reject it", () => {
    const key = Symbol("s")
    expect(Object.getOwnPropertySymbols(snapshot({ [key]: 1 }))).toEqual([key])
  })
})

describe("ModelLike.make", () => {
  it("builds the seam from its one method", () => {
    const stream = () => null as never
    const model = ModelLike.make({ stream })
    expect(model.stream).toBeTypeOf("function")
  })
})
