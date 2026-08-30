/**
 * `pause` is gone from the control plane, and this is the gate that keeps it
 * gone.
 *
 * rc-contract §5.2 removes attributed pause from `1.0.0-rc.0` rather than
 * shipping it half-working: `SqlControlRuntime.pause` flipped the control row
 * to `parked` and released ownership, but it interrupted no fiber and parked no
 * engine run, so the body kept executing until its next fenced write failed.
 * PLAN.md Phase 5 forbids exactly that appearance, and the ruling was removal
 * rather than an `Unavailable` stub because the consumer inventory found no
 * caller.
 *
 * A removal is only real while nothing puts it back, so the assertions here are
 * negative on purpose: the verb is absent from the RPC group, from the `Control`
 * vtable every transport projects, from both `ControlRuntime` implementations,
 * and from the package's own source. The source scan is the one that catches a
 * re-introduction through a new file, which a type check would happily accept.
 */
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Control, layerNoop } from "../src/Control.ts"
import { ControlRpcs } from "../src/ControlRpcs.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { memoryRuntime } from "./TestStack.ts"

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url))

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith(".ts")
      ? [join(directory, entry.name)]
      : []
  )

describe("attributed pause is not part of 1.0.0-rc.0", () => {
  it("serves no Pause procedure", () => {
    expect([...ControlRpcs.requests.keys()]).toEqual([
      "Plan",
      "Run",
      "Approve",
      "Deny",
      "Steer",
      "Signal",
      "Cancel",
      "Resume",
      "List",
      "Watch"
    ])
  })

  it("exposes no pause member on the Control vtable", async () => {
    const members = await Effect.runPromise(
      Effect.map(Effect.service(Control), Object.keys).pipe(Effect.provide(layerNoop))
    )
    expect(members).toEqual([
      "plan",
      "run",
      "approve",
      "deny",
      "steer",
      "signal",
      "cancel",
      "resume",
      "list",
      "watch"
    ])
  })

  it("exposes no pause member on the in-memory control runtime", async () => {
    const members = await Effect.runPromise(
      Effect.map(Effect.service(ControlRuntime), Object.keys).pipe(
        Effect.provide(memoryRuntime()),
        Effect.scoped
      )
    )
    expect(members).not.toContain("pause")
  })

  it("mentions pause nowhere in the published source", () => {
    const offenders = sourceFiles(sourceRoot).filter((file) => /\bpause/i.test(readFileSync(file, "utf8")))
    expect(offenders.map((file) => file.slice(sourceRoot.length + 1))).toEqual([])
  })
})
