/**
 * The diagnosis fold and its rendering.
 *
 * These are the questions the old `whatHappened` route answered out of the
 * engine database, asked of the events instead: what happened, why it stopped,
 * and what the run actually did while it ran.
 */
import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"

let sequence = 0

const event = (
  kind: string,
  payload: unknown,
  occurredAt = 0
): ControlSchema.ControlEvent => ({
  sequence: (sequence += 1),
  kind,
  runId: "run-1",
  occurredAt,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

describe("Diagnosis.digest", () => {
  it("reports nothing at all from no events", () => {
    expect(Diagnosis.digest([])).toMatchObject({
      status: undefined,
      cause: undefined,
      seat: undefined,
      turns: 0,
      calls: 0,
      refusals: [],
      startedAt: undefined,
      endedAt: undefined
    })
  })

  it("counts turns, calls, edits, refusals, and tokens", () => {
    const digest = Diagnosis.digest([
      event("control.agent.turn-opened", { seat: "opus", at: 100 }),
      event("control.agent.turn-opened", {}),
      event("control.agent.cell-call-started", { flowName: "write" }),
      event("control.agent.cell-call-started", { flowName: "read" }),
      event("control.agent.cell-call-started", {}),
      event("control.agent.cell-call-settled", { flowName: "write", outcome: "success" }),
      event("control.agent.cell-call-settled", { outcome: "failure", message: "denied\nsecond line" }),
      event("control.agent.cell-call-settled", { outcome: "failure" }),
      event("control.agent.cell-call-settled", { flowName: "read", outcome: "success" }),
      event("control.agent.cell-call-settled", { outcome: "success" }),
      event("control.agent.model-settled", { usage: { inputTokens: 10, outputTokens: 5 } }),
      event("control.agent.model-settled", { usage: {} }),
      event("control.agent.model-settled", {}),
      event("control.agent.resolved", { text: "shipped" }),
      event("control.run.completed", {}, 900)
    ])

    expect(digest).toMatchObject({
      status: "completed",
      seat: "opus",
      turns: 2,
      calls: 3,
      callsFailed: 2,
      editsAttempted: 1,
      editsSucceeded: 1,
      inputTokens: 10,
      outputTokens: 5,
      finalOutput: "shipped"
    })
    // Refusal messages aggregate by first line, most frequent first.
    expect(digest.refusals).toEqual([
      { message: "denied", count: 1 },
      { message: "unknown refusal", count: 1 }
    ])
    // The payload's own stamp wins over journal admission time.
    expect(digest.startedAt).toBe(0)
    expect(digest.endedAt).toBe(900)
  })

  it("keeps a failure's recorded cause and a park's question", () => {
    const digest = Diagnosis.digest([
      event("control.approval.requested", { question: "Ship it?" }),
      event("control.run.failed", { cause: "the model refused" })
    ])
    expect(digest).toMatchObject({ status: "failed", cause: "the model refused", parkedQuestion: "Ship it?" })
  })

  it("tolerates a payload that is not a record", () => {
    const digest = Diagnosis.digest([
      event("control.agent.turn-opened", "not a record"),
      event("control.agent.turn-opened", ["also", "not"]),
      event("control.run.failed", null)
    ])
    expect(digest).toMatchObject({ turns: 2, seat: undefined, status: "failed", cause: undefined })
  })

  it("ignores an event kind outside the vocabulary", () => {
    expect(Diagnosis.digest([event("something.else", {})])).toMatchObject({ status: undefined, turns: 0 })
  })
})

describe("Diagnosis.verdict", () => {
  const facts = (overrides: Partial<Diagnosis.Digest>): Diagnosis.Digest => ({
    ...Diagnosis.digest([]),
    ...overrides
  })

  it("names the unlaunched run", () => {
    expect(Diagnosis.verdict(facts({}))).toBe("unlaunched")
  })

  it("leads a failure with its cause and says so when there is none", () => {
    expect(Diagnosis.verdict(facts({ status: "failed", cause: "boom\nrest" }))).toBe("failed — boom")
    expect(Diagnosis.verdict(facts({ status: "failed" }))).toBe("failed — no cause recorded in the journal")
  })

  it("leads a park with the question it is asking", () => {
    expect(Diagnosis.verdict(facts({ status: "waiting-approval", parkedQuestion: "Ship?" }))).toBe(
      "waiting-approval — asks: Ship?"
    )
    expect(Diagnosis.verdict(facts({ status: "waiting-approval" }))).toBe(
      "waiting-approval — a permission gate is pending"
    )
  })

  it("surfaces the run that worked and never edited", () => {
    expect(Diagnosis.verdict(facts({ status: "completed", calls: 4, editsAttempted: 0 }))).toBe(
      "completed — but 0 of 4 calls attempted an edit; the run only read"
    )
  })

  it("leads a completion with its output, and falls back to the status", () => {
    expect(
      Diagnosis.verdict(facts({ status: "completed", calls: 1, editsAttempted: 1, finalOutput: "done\nmore" }))
    ).toBe("completed — done")
    expect(Diagnosis.verdict(facts({ status: "completed", calls: 1, editsAttempted: 1, finalOutput: "" }))).toBe(
      "completed"
    )
    expect(Diagnosis.verdict(facts({ status: "running" }))).toBe("running")
  })
})

describe("Diagnosis.duration", () => {
  const facts = (startedAt?: number, endedAt?: number): Diagnosis.Digest => ({
    ...Diagnosis.digest([]),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt })
  })

  it("reports nothing measurable as zero", () => {
    expect(Diagnosis.duration(facts())).toBe("0s")
    expect(Diagnosis.duration(facts(1))).toBe("0s")
  })

  it("reports seconds under a minute and minutes above it", () => {
    expect(Diagnosis.duration(facts(0, 42_000))).toBe("42s")
    expect(Diagnosis.duration(facts(0, 125_000))).toBe("2m 05s")
    // A clock that ran backwards is reported as zero, never as a negative.
    expect(Diagnosis.duration(facts(10_000, 0))).toBe("0s")
  })
})

