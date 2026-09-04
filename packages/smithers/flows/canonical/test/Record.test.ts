import { describe, expect, it } from "vitest"
import { isRecord } from "../src/Record.ts"

describe("isRecord", () => {
  it("excludes arrays, null, functions, and primitive values", () => {
    for (const value of [[], [1], null, undefined, () => ({}), true, 1, "x", Symbol("x"), 1n]) {
      expect(isRecord(value)).toBe(false)
    }
  })
  it("accepts object records without inspecting members or prototypes", () => {
    const getter = {
      get value() {
        throw new Error("must not read properties")
      }
    }
    for (const value of [{}, { value: 1 }, Object.create(null), getter, new Date(0)]) {
      expect(isRecord(value)).toBe(true)
    }
  })
})
