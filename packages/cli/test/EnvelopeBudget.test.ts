/**
 * The spending ceiling a flow declares, from its frontmatter to the refusal.
 *
 * `layerExecutor` hands `Budget.layerFromEnvelope` to `AgentSession`, which
 * builds one budget per run out of the approved card's envelope. That made the
 * enforcement real everywhere except where it mattered: `durableFlow` filled
 * every discovered flow's envelope with a hardcoded `budget: {}`, so the layer
 * bound nothing on the shipped CLI however carefully a flow declared its
 * ceilings. The declaration had nowhere to live either, because
 * `Descriptor.FlowDescriptor` had no budget field at all.
 *
 * These cases walk the whole path with nothing stubbed: a real project
 * directory, the real registry scanning it, the real durable control runtime
 * planning against `.flows/control.db`, and the real budget the composition
 * builds from the envelope that plan carries. The refusal is checked on the
 * policy the envelope produced rather than on numbers this file states, which
 * is the half that was broken: a passing assertion here is a flow whose
 * declared ceiling reaches the seam that enforces it.
 *
 * The accumulator these cases use is the budget's out-of-run tally. Keying by
 * execution id, journal recovery, and the latch belong to the budget itself
 * and are covered in `packages/agent/test/Budget.test.ts`; what is untried here
 * is whether the policy it enforces carries the numbers the flow declared.
 */
import * as Budget from "@smthrs/agent/Budget"
import { Control as ControlService } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

/** One discovered markdown flow, with whatever budget the case declares. */
const skill = (declaration: ReadonlyArray<string>): string =>
  [
    "---",
    "description: Reviews a proposed change.",
    ...declaration,
    "---",
    "",
    "# Review",
    ""
  ].join("\n")

/**
 * Scans a project holding that one flow and plans it, returning the envelope
 * the control plane approved.
 *
 * Every layer is the production one: `layerRegistry` discovers under the
 * guarded platform, and `engineDurable` opens the real SQLite control database
 * and registers what the registry found.
 */
const plannedEnvelope = async (declaration: ReadonlyArray<string>) => {
  const project = await mkdtemp(join(tmpdir(), "flows-cli-budget-"))
  try {
    await mkdir(join(project, "flows", "review"), { recursive: true })
    await writeFile(join(project, "flows", "review", "SKILL.md"), skill(declaration))
    const registry = NodeControl.layerRegistry(project)
    const engine = NodeControl.engineDurable(project, registry)
    return await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        const card = yield* control.plan({ flowId: "review", input: {} })
        return card.envelope
      }).pipe(
        Effect.provide(Application.layer({}, registry, engine) as Layer.Layer<ControlService.Control>),
        Effect.scoped,
        Effect.orDie
      )
    )
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

/**
 * Spends one call of `tokens` under the budget the composition builds from an
 * envelope, then asks whether the next call may be made.
 *
 * The projection is the point: a budget refuses BEFORE a call, costing the
 * largest call the run has made, so one recorded call of 900 against a 1,000
 * token ceiling is already over.
 */
const verdictAfterSpending = (envelope: Parameters<typeof Budget.layerFromEnvelope>[0], tokens: number) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const budget = yield* Budget.current
      yield* budget.record("review/model-call-1", { totalTokens: tokens })
      return yield* budget.check
    }).pipe(
      Effect.provide(Budget.layerFromEnvelope(envelope)),
      Effect.scoped,
      Effect.orDie
    )
  )

describe("a declared flow budget", () => {
  it("reaches the approved envelope through the real CLI composition", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000", "  milliseconds: 60000"])

    // Before the descriptor carried a budget this read `{}` for every flow in
    // every project, which is what left `Budget.layerFromEnvelope` binding
    // nothing.
    expect(envelope.budget).toEqual({ tokens: 1000, milliseconds: 60000 })
  })

  it("refuses the call that would overspend it", async () => {
    const envelope = await plannedEnvelope(["budget:", "  tokens: 1000"])
    const verdict = await verdictAfterSpending(envelope, 900)

    expect(verdict._tag).toBe("refuse")
    if (verdict._tag !== "refuse") return
    // The ceiling the refusal names is the flow's own declaration, carried
    // whole: nothing in this file told the budget what 1,000 was.
    expect(verdict.exceeded.scope).toBe("tokens")
    expect(verdict.exceeded.max).toBe(1000)
    expect(verdict.exceeded.used).toBe(900)
    expect(verdict.exceeded.next).toBe(900)
    expect(verdict.failure).toBeInstanceOf(Budget.BudgetExceeded)
  })

  it("leaves a flow that declares none unbounded", async () => {
    const envelope = await plannedEnvelope([])

    // Absent stays absent rather than becoming a zero ceiling, so every flow
    // written before budgets existed runs exactly as it did.
    expect(envelope.budget).toEqual({})
    expect(await verdictAfterSpending(envelope, 10_000_000)).toEqual({ _tag: "proceed" })
  })

  it("ignores a malformed declaration instead of refusing every call", async () => {
    // A budget has no conservative reading: the conservative number is zero,
    // and a zero ceiling would report a typo as a spending decision. Discovery
    // warns and drops it, so the flow runs unbounded.
    const envelope = await plannedEnvelope(["budget:", "  tokens: soon"])

    expect(envelope.budget).toEqual({})
  })
})
