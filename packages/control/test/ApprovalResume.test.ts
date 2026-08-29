/**
 * A node approval has to restart the run it parked.
 *
 * `ask` parks the run as `waiting-approval` and publishes the exact payload an
 * operator replays through `smithers approve`. Answering it installed the grant
 * and resolved the token — and stopped there. The executor re-drives a parked
 * execution only when it sees `control.run.resume` or `control.run.resumed` on
 * the journal, so the run sat in `waiting-approval` until somebody made a
 * SECOND call, which rc-contract §5.1 and §10 promise a gateway client does not
 * have to make (triage B-15).
 *
 * A denial is the same shape. The ask activity reads its decision from the
 * grant store, and it only reads it when the execution is re-driven, so a
 * denied run that is never resumed never learns it was denied.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import type { ApprovalTarget, Envelope } from "../src/ControlSchema.ts"
import { durable, type DurableStack } from "./DurableStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }

const run = <A, E>(body: Effect.Effect<A, E, DurableStack>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie))

/** Plans, approves, starts, and parks one run on an in-run approval request. */
const parkedOnAsk = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:plan:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    const runId = receipt.runId
    const target: ApprovalTarget = {
      _tag: "Node",
      runId,
      requestId: `ask:${suffix}`,
      digest: "ask-digest",
      envelope
    }
    yield* runtime.registerApproval(target)
    // The park the executor writes when the ask raises `PermissionRequired`.
    const fence = yield* runtime.claimFence(runId)
    yield* runtime.writeStatus(runId, fence, "waiting-approval")
    return { runId, target }
  })

/** Every event type the run's journal carries, in order. */
const kinds = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 })
    return page.entries.map((entry) => entry.eventType)
  })

describe("deciding an in-run approval", () => {
  it("resumes the run server-side after an approval", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId, target } = yield* parkedOnAsk("approved")
      const parked = yield* runtime.getRun(runId)

      const receipt = yield* control.approve({ target, scope: "run", idempotencyKey: "approve:ask" })
      return { runId, parked, receipt, after: yield* runtime.getRun(runId), kinds: yield* kinds(runId) }
    }))

    expect(observed.parked.status).toBe("waiting-approval")
    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "approve:ask", runId: observed.runId })
    // One call, and the run is moving again.
    expect(observed.after.status).not.toBe("waiting-approval")
    const approved = observed.kinds.indexOf("control.approval.approved")
    const resumed = observed.kinds.indexOf("control.run.resumed")
    expect(approved).toBeGreaterThanOrEqual(0)
    // Order matters: the decision is the reason for the resume, so a reader
    // walking the journal sees the answer before the restart it caused.
    expect(resumed).toBeGreaterThan(approved)
  })

  it("resumes the run server-side after a denial", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const { runId, target } = yield* parkedOnAsk("denied")

      yield* control.deny({ target, scope: "run", idempotencyKey: "deny:ask" })
      return {
        runId,
        after: yield* runtime.getRun(runId),
        grants: yield* runtime.grants,
        kinds: yield* kinds(runId)
      }
    }))

    // A denial installs no grant for the request it denied; the resumed
    // attempt reads the resolved token and settles with the refusal.
    expect(observed.grants.map((grant) => grant.tokenId)).not.toContain("ask:denied")
    expect(observed.after.status).not.toBe("waiting-approval")
    const denied = observed.kinds.indexOf("control.approval.denied")
    const resumed = observed.kinds.indexOf("control.run.resumed")
    expect(denied).toBeGreaterThanOrEqual(0)
    expect(resumed).toBeGreaterThan(denied)
  })

  it("leaves a plan-level approval alone: there is no run to resume yet", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const card = yield* control.plan({ flowId: "system/test", input: { suite: "plan-level" } })
      yield* control.approve({ ...card.approval, idempotencyKey: "approve:plan-only" })
      return yield* kinds(`plan:${card.planId}`)
    }))

    expect(observed).toContain("control.approval.approved")
    expect(observed).not.toContain("control.run.resumed")
  })
})
