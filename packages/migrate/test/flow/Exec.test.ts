/**
 * Command output is bounded while the command runs, not after it exits.
 *
 * A verification command may print more than a process can hold. Every case
 * here spawns a real child, so the window slides over real pipe chunks, and
 * the assertions are about the bytes a report keeps and the bytes it counts.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exec from "../../src/flow/internal/Exec.ts"

const node = (script: string) => Exec.run("node", { args: ["-e", script] }).pipe(Effect.provide(NodeServices.layer))

const byteLength = (text: string): number => new TextEncoder().encode(text).length

describe("Exec.run bounds each stream", () => {
  it.live("keeps the last window of a multi-megabyte stdout and counts the rest", () =>
    Effect.gen(function*() {
      // 5 MB of a repeating line, so the kept tail is checkable by content.
      const script = "const line = 'x'.repeat(99) + '\\n'; for (let i = 0; i < 52_429; i++) process.stdout.write(line)"
      const total = 100 * 52_429

      const result = yield* node(script)

      expect(result.exitCode).toBe(0)
      const marker = /^\[(\d+) earlier bytes omitted\]\n/.exec(result.stdout)
      expect(marker).not.toBeNull()
      const body = result.stdout.slice(marker![0].length)
      expect(byteLength(body)).toBeLessThanOrEqual(Exec.tailBytes)
      expect(Number(marker![1]) + byteLength(body)).toBe(total)
      expect(body.endsWith("\n")).toBe(true)
      expect(body.replaceAll("\n", "").replaceAll("x", "")).toBe("")
      expect(result.stderr).toBe("")
    }))

  it.live("bounds stderr and stdout independently and at the same time", () =>
    Effect.gen(function*() {
      // Written synchronously to the pipes and ended by an exit code, not by
      // `process.exit`, which would drop whatever a pipe had not yet taken.
      const script = [
        "const fs = require('node:fs'); const out = 'o'.repeat(1024); const err = 'e'.repeat(1024);",
        "for (let i = 0; i < 200; i++) { fs.writeSync(1, out); fs.writeSync(2, err) }",
        "process.exitCode = 3"
      ].join("\n")

      const result = yield* node(script)

      expect(result.exitCode).toBe(3)
      for (const [text, character] of [[result.stdout, "o"], [result.stderr, "e"]] as const) {
        const marker = /^\[(\d+) earlier bytes omitted\]\n/.exec(text)
        expect(marker).not.toBeNull()
        const body = text.slice(marker![0].length)
        expect(byteLength(body)).toBe(Exec.tailBytes)
        expect(Number(marker![1])).toBe(200 * 1024 - Exec.tailBytes)
        expect(body).toBe(character.repeat(Exec.tailBytes))
      }
    }))

  it.live("cuts the window at a character boundary, never inside a multi-byte sequence", () =>
    Effect.gen(function*() {
      // Two-byte characters, an odd count of bytes before the window would
      // start: the first kept byte is a continuation byte unless the window
      // is trimmed to a boundary.
      const script = "process.stdout.write('é'.repeat(20_000))"

      const result = yield* node(script)

      const body = result.stdout.replace(/^\[\d+ earlier bytes omitted\]\n/, "")
      expect(body).not.toContain("�")
      expect(new Set(body)).toEqual(new Set(["é"]))
      expect(byteLength(body)).toBeLessThanOrEqual(Exec.tailBytes)
      expect(byteLength(body)).toBeGreaterThan(Exec.tailBytes - 4)
    }))

  it.live("returns small output whole, with no marker", () =>
    Effect.gen(function*() {
      const result = yield* node("process.stdout.write('hello'); process.stderr.write('there')")

      expect(result.stdout).toBe("hello")
      expect(result.stderr).toBe("there")
    }))
})

describe("Exec.tail", () => {
  it("is idempotent over its own output, adding to one marker rather than stacking them", () => {
    const text = "a".repeat(30) + "b".repeat(30)
    const once = Exec.tail(text, 40)
    expect(once).toBe(`[20 earlier bytes omitted]\n${"a".repeat(10)}${"b".repeat(30)}`)
    expect(Exec.tail(once, 40)).toBe(once)
    // A second, tighter pass keeps one marker and adds what it dropped.
    expect(Exec.tail(once, 25)).toBe(`[35 earlier bytes omitted]\n${"b".repeat(25)}`)
    expect(Exec.tail("short", 40)).toBe("short")
  })

  it("trims to a character boundary when the cut lands inside a sequence", () => {
    const text = "é".repeat(10)
    const tailed = Exec.tail(text, 5)
    expect(tailed).toBe(`[16 earlier bytes omitted]\n${"é".repeat(2)}`)
  })
})
