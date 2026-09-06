import { describe, expect, it } from "vitest"
import * as BoundedJson from "../src/internal/BoundedJson.ts"

const limits: BoundedJson.Limits = {
  maxBytes: 128,
  maxDepth: 8,
  maxMembers: 2,
  maxNodes: 32,
  maxStringBytes: 32,
  maxKeyBytes: 16
}

describe("cache JSON policy", () => {
  it("uses per-container member limits and returns only the cache result contract", () => {
    const value = { a: [1, 2], b: [3, 4] }
    expect(BoundedJson.admit(value, limits)).toEqual({ ok: true, value })
    expect(BoundedJson.admit([1, 2, 3], limits))
      .toEqual({ ok: false, complaint: "exceeds the JSON members limit" })
  })

  it("uses the canonical encoded byte count at its boundary", () => {
    expect(BoundedJson.admit("\n", { ...limits, maxBytes: 4, maxStringBytes: 4 }))
      .toEqual({ ok: true, value: "\n" })
    expect(BoundedJson.admit("\n", { ...limits, maxBytes: 3 })).toMatchObject({ ok: false })
  })
})
