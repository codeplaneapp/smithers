import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { declaredCalls, main } from "../src/30-failure-control.ts"

it("declares the deploy's compensations in reverse order", () => {
  expect(declaredCalls).toEqual([
    "reserve",
    "upload",
    "activate",
    "roll-back",
    "delete",
    "release"
  ])
})

it.effect("bounds checks, isolates a flake, escalates once, and unwinds the deploy", () =>
  Effect.gen(function*() {
    const summary = yield* main()

    expect(summary.checks).toEqual({ lint: "lint-clean", types: "types-clean", audit: "audit-clean" })
    expect(summary.quarantined).toEqual(["flake"])
    expect(summary.fixedAt).toBe(1)
    expect(summary.deploy).toEqual(["reserve", "upload", "activate", "delete", "release"])
    expect(summary.outcome).toBe("compensated")
    expect(summary.lockHeld).toBe(false)
  }))
