import * as EffectCron from "effect/Cron"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as Cron from "../src/Cron.ts"

// A cron the field parser accepts and the calendar never reaches. Building it
// by hand is the only way to reach the search paths, because `parse` now
// refuses the expression.
const unsatisfiable = (): Cron.Cron => {
  const parsed = EffectCron.parse("0 0 30 2 *")
  if (Result.isFailure(parsed)) throw new Error("February 30 must parse as fields")
  return { expression: "0 0 30 2 *", value: parsed.success }
}

describe("Cron", () => {
  it("uses Effect cron timezone scheduling", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 9 * * *", "America/New_York"))
    const occurrence = await Effect.runPromise(Cron.next(cron, new Date("2026-01-01T13:00:00.000Z")))
    expect(occurrence.toISOString()).toBe("2026-01-01T14:00:00.000Z")
  })

  it("reports invalid expressions as typed errors", async () => {
    const exit = await Effect.runPromiseExit(Cron.parse("not cron"))
    expect(exit._tag).toBe("Failure")
  })

  it("selects only occurrences within the requested interval", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(
      await Effect.runPromise(
        Cron.occurrencesBetween(cron, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T02:00:00.000Z"))
      )
    ).toEqual([
      new Date("2026-01-01T01:00:00.000Z"),
      new Date("2026-01-01T02:00:00.000Z")
    ])
  })

  it("refuses a parseable expression the calendar never satisfies", async () => {
    const error = await Effect.runPromise(Effect.flip(Cron.parse("0 0 30 2 *")))
    expect(error.code).toBe("unsatisfiable_cron")
    expect(await Effect.runPromise(Effect.flip(Cron.parse("0 0 31 4 *")))).toMatchObject({
      code: "unsatisfiable_cron"
    })
  })

  it("reports an exhausted occurrence search as a typed failure, never a defect", async () => {
    const cron = unsatisfiable()
    const at = new Date("2026-01-01T00:00:00.000Z")
    expect(await Effect.runPromise(Effect.flip(Cron.next(cron, at)))).toMatchObject({
      code: "unsatisfiable_cron"
    })
    expect(await Effect.runPromise(Effect.flip(Cron.previousAtOrBefore(cron, at)))).toMatchObject({
      code: "unsatisfiable_cron"
    })
    expect(await Effect.runPromise(Effect.flip(Cron.occurrencesBetween(cron, at, at)))).toMatchObject({
      code: "unsatisfiable_cron"
    })
  })
})
