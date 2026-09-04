import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as Grep from "../src/Grep.ts"
import { MAX_LINE_CHARS } from "../src/internal/Text.ts"
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

  it("counts a trailing-newline file on the same line basis as grep", async () => {
    const files = { "/a.txt": "alpha\nbeta\n" }
    const read = await execute(Effect.provide(Read.run({ path: "/a.txt" }), layer({ files })))
    const grep = await execute(Effect.provide(
      Grep.run({ pattern: ".+", root: "/a.txt" }),
      layer({ files })
    ))

    expect(read).toMatchObject({ startLine: 1, endLine: 2, totalLines: 2, content: "alpha\nbeta" })
    expect(read.totalLines).toBe(grep.matches.at(-1)?.line)

    const exit = await execute(Effect.provide(
      Effect.exit(Read.run({ path: "/a.txt", offset: 3 })),
      layer({ files })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toMatchObject({ code: "offset_out_of_range" })
    }
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

  it.each([
    [
      "an astral scalar ending at the limit",
      `${"a".repeat(MAX_LINE_CHARS - 1)}😀tail`,
      `${"a".repeat(MAX_LINE_CHARS - 1)}😀`
    ],
    [
      "an astral scalar starting after the limit",
      `${"a".repeat(MAX_LINE_CHARS)}😀tail`,
      "a".repeat(MAX_LINE_CHARS)
    ],
    [
      "a combining sequence",
      `${"a".repeat(MAX_LINE_CHARS - 2)}étail`,
      `${"a".repeat(MAX_LINE_CHARS - 2)}é`
    ],
    [
      "a ZWJ sequence",
      `${"a".repeat(MAX_LINE_CHARS - 3)}👩‍💻tail`,
      `${"a".repeat(MAX_LINE_CHARS - 3)}👩‍💻`
    ]
  ])("clips %s by Unicode scalar values", async (_kind, source, expected) => {
    const result = await execute(Effect.provide(
      Read.run({ path: "/unicode.txt" }),
      layer({ files: { "/unicode.txt": source } })
    ))

    expect(result.content).toBe(expected)
    expect([...result.content].some((scalar) => scalar.length === 1 && /[\uD800-\uDFFF]/u.test(scalar))).toBe(false)
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

  it("reads an empty file as an empty page instead of refusing it", async () => {
    // An empty file has no lines, so a first-page read of one is not an
    // out-of-range read: the caller asked for page one and there is nothing on
    // it. Only an offset past the first line of a file that has none is.
    const result = await execute(Effect.provide(
      Read.run({ path: "/a.txt" }),
      layer({ files: { "/a.txt": "" } })
    ))
    expect(result).toMatchObject({ content: "", totalLines: 0, truncated: false })

    const exit = await execute(Effect.provide(
      Effect.exit(Read.run({ path: "/a.txt", offset: 2 })),
      layer({ files: { "/a.txt": "" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(Cause.isFailReason(reason!) && reason!.error).toMatchObject({ code: "offset_out_of_range" })
    }
  })

  it("declares sealed hermetic effects and narrows each invocation", () => {
    expect(Read.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Read.effectsFor({ path: "/a.txt" }).reads).toEqual(["/a.txt"])
  })
})
