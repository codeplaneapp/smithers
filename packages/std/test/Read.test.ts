import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as Read from "../src/Read.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Read", () => {
  it("reads raw text with the default page and numbers it in sibling fields", async () => {
    const result = await execute(Effect.provide(
      Read.run({ path: "/a.txt" }),
      layer({
        files: { "/a.txt": "alpha\nbeta\ngamma" }
      })
    ))
    expect(result).toMatchObject({ startLine: 1, endLine: 3, totalLines: 3, truncated: false })
    // Raw: a line of this is an edit anchor as it stands.
    expect(result.content).toBe("alpha\nbeta\ngamma")
  })

  it("pages from a 1-based offset", async () => {
    const result = await execute(Effect.provide(
      Read.run({ path: "/a.txt", offset: 2, limit: 1 }),
      layer({
        files: { "/a.txt": "one\ntwo\nthree" }
      })
    ))
    expect(result).toMatchObject({ startLine: 2, endLine: 2, totalLines: 3, truncated: true })
    expect(result.content).toBe("two")
    expect(result.notice).toBeDefined()
  })

  it("caps long displayed lines and discloses the cap", async () => {
    const result = await execute(Effect.provide(
      Read.run({ path: "/a.txt" }),
      layer({
        files: { "/a.txt": "x".repeat(2_001) }
      })
    ))
    expect(result.truncated).toBe(true)
    expect(result.notice).toBeDefined()
    expect(result.content.length).toBeLessThan(2_100)
  })

  it("discloses rendered-output truncation", async () => {
    const result = await execute(Effect.provide(
      Read.run({ path: "/a.txt", limit: 2_000 }),
      layer({
        files: { "/a.txt": Array.from({ length: 2_000 }, () => "x".repeat(100)).join("\n") }
      })
    ))
    expect(result.truncated).toBe(true)
    expect(result.notice).toBeDefined()
  })

  it("fails with a typed binary_file error", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Read.run({ path: "/binary.txt" })),
      layer({
        files: { "/binary.txt": "before\0after" }
      })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("binary_file")
    }
  })

  it("fails with a typed offset_out_of_range error", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Read.run({ path: "/a.txt", offset: 4 })),
      layer({
        files: { "/a.txt": "one\ntwo" }
      })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("offset_out_of_range")
    }
  })

  it("ends a byte-capped page on a whole line", async () => {
    // A partial last line reads like an anchor and is not one, so the page ends
    // at the last whole line the budget could afford.
    const result = await execute(Effect.provide(
      Read.run({ path: "/a.txt" }),
      layer({
        files: { "/a.txt": Array.from({ length: 2_000 }, (_, index) => `${index}:${"x".repeat(100)}`).join("\n") }
      })
    ))
    expect(result.truncated).toBe(true)
    expect(result.content.endsWith("x")).toBe(true)
    expect(result.content.split("\n")).toHaveLength(result.endLine - result.startLine + 1)
    expect(result.content.split("\n").at(-1)).toBe(`${result.endLine - 1}:${"x".repeat(100)}`)
  })

  it("declares sealed hermetic effects and narrows each invocation", () => {
    expect(Read.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Read.effectsFor({ path: "/a.txt" }).reads).toEqual(["/a.txt"])
  })
})
