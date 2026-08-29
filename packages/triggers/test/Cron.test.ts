import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Cron from "../src/Cron.ts"

describe("Cron", () => {
  it("uses Effect cron timezone scheduling", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 9 * * *", "America/New_York"))
    expect(Cron.next(cron, new Date("2026-01-01T13:00:00.000Z")).toISOString()).toBe("2026-01-01T14:00:00.000Z")
  })

  it("reports invalid expressions as typed errors", async () => {
    const exit = await Effect.runPromiseExit(Cron.parse("not cron"))
    expect(exit._tag).toBe("Failure")
  })

  it("selects only occurrences within the requested interval", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(Cron.occurrencesBetween(cron, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T02:00:00.000Z")))
      .toEqual([
        new Date("2026-01-01T01:00:00.000Z"),
        new Date("2026-01-01T02:00:00.000Z")
      ])
  })
})
