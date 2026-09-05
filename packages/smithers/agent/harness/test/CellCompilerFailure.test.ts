import { describe, expect, it, vi } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as CellValidation from "../src/CellValidation.ts"

const { compilerFailure } = vi.hoisted(() => ({ compilerFailure: { cause: undefined as unknown } }))
vi.mock("@babel/parser", () => ({
  parse: () => {
    throw compilerFailure.cause
  }
}))

describe("cell compiler failure boundary", () => {
  it.each([null, "compiler unavailable", 0])("turns an unexpected compiler throw into a refusal (%s)", (cause) => {
    compilerFailure.cause = cause
    const result = CellValidation.validate(Cell.source("const x = 1"))
    expect(result.compiled).toBeUndefined()
    expect(result.rejected?.code).toBe("compile_failed")
    expect(result.rejected?.message).toBe(`The cell did not compile — ${String(cause)}`)
  })

  it("retains an out-of-source diagnostic without inventing a source line", () => {
    compilerFailure.cause = Object.assign(new Error("invalid emitted code"), { loc: { line: 10, column: 2 } })
    const result = CellValidation.validate(Cell.source("const x = 1"))
    expect(result.compiled).toBeUndefined()
    expect(result.rejected?.message).toBe("The cell did not compile — line 10, column 3: invalid emitted code")
  })
})
