import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Schedule from "../src/Schedule.ts"
import * as Trigger from "../src/Trigger.ts"

describe("Trigger", () => {
  it("decodes policy defaults", () => {
    const trigger = Schema.decodeUnknownSync(Trigger.Trigger)({
      id: "nightly",
      flowId: "flow",
      input: { ok: true },
      cron: "0 0 * * *",
      maxCatchUp: 2,
      enabled: true
    })
    expect(trigger.overlap).toBe("skip")
    expect(trigger.catchUp).toBe("none")
  })

  it("shares policy defaults with standalone schedules", () => {
    const schedule = Schema.decodeUnknownSync(Schedule.Schedule)({
      cron: "0 0 * * *",
      maxCatchUp: 2
    })
    expect(schedule).toMatchObject({ overlap: "skip", catchUp: "none" })
  })

  it("maps public decode failures to stable trigger errors", async () => {
    const schedule = await Effect.runPromise(Effect.flip(Schedule.make({ cron: "", maxCatchUp: -1 })))
    const trigger = await Effect.runPromise(Effect.flip(Trigger.make({})))
    expect(schedule.code).toBe("invalid_schedule")
    expect(trigger.code).toBe("invalid_trigger")
  })
})
