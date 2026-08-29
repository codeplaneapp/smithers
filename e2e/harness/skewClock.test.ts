import { afterEach, describe, expect, it } from "vitest"
import { skewClock, type SkewedClock } from "./skewClock.ts"

let live: SkewedClock | undefined
afterEach(() => {
  live?.restore()
  live = undefined
})

describe("skewClock", () => {
  it("moves Date.now and a bare new Date forward together", () => {
    const before = Date.now()
    live = skewClock(60_000)
    const after = Date.now()
    expect(after - before).toBeGreaterThanOrEqual(59_000)
    expect(new Date().getTime() - before).toBeGreaterThanOrEqual(59_000)
  })

  it("leaves an explicit Date argument alone", () => {
    live = skewClock(60_000)
    expect(new Date(0).getTime()).toBe(0)
    expect(new Date("2020-01-01T00:00:00.000Z").getTime()).toBe(1577836800000)
  })

  it("advances further without re-patching", () => {
    live = skewClock(1_000)
    const first = Date.now()
    live.advance(5_000)
    expect(Date.now() - first).toBeGreaterThanOrEqual(4_900)
  })

  it("restores the real clock, and restoring twice is a no-op", () => {
    const real = Date.now()
    const clock = skewClock(3_600_000)
    clock.restore()
    clock.restore()
    expect(Math.abs(Date.now() - real)).toBeLessThan(5_000)
    expect(Date.now).toBe(Date.now)
  })
})
