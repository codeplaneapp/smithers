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

  it("sorts keys by code unit rather than the host locale", () => {
    expect(render({ a: 1, Z: 2 }, "json").text).toBe("{\"Z\":2,\"a\":1}")
  })

  it("marks a cycle instead of overflowing the stack", () => {
    const value: { self?: unknown } = {}
    value.self = value

    expect(render(value, "json").text).toBe("{\"self\":\"[Circular]\"}")
  })

  it("marks values nested past the deterministic depth limit", () => {
    const root: { child?: unknown } = {}
    let cursor = root
    for (let depth = 0; depth < 258; depth++) {
      const child: { child?: unknown } = {}
      cursor.child = child
      cursor = child
    }

    expect(render(root, "json").text).toContain("[Deep]")
  })

  it("renders BigInt and undefined in both formats", () => {
    expect(render(17n, "human").text).toBe("17n")
    expect(render(17n, "json").text).toBe("\"17n\"")
    expect(render(undefined, "human").text).toBe("[Undefined]")
    expect(render(undefined, "json").text).toBe("\"[Undefined]\"")
  })
})

describe("Output.exitCode", () => {
  it.each(
    [
      [
        "a parked receipt",
        { _tag: "Parked", receiptId: "receipt-1", planId: "plan-1", status: "waiting-approval" },
        3
      ],
      ["a cancelled terminal receipt", { _tag: "Terminal", runId: "run-1", status: "cancelled" }, 130],
      ["a failed terminal receipt", { _tag: "Terminal", runId: "run-1", status: "failed" }, 1],
      ["an accepted receipt", { _tag: "Accepted", receiptId: "receipt-1", runId: "run-1" }, 0],
      ["caller data tagged Parked", { _tag: "Parked" }, 0],
      ["caller data waiting for approval", { status: "waiting-approval" }, 0],
      ["caller data tagged Interrupted", { _tag: "Interrupted" }, 0],
      ["caller data carrying SIGINT", { signal: "SIGINT" }, 0],
      ["caller data carrying SIGTERM", { signal: "SIGTERM" }, 0],
      ["caller data tagged Error", { _tag: "Error" }, 0],
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

  it("ignores even several receipt-shaped markers on caller data", () => {
    expect(Output.exitCode({ _tag: "Error", status: "waiting-approval", signal: "SIGTERM" })).toBe(0)
  })

  it("stamps the same status onto the rendered value in either format", () => {
    const receipt = { _tag: "Parked", receiptId: "receipt-1", planId: "plan-1", status: "waiting-approval" }
    expect(render(receipt, "json").exitCode).toBe(3)
    expect(render(receipt, "human").exitCode).toBe(3)
  })

  it.each([
    { _tag: "Error" },
    { status: "waiting-approval" },
    { signal: "SIGINT" }
  ])("keeps receipt-like memory data successful: %j", (value) => {
    const rendered = render(Output.renderValue(value), "json")

    expect(JSON.parse(rendered.text)).toEqual(value)
    expect(rendered.exitCode).toBe(0)
  })

  it("keeps even a complete control-receipt shape successful when it is caller data", () => {
    const receipt = { _tag: "Terminal", runId: "run-1", status: "failed" }
    const rendered = render(Output.renderValue(receipt), "json")

    expect(rendered.text).toBe("{\"_tag\":\"Terminal\",\"runId\":\"run-1\",\"status\":\"failed\"}")
    expect(rendered.exitCode).toBe(0)
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
