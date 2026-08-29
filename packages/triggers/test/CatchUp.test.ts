import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as CatchUp from "../src/CatchUp.ts"
import * as Cron from "../src/Cron.ts"

describe("CatchUp", () => {
  const from = new Date("2026-01-01T00:00:00.000Z")
  const now = new Date("2026-01-01T03:00:00.000Z")

  it("implements none, one, and all chronologically", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    expect(await Effect.runPromise(CatchUp.occurrences("none", 3, from, now, cron))).toEqual([])
    expect(await Effect.runPromise(CatchUp.occurrences("one", 3, from, now, cron))).toEqual([
      new Date("2026-01-01T03:00:00.000Z")
    ])
    expect(await Effect.runPromise(CatchUp.occurrences("all", 3, from, now, cron))).toEqual([
      new Date("2026-01-01T01:00:00.000Z"),
      new Date("2026-01-01T02:00:00.000Z"),
      new Date("2026-01-01T03:00:00.000Z")
    ])
  })

  it("bounds all catch-up work", async () => {
    const cron = await Effect.runPromise(Cron.parse("0 * * * *", "UTC"))
    const exit = await Effect.runPromiseExit(CatchUp.occurrences("all", 2, from, now, cron))
    expect(exit._tag).toBe("Failure")
  })
})
