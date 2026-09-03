import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  approxTokenCount,
  formatExecOutputForModel,
  truncateMiddleChars,
  truncateMiddleWithTokenBudget
} from "../src/internal/CodexText.ts"
import * as ShellCommand from "../src/ShellCommand.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("CodexText", () => {
  it("estimates tokens at four bytes per token, rounding up", () => {
    expect(approxTokenCount("")).toBe(0)
    expect(approxTokenCount("abcd")).toBe(1)
    expect(approxTokenCount("abcde")).toBe(2)
  })

  it("returns short strings unchanged", () => {
    expect(truncateMiddleWithTokenBudget("hello", 10)).toEqual({ text: "hello", originalTokenCount: undefined })
  })

  it("truncates the middle with the Codex token marker and reports the original count", () => {
    const input = `${"a".repeat(400)}MIDDLE${"b".repeat(400)}`
    const { originalTokenCount, text } = truncateMiddleWithTokenBudget(input, 10)
    expect(text).toMatch(/^a+…\d+ tokens truncated…b+$/)
    expect(text.startsWith("a")).toBe(true)
    expect(text.endsWith("b")).toBe(true)
    expect(originalTokenCount).toBe(approxTokenCount(input))
  })

  it("cuts on UTF-8 character boundaries", () => {
    const input = "🙂".repeat(100)
    const { text } = truncateMiddleWithTokenBudget(input, 4)
    expect(text).toContain("tokens truncated")
    expect([...text.replace(/…\d+ tokens truncated…/, "")].every((c) => c === "🙂")).toBe(true)
  })

  it("truncates by chars with the chars marker", () => {
    const out = truncateMiddleChars("abcdefghij", 4)
    expect(out).toBe("ab…6 chars truncated…ij")
  })

  it("formats exec output with exit code and wall time", () => {
    const out = formatExecOutputForModel({
      durationSeconds: 1.234,
      exitCode: 0,
      maxOutputTokens: 10_000,
      output: "hello\nworld"
    })
    expect(out).toBe("Exit code: 0\nWall time: 1.2 seconds\nOutput:\nhello\nworld")
  })

  it("discloses total output lines only when truncated and prepends timeout text", () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n")
    const out = formatExecOutputForModel({
      durationSeconds: 2,
      exitCode: 124,
      maxOutputTokens: 10,
      output: big,
      timedOutAfterMs: 10_000
    })
    expect(out).toContain("Exit code: 124")
    expect(out).toContain("Total output lines: 201")
    expect(out).toContain("Output:\ncommand timed out af")
    expect(out).toContain("tokens truncated")
  })
})

describe("ShellCommand", () => {
  it("runs a command and formats the Codex output", async () => {
    const result = await execute(Effect.provide(
      ShellCommand.run({ command: "echo-hi" }),
      layer({ commands: { "echo-hi": { stdout: "hi\n", exitCode: 0 } } })
    ))
    expect(result.exitCode).toBe(0)
    expect(result.output.startsWith("Exit code: 0\nWall time: ")).toBe(true)
    expect(result.output).toContain("Output:\nhi\n")
  })

  it("keeps non-zero exit codes in the success channel", async () => {
    const result = await execute(Effect.provide(
      ShellCommand.run({ command: "boom" }),
      layer({ commands: { boom: { stderr: "bad\n", exitCode: 7 } } })
    ))
    expect(result.exitCode).toBe(7)
    expect(result.output).toContain("Exit code: 7")
    expect(result.output).toContain("bad")
  })

  it("bounds capture while retaining the tail of very large output", async () => {
    const head = "HEAD-WOULD-SURVIVE-UNBOUNDED-CAPTURE\n"
    const tail = "\nRETAINED-TAIL"
    const stdout = `${head}${"x".repeat(ShellCommand.MAX_CAPTURE_BYTES * 2)}${tail}`
    const result = await execute(Effect.provide(
      ShellCommand.run({ command: "very-large" }),
      layer({ commands: { "very-large": { stdout } } })
    ))

    expect(result.output).not.toContain(head.trim())
    expect(result.output).toContain(tail.trim())
    expect(new TextEncoder().encode(result.output).byteLength).toBeLessThan(ShellCommand.MAX_CAPTURE_BYTES)
  })
})
