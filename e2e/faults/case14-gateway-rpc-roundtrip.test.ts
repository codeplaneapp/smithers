/**
 * Case 14 — the served control plane answers a real remote round trip.
 *
 * The whole point of the case is that nothing here shares a process with the
 * server: the plan, the approval, the launch, and the listing all cross a
 * socket to another operating-system process, are encoded and decoded by the
 * shipped RPC schemas, and land in a SQLite file this process never opens.
 */
import { Control } from "@smthrs/control"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { controlClient, type ControlServerProcess, startControlServer } from "../harness/serveProcess.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case14-"))
let server: ControlServerProcess

beforeAll(async () => {
  server = await startControlServer(join(directory, "control.sqlite"))
})

afterAll(async () => {
  await server?.stop()
  rmSync(directory, { recursive: true, force: true })
})

const remote = <A, E>(body: Effect.Effect<A, E, Control.Control>): Promise<A> =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(controlClient({ url: server.url, credential: server.token }).layer),
      Effect.scoped
    ) as Effect.Effect<A, E>
  )

describe("case14 gateway RPC round trip", () => {
  it("plans, approves, launches, and lists a run over the wire", async () => {
    const result = await remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* control.plan({ flowId: "system/test", input: { case: "case14" } })
        yield* control.approve({
          target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
          scope: card.approval.scope,
          idempotencyKey: `approve:${card.planId}`
        })
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: `run:${card.planId}`
        })
        const listed = yield* control.list({ _tag: "runs" })
        return { card, receipt, listed }
      })
    )

    expect(result.card.flowId).toBe("system/test")
    expect(result.receipt._tag).toBe("Accepted")
    expect(result.listed).toMatchObject({ _tag: "runs" })
  })
})
