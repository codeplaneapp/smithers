import { describe, expect, it } from "vitest"
import * as Json from "../src/internal/json.ts"

const wide = (count: number): Record<string, number> => {
  const value: Record<string, number> = {}
  for (let index = 0; index < count; index += 1) value[`k${index.toString(36)}`] = index % 7
  return value
}

describe("lossyPath", () => {
  it("accepts a wide object whose own string keys are all enumerable", () => {
    expect(Json.lossyPath(wide(5_000), "meta")).toBeUndefined()
  })

  it("names the single non-enumerable property of a wide object", () => {
    const meta = wide(5_000)
    Object.defineProperty(meta, "hidden", { value: 1, enumerable: false })
    expect(Json.lossyPath(meta, "meta")).toBe("meta.hidden is a non-enumerable property")
  })

  it("names the first non-enumerable property in own-name order", () => {
    const meta: Record<string, number> = {}
    Object.defineProperty(meta, "first", { value: 1, enumerable: false })
    Object.assign(meta, wide(1_000))
    Object.defineProperty(meta, "last", { value: 1, enumerable: false })
    expect(Json.lossyPath(meta, "meta")).toBe("meta.first is a non-enumerable property")
  })

  it("names a non-enumerable property nested under a wide object", () => {
    const nested = { a: 1 }
    Object.defineProperty(nested, "hidden", { value: 1, enumerable: false })
    const meta = { ...wide(1_000), nested }
    expect(Json.lossyPath(meta, "meta")).toBe("meta.nested.hidden is a non-enumerable property")
  })

  it("reports the non-enumerable key before walking the values of a wide object", () => {
    const meta: Record<string, unknown> = wide(1_000)
    meta["k0"] = undefined
    Object.defineProperty(meta, "hidden", { value: 1, enumerable: false })
    expect(Json.lossyPath(meta, "meta")).toBe("meta.hidden is a non-enumerable property")
  })
})
