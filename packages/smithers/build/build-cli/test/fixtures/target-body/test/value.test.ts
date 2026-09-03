import { describe, expect, it } from "vitest"
import { value } from "../src/value.ts"

describe("value", () => {
  it("is real", () => {
    expect(value).toBe(42)
  })
})
