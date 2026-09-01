import { expect, it } from "@effect/vitest"
import * as C from "../src/Capability.ts"
import * as P from "../src/Permission.ts"

it("PROBE A: over-budget deny rule is skipped while a short allow still matches", () => {
  const resource = "x".repeat(100_000)
  const allow = new P.Rule({
    effect: "allow",
    pattern: new C.CapabilityPattern({ action: "proc:spawn", resource: "*" })
  })
  const deny = new P.Rule({
    effect: "deny",
    pattern: new C.CapabilityPattern({ action: "proc:spawn", resource: "x".repeat(170) + "*" })
  })
  // the deny pattern genuinely matches the resource when evaluated on its own
  expect(C.matches(deny.pattern, C.make("proc:spawn", "x".repeat(200)))).toBe(true)
  console.log("PROBE A result:", P.evaluate([[allow, deny]], C.make("proc:spawn", resource)))
})

it("PROBE B: patternFromCapability on an over-long exact resource", () => {
  try {
    const r = C.patternFromCapability(C.make("proc:spawn", "x".repeat(C.maxResourceLength + 1)))
    console.log("PROBE B result:", r)
  } catch (e) {
    console.log("PROBE B THREW:", (e as Error).constructor.name, String((e as Error).message).slice(0, 120))
  }
})
