import { describe, expect, it } from "vitest"
import * as Overlap from "../src/Overlap.ts"

describe("Overlap", () => {
  it("decides every policy without a clock", () => {
    expect(Overlap.decide("skip", { running: false, due: 1 })).toBe("fire")
    expect(Overlap.decide("skip", { running: true, due: 1 })).toBe("skip")
    expect(Overlap.decide("buffer-one", { running: true, due: 1 })).toBe("buffer")
    expect(Overlap.decide("supersede", { running: true, due: 1 })).toBe("supersede")
  })

  it("coalesces buffered occurrences to the latest timestamp", () => {
    expect(Overlap.pendingAfter({ running: true, pending: 20, due: 10 })).toBe(20)
    expect(Overlap.pendingAfter({ running: true, pending: 20, due: 30 })).toBe(30)
  })

  it("buffers the due occurrence when nothing is pending yet", () => {
    expect(Overlap.pendingAfter({ running: true, due: 10 })).toBe(10)
    expect(Overlap.pendingAfter({ running: true, pending: undefined, due: 10 })).toBe(10)
  })

  it("fires regardless of policy when no run is in flight", () => {
    for (const policy of ["skip", "buffer-one", "supersede"] as const) {
      expect(Overlap.decide(policy, { running: false, pending: 5, due: 10 })).toBe("fire")
    }
  })
})
