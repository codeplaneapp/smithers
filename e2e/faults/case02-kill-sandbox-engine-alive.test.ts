/**
 * Case 2 — the sandbox dies and the engine does not.
 *
 * A sandbox is a separate process, so its failure has to reach the engine as a
 * value rather than as a crash. The engine host here is real and stays up for
 * the whole case; what changes underneath it is a real child process that is
 * first healthy, then `SIGSTOP`ped, then killed. Each state is read through
 * `SandboxHealth` from inside a running flow, so the reason the engine sees is
 * the reason the operating system produced.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { SandboxHealth } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { isAlive } from "../harness/killProcess.ts"
import { startStallableSandbox, type StallableSandbox } from "../harness/stallSandbox.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case02-"))
let sandbox: StallableSandbox

beforeAll(async () => {
  sandbox = await startStallableSandbox()
})

afterAll(() => {
  sandbox?.dispose()
  rmSync(directory, { recursive: true, force: true })
})

/** What the flow reports back: the health state, flattened for a schema. */
const Report = Schema.Struct({ tag: Schema.String, reason: Schema.String })

const Probe = Action.make("e2e/case02/Probe", { payload: {}, success: Report })

const CheckSandbox = Flow.make("e2e/case02/check", {
  payload: {},
  success: Report,
  body: (payload) => Probe.call(payload)
})

const registration = Interpreter.layer(CheckSandbox).pipe(
  Layer.provideMerge(
    Probe.toLayer(() =>
      Effect.gen(function*() {
        const health = yield* SandboxHealth.SandboxHealth
        const state = yield* health.check
        return { tag: state._tag, reason: state._tag === "Healthy" ? "healthy" : state.reason }
      })
    )
  ),
  Layer.provideMerge(Action.layerImplementations)
)

const probe = (executionId: string): Promise<typeof Report.Type> =>
  Effect.runPromise(
    CheckSandbox.execute({}, { executionId }).pipe(
      Effect.provide(
        NodeRuntime.layerHost(
          { filename: join(directory, "case02.sqlite"), workspaceRoot: directory, owner: { hostId: "case02-host" }, signals: [] },
          registration
        ).pipe(
          Layer.provideMerge(SandboxHealth.layer(sandbox.provider, { deadline: "500 millis" }))
        )
      ),
      Effect.scoped,
      Effect.orDie
    ) as Effect.Effect<typeof Report.Type>
  )

describe("case02 the sandbox dies, the engine stays up", () => {
  it("surfaces each sandbox state as a typed reason without taking the engine down", async () => {
    expect(await probe("case02-healthy")).toEqual({ tag: "Healthy", reason: "healthy" })

    // Stopped, not killed: the connection is accepted and the answer never
    // comes, which is what `unresponsive` means.
    sandbox.stall()
    expect(await probe("case02-stalled")).toEqual({ tag: "Unhealthy", reason: "unresponsive" })
    sandbox.resume()
    expect(await probe("case02-recovered")).toEqual({ tag: "Healthy", reason: "healthy" })

    // Gone: the ping itself fails.
    await sandbox.kill()
    expect(isAlive(sandbox.pid)).toBe(false)
    expect(await probe("case02-dead")).toEqual({ tag: "Unhealthy", reason: "ping_failed" })

    // The engine host is still the thing answering: this run is new, and it
    // completed against the same database after the sandbox died.
    expect(await probe("case02-after")).toEqual({ tag: "Unhealthy", reason: "ping_failed" })
  }, 120_000)
})
