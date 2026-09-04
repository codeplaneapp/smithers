import { describe, expect, it } from "vitest"
import { compareText } from "../src/internal/Ordering.ts"

describe("host-independent text ordering", () => {
  it("orders by UTF-16 code units and admits equality", () => {
    expect(compareText("a", "b")).toBe(-1)
    expect(compareText("b", "a")).toBe(1)
    expect(compareText("same", "same")).toBe(0)
  })
})