describe("Diagnosis.clip", () => {
  it("leaves short text alone and marks a cut", () => {
    expect(Diagnosis.clip("short", 10)).toBe("short")
    expect(Diagnosis.clip("abcdefghij", 5)).toBe("abcd…")
  })
})

describe("Diagnosis.render", () => {
  it("renders the whole card when every fact is present", () => {
    const card = Diagnosis.render(
      { runId: "run-1", flowId: "deploy" },
      Diagnosis.digest([
        event("control.agent.turn-opened", { seat: "opus", at: 0 }),
        event("control.agent.cell-call-started", { flowName: "write" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "one" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "two" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "three" }),
        event("control.agent.cell-call-settled", { outcome: "failure", message: "four" }),
        event("control.agent.resolved", { text: "shipped" }),
        event("control.run.failed", { cause: "boom", at: 1_000 })
      ])
    )
    expect(card).toContain("Verdict   failed — boom")
    expect(card).toContain("Run       run-1 · deploy · opus · 1s")
    expect(card).toContain("Activity  1 turns")
    expect(card).toContain("Tokens    0 in / 0 out")
    expect(card).toContain("Cause     boom")
    expect(card).toContain("Output    shipped")
    // Only the three loudest refusals are shown; the rest are noise on a card.
    expect(card.split("\n").filter((line) => line.includes("1×"))).toHaveLength(3)
  })

  it("omits the facts a run does not have", () => {
    const card = Diagnosis.render({ runId: "run-1" }, Diagnosis.digest([]))
    expect(card).toContain("Run       run-1 · 0s")
    expect(card).not.toContain("Cause")
    expect(card).not.toContain("Output")
    expect(card).not.toContain("Refusals")
  })

  it("omits an empty final output", () => {
    const card = Diagnosis.render({ runId: "run-1" }, Diagnosis.digest([event("control.agent.resolved", { text: "" })]))
    expect(card).not.toContain("Output")
  })
})
