/**
 * The refusal sentence `bin.ts` prints for a failure that has none of its own.
 *
 * `test/TwoProcessClaim.test.ts` proves the line reaches an operator's stderr
 * from a real process. These cases pin what that line says, against the real
 * `@smthrs/control` errors it is written for: the module is separate from
 * `bin.ts` precisely so it can be asked directly, since importing `bin.ts`
 * runs the command line.
 */
import { ControlError } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Failure from "../src/internal/Failure.ts"

describe("Failure.sentence", () => {
  it("keeps the failure's own sentence when it has one", () => {
    const stated = new ControlError.NoMatchingWait({ runId: "run-42", waitName: "go" })

    // `NoMatchingWait` overrides `message`, and an override always wins: the
    // fields would say less than the sentence its author wrote.
    expect(Failure.sentence(stated)).toBe(stated.message)
    expect(Failure.sentence(stated)).toContain("no wait point named")
  })

  it("states the contract code and the run for a failure with no sentence", () => {
    // The line `smthrs resume` prints when a live peer owns the run. Before
    // this, the whole line was `ClaimLost: `, which named neither.
    expect(Failure.sentence(new ControlError.ClaimLost({ runId: "run-42" })))
      .toBe("claim_lost runId=run-42")
  })

  it("names every scalar field, code first, in the order the error declares them", () => {
    expect(Failure.sentence(new ControlError.Unavailable({ feature: "watch", ticket: "S-12" })))
      .toBe("unavailable feature=watch ticket=S-12")
  })

  it("bounds one field so a large value cannot flood the terminal", () => {
    const issue = "x".repeat(Failure.fieldValueLimit * 3)

    const rendered = Failure.sentence(new ControlError.InvalidInput({ issue }))

    expect(rendered).toBe(`invalid_input issue=${"x".repeat(Failure.fieldValueLimit)}`)
    // Bounded by code points rather than by UTF-16 units, so the cut cannot
    // land inside a surrogate pair and produce a lone half.
    expect([...rendered].length).toBeLessThan(issue.length)
  })

  it("leaves structured fields out of the line", () => {
    // Every rc.0 control error declares scalar fields only, so the error that
    // makes this rule observable is built here. The rule is what keeps the
    // line a line: a failure that grows an envelope, a diff, or a list of
    // candidates must not turn one refusal into a page of output, and the
    // structure is in the run's journal either way.
    const structured = Object.assign(new Error(""), {
      code: "envelope_mismatch",
      planId: "plan-1",
      expected: { capabilities: [], flows: [], budget: {} },
      candidates: ["a", "b"]
    })

    expect(Failure.sentence(structured)).toBe("envelope_mismatch planId=plan-1")
  })

  it("answers the empty string for an error carrying neither a code nor a scalar field", () => {
    // The reporter then prints exactly what it printed before this existed:
    // the class name and a colon. Nothing was invented to fill the gap.
    expect(Failure.sentence(new Error(""))).toBe("")
  })
})
