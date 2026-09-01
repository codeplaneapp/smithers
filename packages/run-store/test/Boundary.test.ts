import { describe, expect, it } from "vitest"
import * as Boundary from "../src/internal/Boundary.ts"

const limits = (overrides: Partial<Boundary.JsonLimits> = {}): Boundary.JsonLimits => ({
  maxBytes: 1_024,
  maxDepth: 8,
  maxMembers: 32,
  maxNodes: 64,
  maxStringBytes: 512,
  maxKeyBytes: 128,
  ...overrides
})

const complaint = (value: unknown, overrides?: Partial<Boundary.JsonLimits>): string => {
  const result = Boundary.admitJson(value, limits(overrides))
  expect(result.ok).toBe(false)
  return result.ok ? "" : result.complaint
}

describe("run-store inert JSON boundary", () => {
  it("validates complete durable UTF-16 text", () => {
    expect(Boundary.isDurableText("plain")).toBe(true)
    expect(Boundary.isDurableText("\u{1f600}")).toBe(true)
    expect(Boundary.isDurableText(1)).toBe(false)
    expect(Boundary.isDurableText("")).toBe(false)
    expect(Boundary.isDurableText("ab", 1)).toBe(false)
    expect(Boundary.isDurableText("a\0b")).toBe(false)
    expect(Boundary.isDurableText("\ud800")).toBe(false)
    expect(Boundary.isDurableText("\udc00")).toBe(false)
  })

  it("accounts for every scalar encoding and bound", () => {
    for (const value of [null, true, false, 0, -1.5, "ascii", "\"\\\u0001é中\u{1f600}"]) {
      expect(Boundary.admitJson(value, limits()).ok).toBe(true)
    }
    expect(complaint(Number.NaN)).toMatch(/non-finite/)
    expect(complaint(Number.POSITIVE_INFINITY)).toMatch(/non-finite/)
    expect(complaint(BigInt(1))).toMatch(/non-JSON/)
    expect(complaint(undefined)).toMatch(/non-JSON/)
    expect(complaint(Symbol("x"))).toMatch(/non-JSON/)
    expect(complaint(() => 1)).toMatch(/non-JSON/)
    expect(complaint("\ud800")).toMatch(/ill-formed/)
    expect(complaint("\udc00")).toMatch(/ill-formed/)
    expect(complaint("a", { maxStringBytes: 2 })).toMatch(/unbounded/)
    for (const value of [null, true, false, 123, "x"]) {
      expect(complaint(value, { maxBytes: 0 })).toMatch(/byte limit/)
    }
    expect(complaint([[0]], { maxDepth: 1 })).toMatch(/depth/)
    expect(complaint([0, 1], { maxNodes: 2 })).toMatch(/JSON values/)
  })

  it("copies arrays without accepting sparse, accessor, or extra members", () => {
    const admitted = Boundary.admitJson([1, { nested: true }], limits())
    expect(admitted).toMatchObject({ ok: true, value: [1, { nested: true }] })
    if (admitted.ok) {
      expect(Object.isFrozen(admitted.value)).toBe(true)
      expect(Object.isFrozen((admitted.value as ReadonlyArray<unknown>)[1])).toBe(true)
    }

    expect(complaint([1, 2], { maxMembers: 1 })).toMatch(/members/)
    expect(complaint([], { maxBytes: 1 })).toMatch(/byte limit/)
    expect(complaint(new Array(1))).toMatch(/sparse/)
    const accessor: Array<unknown> = [0]
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 })
    expect(complaint(accessor)).toMatch(/accessor array/)
    expect(complaint([undefined])).toMatch(/non-JSON/)
    const extra = [1] as Array<unknown> & { extra?: number }
    extra.extra = 2
    expect(complaint(extra)).toMatch(/non-index/)
    const virtualIndex = new Proxy([1], {
      ownKeys: (target) => [...Reflect.ownKeys(target), "2"],
      getOwnPropertyDescriptor: (target, key) =>
        key === "2"
          ? { configurable: true, enumerable: true, value: 2, writable: true }
          : Reflect.getOwnPropertyDescriptor(target, key)
    })
    expect(complaint(virtualIndex)).toMatch(/non-index/)
    const hidden = [1]
    Object.defineProperty(hidden, "hidden", { value: 2, enumerable: false })
    expect(Boundary.admitJson(hidden, limits()).ok).toBe(true)
  })

  it("copies only inert plain object properties", () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype.value = { nested: 1 }
    const admitted = Boundary.admitJson(nullPrototype, limits())
    expect(admitted.ok).toBe(true)
    if (admitted.ok) expect(Object.getPrototypeOf(admitted.value)).toBeNull()

    expect(complaint(new Date())).toMatch(/non-plain/)
    const symbol = Symbol("enumerable")
    expect(complaint({ [symbol]: 1 })).toMatch(/symbol/)
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 })
    expect(complaint(accessor)).toMatch(/accessor/)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(complaint(cycle)).toMatch(/cycle/)
    expect(complaint({ a: 1, b: 2 }, { maxMembers: 1 })).toMatch(/members/)
    expect(complaint({}, { maxBytes: 1 })).toMatch(/byte limit/)
    expect(complaint({ abc: 1 }, { maxKeyBytes: 2 })).toMatch(/object key/)
    expect(complaint({ "\ud800": 1 })).toMatch(/object key/)
    expect(complaint({ a: 1 }, { maxBytes: 3 })).toMatch(/byte limit/)
    expect(complaint({ a: undefined })).toMatch(/non-JSON/)

    const disappearing = new Proxy({}, {
      ownKeys: () => ["ghost"],
      getOwnPropertyDescriptor: () => undefined
    })
    expect(Boundary.admitJson(disappearing, limits())).toMatchObject({ ok: true, value: {} })
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new Error("hostile")
      }
    })
    expect(complaint(hostile)).toMatch(/without executing/)
  })

  it("parses bounded JSON text while preserving its original bytes", () => {
    expect(Boundary.admitJsonText(null, limits())).toMatchObject({ ok: false })
    expect(Boundary.admitJsonText("", limits())).toMatchObject({ ok: false })
    expect(Boundary.admitJsonText("{", limits())).toMatchObject({ ok: false, complaint: "must be valid JSON text" })
    expect(Boundary.admitJsonText("[[0]]", limits({ maxDepth: 1 }))).toMatchObject({ ok: false })
    expect(Boundary.admitJsonText("  null  ", limits({ maxBytes: 4 }))).toMatchObject({
      ok: false,
      complaint: "exceeds the JSON byte limit"
    })
    expect(Boundary.admitJsonText(" {\"a\":1} ", limits())).toMatchObject({
      ok: true,
      value: " {\"a\":1} ",
      json: { a: 1 }
    })
  })
})
