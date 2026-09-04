/**
 * Case 16 — five concurrent subscribers over one run's history stay inside the
 * committed memory budget.
 *
 * The number that matters is growth over this suite's own baseline, not an
 * absolute resident set: the fault tier shares one process, so an absolute
 * ceiling would measure the suite rather than the fan-out. The budget lives in
 * `test/faults/budgets/memory.json` and is read, never restated here, so
 * widening it is a reviewed diff.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadBudget, type MemoryBudget } from "./budgets/loadBudget.ts"
import { emitSignals, launchRun } from "./harness/servedRun.ts"
import { servedSuite } from "./harness/servedSuite.ts"

const suite = servedSuite("case16")
const budget = loadBudget<MemoryBudget>("memory")
const subscribers = 5
const events = 500

beforeAll(() => suite.start(), 180_000)
afterAll(() => suite.stop())

const settle = async (): Promise<number> => {
  globalThis.gc?.()
  await new Promise((resolve) => setTimeout(resolve, 250))
  return process.memoryUsage().rss
}

describe("case16 five subscribers, bounded memory", () => {
  it("fans one run's journal out to five readers inside the RSS budget", async () => {
    const runId = await suite.remote(
      Effect.gen(function*() {
        const run = yield* launchRun("case16")
        yield* emitSignals(run.runId, events)
        return run.runId
      })
    )

    const baseline = await settle()

    const counts = await suite.remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const read = control.watch({ runId, follow: false }).pipe(
          Stream.runFold(() => 0, (total: number) => total + 1)
        )
        return yield* Effect.all(Array.from({ length: subscribers }, () => read), {
          concurrency: subscribers
        })
      })
    )

    const growth = (await settle()) - baseline

    // Every subscriber genuinely read the whole run, so the measurement is of
    // work that happened.
    expect(counts).toHaveLength(subscribers)
    for (const count of counts) expect(count).toBeGreaterThanOrEqual(events)
    expect(growth).toBeLessThan(budget.subscriberFanoutN5.rssGrowthBytesMax)
  })
})
