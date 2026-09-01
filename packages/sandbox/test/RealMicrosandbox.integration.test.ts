import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Microsandbox from "microsandbox"
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

// The CLI and SDK ship through the same platform package. A machine without a
// runnable platform binary names the real test as a skip rather than
// pretending that a fake proved the microVM boundary.
//
// A runnable binary is not enough. A microVM needs hardware virtualization, and
// a hosted CI runner installs the CLI while providing none: the boot then dies
// with SIGABRT before the agent relay comes up, which reads as a product
// failure rather than as the missing capability it is. On Linux the capability
// is `/dev/kvm`, readable and writable by this process. Other platforms reach
// the hypervisor through a framework with no such device to probe, so the
// binary check stands there.
const installed = spawnSync("microsandbox", ["--version"], { stdio: "ignore" }).status === 0
const virtualized = process.platform !== "linux" || ((): boolean => {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
})()
const available = installed && virtualized
const session = `real-microsandbox-${process.pid}-${Date.now()}`
const budget = 900_000

// The skip has to be visible: a case that silently disappears is
// indistinguishable from one that never existed.
describe.skipIf(available)("MicrosandboxSandbox against a real microVM", () => {
  it("is skipped because this machine cannot boot a microVM", () => {
    expect(installed && virtualized).toBe(false)
  })
})

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
