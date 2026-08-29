/**
 * The deterministic rendering projection and the exit statuses it drives.
 *
 * Every command prints through this module, so its normalization (stable key
 * order, redaction) and its value-to-status mapping are the CLI's whole
 * observable contract for scripts.
 */
import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Output from "../src/Output.ts"

const render = (value: unknown, format: Output.Format) => Effect.runSync(Output.make().render(value, format))

describe("Output.make human rendering", () => {
  it("prints a string value verbatim rather than quoting it", () => {
    expect(render("already rendered\nlines", "human").text).toBe("already rendered\nlines")
  })

  it("prints the empty string as nothing at all", () => {
    expect(render("", "human").text).toBe("")
  })

  it("indents every non-string value, including scalars and the empty object", () => {
    expect(render({ b: 1, a: 2 }, "human").text).toBe("{\n  \"a\": 2,\n  \"b\": 1\n}")
    expect(render({}, "human").text).toBe("{}")
    expect(render([], "human").text).toBe("[]")
    expect(render(7, "human").text).toBe("7")
    expect(render(null, "human").text).toBe("null")
  })

  it("redacts a top-level secret in both formats", () => {
    const secret = Redacted.make("alpha-secret")
    expect(render(secret, "human").text).toBe("<redacted>")
    expect(render(secret, "json").text).toBe("\"<redacted>\"")
  })

  it("redacts secrets nested inside arrays and objects alike", () => {
    const value = { list: [Redacted.make("one"), { token: Redacted.make("two") }] }
    expect(render(value, "json").text).toBe("{\"list\":[\"<redacted>\",{\"token\":\"<redacted>\"}]}")
  })

  it("sorts keys at every depth so two renders of the same value are byte-identical", () => {
    const value = { z: { y: 1, a: [{ d: 1, c: 2 }] }, a: null }
    expect(render(value, "json").text).toBe("{\"a\":null,\"z\":{\"a\":[{\"c\":2,\"d\":1}],\"y\":1}}")
    expect(render(value, "json").text).toBe(render(value, "json").text)
  })
})

describe("Output.exitCode", () => {
  it.each(
    [
      ["a parked receipt", { _tag: "Parked" }, 3],
      ["a run waiting for approval", { status: "waiting-approval" }, 3],
      ["an interrupted receipt", { _tag: "Interrupted" }, 130],
      ["a SIGINT report", { signal: "SIGINT" }, 130],
      ["a SIGTERM report", { signal: "SIGTERM" }, 143],
      ["an error receipt", { _tag: "Error" }, 1],
      ["an accepted receipt", { _tag: "Accepted" }, 0],
      ["an empty object", {}, 0],
      ["an empty array", [], 0],
      ["null", null, 0],
      ["a string", "waiting-approval", 0],
      ["a number", 3, 0],
      ["undefined", undefined, 0]
    ] as const
  )("maps %s to %i", (_label, value, expected) => {
    expect(Output.exitCode(value)).toBe(expected)
  })

  it("prefers the parked status over every other marker on the same value", () => {
    // The checks are ordered, so a value carrying several markers reports the
    // one an operator has to act on first.
    expect(Output.exitCode({ _tag: "Error", status: "waiting-approval", signal: "SIGTERM" })).toBe(3)
    expect(Output.exitCode({ _tag: "Error", signal: "SIGINT" })).toBe(130)
    expect(Output.exitCode({ _tag: "Error", signal: "SIGTERM" })).toBe(143)
  })

  it("stamps the same status onto the rendered value in either format", () => {
    expect(render({ _tag: "Parked" }, "json").exitCode).toBe(3)
    expect(render({ _tag: "Parked" }, "human").exitCode).toBe(3)
  })
})

describe("CliError.exitCode", () => {
  it("separates a malformed invocation from an unsupported one", () => {
    expect(CliError.exitCode(new CliError.UsageError({ message: "bad" }))).toBe(2)
    expect(CliError.exitCode(new CliError.UnsupportedError({ message: "no" }))).toBe(1)
  })

  it("keeps the tag each failure is matched on", () => {
    expect(new CliError.UsageError({ message: "bad" })._tag).toBe("/cli/UsageError")
    expect(new CliError.UnsupportedError({ message: "no" })._tag).toBe("/cli/UnsupportedError")
  })
})
