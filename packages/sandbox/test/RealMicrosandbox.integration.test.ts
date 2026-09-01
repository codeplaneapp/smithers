import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Microsandbox from "microsandbox"
import { spawnSync } from "node:child_process"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

// The CLI and SDK ship through the same platform package. A machine without a
// runnable platform binary names the real test as a skip rather than
// pretending that a fake proved the microVM boundary.
const available = spawnSync("microsandbox", ["--version"], { stdio: "ignore" }).status === 0
const session = `real-microsandbox-${process.pid}-${Date.now()}`
const budget = 900_000

describe.skipIf(!available)("MicrosandboxSandbox against a real microVM", () => {
  it.effect(
    "passes the sandbox conformance suite",
    () =>
      Effect.gen(function*() {
        const provider = MicrosandboxSandbox.make({
          sdk: Microsandbox,
          image: "oven/bun:1",
          pullPolicy: "if-missing",
          maxDurationSecs: 900,
          idleTimeoutSecs: 120
        })
        const violations = yield* SandboxConformance.check(provider, {
          session,
          provides: { ping: true }
        })
        expect(violations).toEqual([])
      }),
    budget
  )
})
