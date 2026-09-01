/**
 * `SandboxedFlow` against real machines: a Docker container and a Microsandbox
 * microVM. The same child flow the unit suite runs in a scratch directory runs
 * here inside a guest whose `/etc/os-release` is the image's, and it writes a
 * file the host can only read back through the session.
 *
 * Both suites skip, visibly, where the backend is absent: a machine without a
 * container engine, or one that cannot boot a microVM, names the skip rather
 * than letting a fake stand in for the boundary.
 */
import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ContainerSandbox, MicrosandboxSandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Microsandbox from "microsandbox"
import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { afterAll } from "vitest"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import { Inspector, Sum } from "./fixtures/sandboxed-child.ts"

const entry = new URL("./fixtures/sandboxed-child.ts", import.meta.url)

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const spawner = Effect.gen(function*() {
  return yield* ChildProcessSpawner
}).pipe(Effect.provide(platform))

// Session keys are suite-unique so a concurrently running vitest worker
// cannot collide on container names. A normal completion removes the
// container; the force-removal below covers a run that died mid-acquire.
const engineAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
const containerKeys = {
  node: `flows-sandboxed-it-${process.pid}-node`,
  bare: `flows-sandboxed-it-${process.pid}-bare`
}
afterAll(() => {
  if (!engineAvailable) return
  const names = spawnSync("docker", ["ps", "--all", "--format", "{{.Names}}"]).stdout?.toString() ?? ""
  for (const name of names.split("\n")) {
    if (name.includes(`flows-sandboxed-it-${process.pid}-`)) {
      spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" })
    }
  }
})

// `docker start` is the one variable step: about a second on an idle engine
// and thirty seconds with many containers resident on the development
// machine, while every other engine call stays near 50ms. The budget is sized
// for the loaded engine, and it also covers carrying a megabyte-scale bundle
// through the exec transport.
const containerBudget = 240_000

describe.skipIf(!engineAvailable)("SandboxedFlow inside a real container", () => {
  it.live(
    "runs the child flow's code in the guest image and reads back what only the guest wrote",
    () =>
      Effect.gen(function*() {
        const provider = ContainerSandbox.make({ spawner: yield* spawner, image: "node:22-alpine" })
        const started = Date.now()
        const result = yield* SandboxedFlow.execute(Inspector, { marker: "written in the container" }, {
          provider,
          session: containerKeys.node,
          entry,
          collectDiff: true,
          timeout: containerBudget
        })
        // Whatever this host runs, the guest's os-release is Alpine's and its
        // node is the image's 22.
        expect(result.output.osRelease).toContain("Alpine Linux")
        expect(result.output.runtime).toMatch(/^node v22\./)
        expect(result.output.cwd).toBe("/workspace")
        expect(result.output.seed).toBe("(absent)")
        expect(result.diff).toEqual([
          { path: "marker.txt", bytes: new TextEncoder().encode("written in the container") }
        ])
        expect(Date.now() - started).toBeLessThan(containerBudget)
      }),
    containerBudget
  )

  it.live(
    "names the runtime an image without one cannot start",
    () =>
      Effect.gen(function*() {
        const provider = ContainerSandbox.make({ spawner: yield* spawner, image: "alpine:3.20" })
        const failure = yield* Effect.flip(
          SandboxedFlow.execute(Sum, { n: 1 }, {
            provider,
            session: containerKeys.bare,
            entry,
            timeout: containerBudget
          })
        )
        expect(failure.code).toBe("guest_failed")
        expect(failure.message).toContain("no runnable `node`")
      }),
    containerBudget
  )
})

// The microVM gate is the one `RealMicrosandbox.integration.test.ts` states:
// a runnable platform binary, and on Linux a readable and writable `/dev/kvm`,
// because a hosted runner installs the CLI while providing no virtualization.
const installed = spawnSync("microsandbox", ["--version"], { stdio: "ignore" }).status === 0
const virtualized = process.platform !== "linux" || ((): boolean => {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
})()
const microvmAvailable = installed && virtualized
const microvmSession = `flows-sandboxed-microvm-${process.pid}-${Date.now()}`
const microvmBudget = 900_000

describe.skipIf(microvmAvailable)("SandboxedFlow inside a real microVM", () => {
  it("is skipped because this machine cannot boot a microVM", () => {
    expect(installed && virtualized).toBe(false)
  })
})

describe.skipIf(!microvmAvailable)("SandboxedFlow inside a real microVM", () => {
  it.live(
    "runs the child flow's code under bun in the guest and reads back what only the guest wrote",
    () =>
      Effect.gen(function*() {
        const provider = MicrosandboxSandbox.make({
          sdk: Microsandbox,
          image: "oven/bun:1",
          pullPolicy: "if-missing",
          maxDurationSecs: 900,
          idleTimeoutSecs: 120
        })
        const result = yield* SandboxedFlow.execute(Inspector, { marker: "written in the microVM" }, {
          provider,
          session: microvmSession,
          entry,
          runtime: "bun",
          collectDiff: true,
          timeout: microvmBudget
        })
        expect(result.output.runtime).toBe("bun")
        expect(result.output.osRelease).toContain("ID=")
        expect(result.output.seed).toBe("(absent)")
        expect(result.diff).toEqual([
          { path: "marker.txt", bytes: new TextEncoder().encode("written in the microVM") }
        ])
      }),
    microvmBudget
  )
})
