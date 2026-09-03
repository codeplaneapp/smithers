import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import * as Microsandbox from "microsandbox"
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

const session = `real-microsandbox-${process.pid}-${Date.now()}`
const budget = 900_000

/**
 * Why this host cannot boot a microVM, or `undefined` when it can.
 *
 * The CLI and SDK ship through the same platform package, so a machine without
 * a runnable platform binary names the real test as a skip rather than
 * pretending that a fake proved the microVM boundary.
 *
 * A runnable binary is not the capability. A microVM needs a hypervisor, and a
 * hosted runner installs the CLI while providing none; the boot then dies
 * inside libkrun and reads as a product failure rather than as the missing
 * capability it is. So the gate asks the host for the hypervisor itself. On
 * Linux that is `/dev/kvm`, readable and writable by this process. On macOS it
 * is Hypervisor.framework, which advertises itself through `kern.hv_support`,
 * and `kern.hv_vmm_present` says whether this machine is itself a guest —
 * GitHub's Apple-silicon runners are, and Apple's Virtualization Framework
 * gives its guests no nested virtualization. Microsandbox reaches no hypervisor
 * on any other platform.
 *
 * Every one of those answers is an advertisement rather than a boot, so a host
 * that passes them all boots one microVM through the provider under test.
 * `hv_vm_create` can still be refused, and libkrun reports that refusal as
 * `VmSetup(VmCreate)`; that exact refusal names the missing capability and
 * skips. Every other failure, and a probe that outlasts its budget, leave the
 * suite to run and report what it finds: a skip is only ever a positive reading
 * of a capability this host does not have.
 */
const probeBudget = 300_000

const unbootable = async (): Promise<string | undefined> => {
  if (spawnSync("microsandbox", ["--version"], { stdio: "ignore" }).status !== 0) {
    return "the microsandbox platform binary does not run here"
  }
  if (process.platform === "linux") {
    try {
      accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    } catch {
      return "this Linux host exposes no /dev/kvm this process may read and write"
    }
  } else if (process.platform === "darwin") {
    const sysctl = (name: string): string | undefined => {
      const read = spawnSync("sysctl", ["-n", name], { encoding: "utf8" })
      return read.status === 0 ? read.stdout.trim() : undefined
    }
    if (sysctl("kern.hv_support") !== "1") {
      return "this macOS host reports no Hypervisor.framework support (kern.hv_support)"
    }
    if (sysctl("kern.hv_vmm_present") === "1") {
      return "this macOS host is itself a guest (kern.hv_vmm_present), and Apple's Virtualization Framework"
        + " gives its guests no nested virtualization"
    }
  } else {
    return `microsandbox reaches no hypervisor on ${process.platform}`
  }
  const refusal = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        MicrosandboxSandbox.make({
          sdk: Microsandbox,
          image: "oven/bun:1",
          pullPolicy: "if-missing",
          maxDurationSecs: 120,
          idleTimeoutSecs: 60
        }).acquire(`${session}-probe`),
        () => Effect.void
      )
    ).pipe(
      Effect.timeoutOption(probeBudget),
      Effect.as(undefined),
      Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause)))
    )
  )
  return refusal !== undefined && refusal.includes("VmSetup(VmCreate)")
    ? "this host's hypervisor refused to create a VM (VmSetup(VmCreate)): it provides no nested virtualization"
    : undefined
}

const missing = await unbootable()
const available = missing === undefined

// The skip has to be visible, and it has to name what is missing: a case that
// silently disappears is indistinguishable from one that never existed, and one
// that disappears without a reason is indistinguishable from a suite quietly
// switched off.
describe.skipIf(available)("MicrosandboxSandbox against a real microVM", () => {
  it(`is skipped because ${missing ?? "this machine can boot a microVM"}`, () => {
    expect(missing).toEqual(expect.any(String))
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
