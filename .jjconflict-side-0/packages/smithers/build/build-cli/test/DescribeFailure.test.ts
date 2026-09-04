import { describe, expect, it } from "vitest"
import * as Diagnostic from "../src/Diagnostic.ts"
import { describeFailure } from "../src/Executor.ts"

/**
 * The shape `@smthrs/targets` fails a target with. It is a plain object, so the
 * failure renderer walks it; every field below is what an operator acts on.
 */
const execError = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  _tag: "smithers-build/ExecError",
  argv: ["bun", "test", "src"],
  code: "exit_status",
  cwd: "apps/ui",
  exitCode: 1,
  stderr: "3 fail\n  routes > agents > spawns a session",
  stdout: "",
  ...overrides
})

/** Every rendering has to name these three, whatever else the value carries. */
const namesTheRun = (rendered: string): void => {
  expect(rendered).not.toBe("target failed")
  expect(rendered).toContain("bun")
  expect(rendered).toContain("exitCode")
  expect(rendered).toContain("routes > agents > spawns a session")
}

describe("describeFailure", () => {
  it("renders a plain failure as JSON", () => {
    namesTheRun(describeFailure(execError()))
  })

  it.each([
    ["an undefined member", { signal: undefined }, "<undefined>"],
    ["a bigint member", { durationNs: 12345n }, "<bigint 12345>"],
    ["a symbol member", { token: Symbol("spawn") }, "<Symbol(spawn)>"],
    ["a function member", { kill: function killTree() {} }, "<function killTree>"],
    ["a NaN member", { durationMs: Number.NaN }, "<NaN>"],
    ["an Infinity member", { durationMs: Number.POSITIVE_INFINITY }, "<Infinity>"],
    ["a negative-zero member", { drift: -0 }, "<-0>"]
  ])("still names the run when the value carries %s", (_name, extra, marker) => {
    const rendered = describeFailure(execError(extra))
    namesTheRun(rendered)
    expect(rendered).toContain(marker)
  })

  it("still names the run when the value closes a cycle", () => {
    const value = execError()
    value["self"] = value
    const rendered = describeFailure(value)
    namesTheRun(rendered)
    expect(rendered).toContain("<circular>")
  })

  it("names the argv, the exit code and the stderr of a run that overruns the byte budget", () => {
    // Both tails are `Exec.stderrTailLimit` (64 KiB) wide, which is more than
    // one diagnostic may carry, so this is the ordinary size of a failing test
    // target rather than a pathological one.
    const tail = 64 * 1024
    const rendered = describeFailure(execError({
      stderr: `${"e".repeat(tail - 40)}\n3 fail\n  routes > agents > spawns a session`,
      stdout: "o".repeat(tail)
    }))
    expect(rendered).not.toBe("target failed")
    expect(rendered).toContain("bun")
    expect(rendered).toContain("exitCode")
    expect(rendered).toContain("apps/ui")
    expect(rendered).toContain("truncated")
    expect(rendered.length).toBeLessThanOrEqual(Diagnostic.maximumMessageCodeUnits)
  })

  it("does not invoke an accessor while rendering a failure", () => {
    let reads = 0
    const value = execError()
    Object.defineProperty(value, "secret", {
      enumerable: true,
      get: () => {
        reads += 1
        return "leaked"
      }
    })
    const rendered = describeFailure(value)
    namesTheRun(rendered)
    expect(rendered).toContain("<accessor>")
    expect(reads).toBe(0)
  })

  it("leaves an Error to the message renderer rather than dumping its stack", () => {
    expect(describeFailure(new Error("the tool was terminated by SIGKILL"))).toBe(
      "the tool was terminated by SIGKILL"
    )
  })

  it("falls back for a value that carries nothing", () => {
    expect(describeFailure(undefined)).toBe("target failed")
    expect(describeFailure({})).toBe("target failed")
  })
})
