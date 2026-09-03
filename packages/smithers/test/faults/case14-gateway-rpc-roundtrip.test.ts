/**
 * Case 14 — `smithers serve` answers a real remote round trip.
 *
 * The whole point of the case is that nothing here shares a process with the
 * server: the plan, the approval, the launch, and the listing all cross a
 * socket to another operating-system process, are encoded and decoded by the
 * shipped RPC schemas, and land in a SQLite file this process never opens.
 * The server is the product's own command — `smithers serve`, spawned from the
 * bin `@smthrs/cli` declares — so the composition, the authentication, and the
 * database location are the verb's decisions rather than the suite's.
 */
import { Control } from "@smthrs/control"
import { isAlive, parentPid } from "@smthrs/testing/Faults"
import * as Effect from "effect/Effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { controlClient, type ServeProcess, startServe } from "./harness/serveProcess.ts"

const directory = mkdtempSync(join(tmpdir(), "smithers-e2e-case14-"))
let server: ServeProcess

beforeAll(async () => {
  server = await startServe(directory)
}, 180_000)

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
  }, 180_000)

  it("is answered by a separate `smithers serve` process, over its own database", async () => {
    // The server is another process: it has its own pid, it is this suite's
    // child rather than this suite, and it is still alive after the round trip
    // above. Without these three the case could pass against a server built in
    // this process, which is the thing it exists to rule out.
    expect(server.pid).not.toBe(process.pid)
    expect(parentPid(server.pid)).toBe(process.pid)
    expect(isAlive(server.pid)).toBe(true)
    expect(server.argv).toContain("serve")
    expect(server.argv[0]?.endsWith("bin/smithers.mjs")).toBe(true)

    // And it chose where the run went. `.flows/control.db` under the project
    // root is the verb's decision, not a path this suite handed it.
    expect(server.databasePath).toBe(join(directory, ".flows", "control.db"))
    expect(existsSync(server.databasePath)).toBe(true)
  })
})
