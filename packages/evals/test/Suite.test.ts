import * as Flow from "@smthrs/core/Flow"
import * as Binding from "@smthrs/scorers/Binding"
import * as Scorer from "@smthrs/scorers/Scorer"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { EvalError } from "../src/EvalError.ts"
import * as Suite from "../src/Suite.ts"

/** Runs an effect that must fail and returns the typed failure it raised. */
const failure = (effect: Effect.Effect<unknown, EvalError>): Promise<EvalError> =>
  Effect.runPromise(Effect.flip(effect))

const target = Flow.make({ name: "suite-target" })
const scorer = Scorer.make({
  id: "packages/evals/test/Suite/exact",
  version: "1",
  name: "exact",
  score: () => Effect.succeed({ score: 1 })
})

describe("Suite", () => {
  it("rejects an empty or control-character suite name", async () => {
    const empty = await failure(Suite.make({ name: "  ", concurrency: 1, cases: [{ name: "a", input: 1 }] }))
    expect(empty.code).toBe("invalid_suite")
    expect(empty.message).toBe("Suite name must not be empty")
    expect(empty.path).toBe("name")

    const control = await failure(Suite.make({ name: "a\u0000b", concurrency: 1, cases: [{ name: "a", input: 1 }] }))
    expect(control.message).toBe("Suite name must not contain the control character U+0000")
    expect(control.path).toBe("name")
  })

  it("rejects an empty, control-character, or duplicate case name", async () => {
    const blank = await failure(Suite.make({ name: "x", concurrency: 1, cases: [{ name: " ", input: 1 }] }))
    expect(blank.message).toBe("Suite case name must not be empty")
    expect(blank.path).toBe("cases[0].name")

    const control = await failure(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }, { name: "b\u007F", input: 1 }] })
    )
    expect(control.message).toBe("Suite case name must not contain the control character U+007F")
    expect(control.path).toBe("cases[1].name")

    const duplicate = await failure(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }, { name: "a", input: 2 }] })
    )
    expect(duplicate.message).toBe("Duplicate suite case: a")
    expect(duplicate.path).toBe("cases[1].name")
  })

  it("rejects a suite with no cases and one past the declared ceiling", async () => {
    const empty = await failure(Suite.make({ name: "x", concurrency: 1, cases: [] }))
    expect(empty.message).toBe("Suite must contain at least one case")
    expect(empty.path).toBe("cases")

    const tooMany = await failure(Suite.make({
      name: "x",
      concurrency: 1,
      cases: Array.from({ length: Suite.limits.cases + 1 }, (_, index) => ({ name: `case-${index}`, input: index }))
    }))
    expect(tooMany.message).toBe(
      `Suite must contain at most ${Suite.limits.cases} cases, got ${Suite.limits.cases + 1}`
    )
    expect(tooMany.path).toBe("cases")
  })

  it("rejects a concurrency that is not a safe integer inside the declared ceiling", async () => {
    const cases = [{ name: "a", input: 1 }]
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      const error = await failure(Suite.make({ name: "x", concurrency, cases }))
      expect(error.message).toBe(`Suite concurrency must be a positive safe integer, got ${String(concurrency)}`)
      expect(error.path).toBe("concurrency")
    }
    const tooWide = await failure(
      Suite.make({ name: "x", concurrency: Number.MAX_SAFE_INTEGER, cases })
    )
    expect(tooWide.message).toBe(
      `Suite concurrency must be at most ${Suite.limits.concurrency}, got ${Number.MAX_SAFE_INTEGER}`
    )
  })

  // The run that produced a committed baseline has to be reproducible from the
  // suite value that was validated, so a suite cannot share mutable state with
  // the caller that declared it.
  it("snapshots case data and freezes the arrays it returns", async () => {
    const input = { mutable: 1 }
    const expected = { mutable: 1 }
    const cases = [{ name: "a", input, expected }]
    const suite = await Effect.runPromise(Suite.make({ name: "x", concurrency: 1, cases }))

    input.mutable = 999
    expected.mutable = 999
    cases.push({ name: "b", input: { mutable: 2 }, expected: { mutable: 2 } })

    expect(suite.cases).toHaveLength(1)
    expect(suite.cases[0]?.input).toEqual({ mutable: 1 })
    expect(suite.cases[0]?.expected).toEqual({ mutable: 1 })
    expect(Object.isFrozen(suite.cases)).toBe(true)
    expect(Object.isFrozen(suite.bindings)).toBe(true)
  })

  it("snapshots binding data and keeps the scorer and target by reference", async () => {
    const groundTruth = { answer: 1 }
    const context = { rubric: "exact" }
    const binding = Binding.make({ scorer, appliesTo: target, groundTruth, context })
    const suite = await Effect.runPromise(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }], bindings: [binding] })
    )
    groundTruth.answer = 999
    context.rubric = "changed"

    expect(suite.bindings[0]?.groundTruth).toEqual({ answer: 1 })
    expect(suite.bindings[0]?.context).toEqual({ rubric: "exact" })
    expect(suite.bindings[0]?.scorer).toBe(scorer)
    expect(suite.bindings[0]?.appliesTo).toBe(target)
    expect(suite.bindings[0]?.sampling).toBe("all")
  })

  it("keeps a binding without ground truth or context bare", async () => {
    const suite = await Effect.runPromise(
      Suite.make({
        name: "x",
        concurrency: 1,
        cases: [{ name: "a", input: 1 }],
        bindings: [Binding.make({ scorer, appliesTo: target })]
      })
    )
    expect(Object.hasOwn(suite.bindings[0]!, "groundTruth")).toBe(false)
    expect(Object.hasOwn(suite.bindings[0]!, "context")).toBe(false)
    expect(Object.hasOwn(suite.cases[0]!, "expected")).toBe(false)
  })

  it("rejects case and binding data that cannot be snapshotted", async () => {
    const message = "Suite data must be structured-cloneable so the suite cannot change after it is validated"

    const badInput = await failure(Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: () => 1 }] }))
    expect(badInput.code).toBe("invalid_suite")
    expect(badInput.message).toBe(message)
    expect(badInput.path).toBe("cases[0].input")

    const badExpected = await failure(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1, expected: () => 1 }] })
    )
    expect(badExpected.path).toBe("cases[0].expected")

    const badGroundTruth = await failure(Suite.make({
      name: "x",
      concurrency: 1,
      cases: [{ name: "a", input: 1 }],
      bindings: [Binding.make({ scorer, appliesTo: target, groundTruth: () => 1 })]
    }))
    expect(badGroundTruth.path).toBe("bindings[0].groundTruth")

    const badContext = await failure(Suite.make({
      name: "x",
      concurrency: 1,
      cases: [{ name: "a", input: 1 }],
      bindings: [Binding.make({ scorer, appliesTo: target, context: () => 1 })]
    }))
    expect(badContext.path).toBe("bindings[0].context")
  })

  it("loads JSON Lines in declaration order, skipping blank lines", async () => {
    const suite = await Effect.runPromise(
      Suite.fromJsonLines("{\"name\":\"first\",\"input\":1}\n\n{\"name\":\"second\",\"input\":2}", {
        name: "fixture",
        concurrency: 2
      })
    )
    expect(suite.cases.map((suiteCase) => suiteCase.name)).toEqual(["first", "second"])
  })

  it("accepts a byte-order mark, CRLF endings, a trailing newline, and `expected`", async () => {
    const suite = await Effect.runPromise(
      Suite.fromJsonLines(
        "\uFEFF{\"name\":\"first\",\"input\":1,\"expected\":\"a\"}\r\n{\"name\":\"second\",\"input\":2}\r\n",
        { name: "fixture", concurrency: 1 }
      )
    )
    expect(suite.cases).toEqual([
      { name: "first", input: 1, expected: "a" },
      { name: "second", input: 2 }
    ])
  })

  it("names the 1-based line of a malformed or schema-invalid fixture line", async () => {
    const malformed = await failure(
      Suite.fromJsonLines("{\"name\":\"a\",\"input\":1}\n{not json}", { name: "f", concurrency: 1 })
    )
    expect(malformed.message).toBe("Invalid JSON on line 2")
    expect(malformed.path).toBe("line[2]")

    const invalid = await failure(
      Suite.fromJsonLines("{\"input\":1}", { name: "f", concurrency: 1 })
    )
    expect(invalid.message).toBe("Invalid suite case on line 1")
    expect(invalid.path).toBe("line[1]")
  })

  it("refuses a fixture larger than the declared ceiling before parsing any of it", async () => {
    const oversize = await failure(
      Suite.fromJsonLines("x".repeat(Suite.limits.fixtureLength + 1), { name: "f", concurrency: 1 })
    )
    expect(oversize.message).toBe(
      `JSON Lines fixture must be at most ${Suite.limits.fixtureLength} characters, got ${
        Suite.limits.fixtureLength + 1
      }`
    )
    expect(oversize.path).toBe("text")
  })

  it("loads the committed fixture beside these tests", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(new URL("./fixtures/suite.jsonl", import.meta.url), "utf8")
    const suite = await Effect.runPromise(Suite.fromJsonLines(text, { name: "fixture", concurrency: 1 }))
    expect(suite.cases.map((suiteCase) => suiteCase.name)).toEqual(["adds numbers", "multiplies numbers"])
  })
})
