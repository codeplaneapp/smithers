import { describe, expect, it } from "vitest"
import * as BoundedJson from "../src/internal/BoundedJson.ts"

const limits: BoundedJson.Limits = {
  maxBytes: 1_024,
  maxDepth: 8,
  maxMembers: 8,
  maxNodes: 32,
  maxStringBytes: 128,
  maxKeyBytes: 64
}

const accepted = (value: unknown, overrides: Partial<BoundedJson.Limits> = {}) =>
  BoundedJson.admit(value, { ...limits, ...overrides })

describe("bounded JSON admission", () => {
  it("copies every JSON scalar and UTF-8 width without approximation", () => {
    for (const value of [null, true, false, 0, -1.5, "ascii", "\"\\\n", "é", "€", "😀"]) {
      expect(accepted(value)).toMatchObject({ ok: true })
    }
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n, Symbol("x"), () => 1]) {
      expect(accepted(value)).toMatchObject({ ok: false })
    }
  })

  it("rejects ill-formed and over-budget strings and keys", () => {
    for (const value of ["\ud800", "\udc00", "x".repeat(128)]) {
      expect(accepted(value, { maxStringBytes: 4 })).toMatchObject({ ok: false })
    }
    expect(accepted({ ["x".repeat(65)]: 1 })).toMatchObject({ ok: false })
    expect(accepted({ "\ud800": 1 })).toMatchObject({ ok: false })
    expect(accepted({ long: 1 }, { maxBytes: 4 })).toMatchObject({ ok: false })
  })

  it("enforces depth, node, member, and structural byte budgets", () => {
    expect(accepted({ child: { child: true } }, { maxDepth: 1 })).toMatchObject({ ok: false })
    expect(accepted([1, 2], { maxNodes: 2 })).toMatchObject({ ok: false })
    expect(accepted([1, 2], { maxMembers: 1 })).toMatchObject({ ok: false })
    expect(accepted({ a: 1, b: 2 }, { maxMembers: 1 })).toMatchObject({ ok: false })
    expect(accepted([], { maxBytes: 1 })).toMatchObject({ ok: false })
    expect(accepted({}, { maxBytes: 1 })).toMatchObject({ ok: false })
    expect(accepted(null, { maxBytes: 3 })).toMatchObject({ ok: false })
    expect(accepted(true, { maxBytes: 3 })).toMatchObject({ ok: false })
    expect(accepted(false, { maxBytes: 4 })).toMatchObject({ ok: false })
    expect(accepted(123, { maxBytes: 2 })).toMatchObject({ ok: false })
    expect(accepted("a", { maxBytes: 2 })).toMatchObject({ ok: false })
  })

  // The byte budget models what the canonical encoder emits, and canonical
  // JSON escapes backspace, tab, newline, form feed, and carriage return as two
  // characters rather than as `\u00XX`. Charging six for them refused values
  // whose encoded form sat well inside the advertised bound, which is exactly
  // the shape a newline-heavy step result takes.
  it("charges a control character what its canonical escape actually costs", () => {
    const shortEscaped = "\b\t\n\f\r"
    const shortBytes = JSON.stringify(shortEscaped).length
    expect(shortBytes).toBe(12)
    expect(accepted(shortEscaped, { maxBytes: shortBytes, maxStringBytes: shortBytes }))
      .toMatchObject({ ok: true })
    expect(accepted(shortEscaped, { maxBytes: shortBytes - 1, maxStringBytes: shortBytes - 1 }))
      .toMatchObject({ ok: false })

    const longEscaped = "\u0001"
    const longBytes = JSON.stringify(longEscaped).length
    expect(longBytes).toBe(8)
    expect(accepted(longEscaped, { maxBytes: longBytes, maxStringBytes: longBytes }))
      .toMatchObject({ ok: true })
    expect(accepted(longEscaped, { maxBytes: longBytes - 1, maxStringBytes: longBytes - 1 }))
      .toMatchObject({ ok: false })
  })

  it("rejects cyclic, sparse, accessor-backed, and augmented arrays", () => {
    const cycle: Array<unknown> = []
    cycle.push(cycle)
    expect(accepted(cycle)).toMatchObject({ ok: false })
    expect(accepted(Array(1))).toMatchObject({ ok: false })
    const accessor: Array<unknown> = [1]
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 })
    expect(accepted(accessor)).toMatchObject({ ok: false })
    const augmented = [1] as Array<unknown> & { extra?: number }
    augmented.extra = 2
    expect(accepted(augmented)).toMatchObject({ ok: false })
    const symbol = [1] as Array<unknown>
    Object.defineProperty(symbol, Symbol("extra"), { value: 2, enumerable: true })
    expect(accepted(symbol)).toMatchObject({ ok: false })
    const invalidLength = new Proxy([1], {
      getOwnPropertyDescriptor: (target, key) =>
        key === "length"
          ? { ...Object.getOwnPropertyDescriptor(target, key)!, value: "invalid" }
          : Object.getOwnPropertyDescriptor(target, key)
    })
    expect(accepted(invalidLength)).toMatchObject({ ok: false })
    const phantomIndex = new Proxy([1], {
      ownKeys: (target) => [...Reflect.ownKeys(target), "2"],
      getOwnPropertyDescriptor: (target, key) =>
        key === "2"
          ? { value: 2, enumerable: true, configurable: true, writable: true }
          : Object.getOwnPropertyDescriptor(target, key)
    })
    expect(accepted(phantomIndex)).toMatchObject({ ok: false })
    const hidden = Object.defineProperty([1], "extra", { value: 2, enumerable: false })
    expect(accepted(hidden)).toMatchObject({ ok: true })
  })

  it("rejects non-plain, accessor, symbol, and hostile objects without invoking getters", () => {
    expect(accepted(new Date())).toMatchObject({ ok: false })
    let reads = 0
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        reads++
        return 1
      }
    })
    expect(accepted(accessor)).toMatchObject({ ok: false })
    expect(reads).toBe(0)
    const symbol = Object.defineProperty({}, Symbol("value"), { value: 1, enumerable: true })
    expect(accepted(symbol)).toMatchObject({ ok: false })
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile")
      }
    })
    expect(accepted(hostile)).toMatchObject({ ok: false })
    const phantom = new Proxy({}, {
      ownKeys: () => ["phantom"],
      getOwnPropertyDescriptor: () => undefined
    })
    expect(accepted(phantom)).toMatchObject({ ok: true })
  })

  it("returns detached deeply frozen arrays and null-prototype objects", () => {
    const input = { array: [{ value: 1 }] }
    const result = accepted(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(input)
    expect(result.value).not.toBe(input)
    expect(Object.isFrozen(result.value)).toBe(true)
    const array = (result.value as { readonly array: ReadonlyArray<object> }).array
    expect(Object.isFrozen(array)).toBe(true)
    expect(Object.isFrozen(array[0])).toBe(true)
  })
})
