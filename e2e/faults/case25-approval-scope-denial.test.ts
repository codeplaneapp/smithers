/**
 * Case 25 — an approval authorises exactly what was reviewed, and nothing else.
 *
 * Three refusals, all from the served control plane rather than from a client
 * guard: an unauthenticated caller never reaches `Control` at all; a caller who
 * mutates the envelope after reading the card is refused; and a caller who
 * quotes a digest the server did not issue is refused. Each refusal is a typed
 * control failure on the wire, not a transport error.
 */
import { Control, ControlError } from "@smthrs/control"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { servedSuite } from "../harness/servedSuite.ts"

const suite = servedSuite("case25")

beforeAll(() => suite.start())
afterAll(() => suite.stop())

const plan = Effect.gen(function*() {
  const control = yield* Control.Control
  return yield* control.plan({ flowId: "system/test", input: { case: "case25" } })
})

describe("case25 approval scope denial", () => {
  it("refuses a caller with no credential before it reaches the control plane", async () => {
    const exit = await suite.remoteWith({}, Effect.exit(plan))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(ControlError.Unauthorized)
    }
  })

  it("refuses a caller with the wrong credential", async () => {
    const exit = await suite.remoteWith({ credential: "not-the-token" }, Effect.exit(plan))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(ControlError.Unauthorized)
    }
  })

  it("refuses an approval whose envelope was edited after the card was read", async () => {
    const outcome = await suite.remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* plan
        const widened = { ...card.envelope, capabilities: [...card.envelope.capabilities, "fs:write *"] }
        return yield* Effect.exit(
          control.approve({
            target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: widened as never },
            scope: card.approval.scope,
            idempotencyKey: `envelope:${card.planId}`
          })
        )
      })
    )
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) {
      expect(Cause.squash(outcome.cause)).toBeInstanceOf(ControlError.EnvelopeMismatch)
    }
  })

  it("refuses an approval quoting a digest the server never issued", async () => {
    const outcome = await suite.remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* plan
        return yield* Effect.exit(
          control.approve({
            target: { _tag: "Plan", planId: card.planId, digest: `${card.digest}-tampered`, envelope: card.envelope },
            scope: card.approval.scope,
            idempotencyKey: `digest:${card.planId}`
          })
        )
      })
    )
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) {
      expect(Cause.squash(outcome.cause)).toBeInstanceOf(ControlError.PlanDigestMismatch)
    }
  })

  it("refuses a second decision on a token that is already resolved", async () => {
    const outcome = await suite.remote(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const card = yield* plan
        const target = {
          _tag: "Plan" as const,
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope
        }
        yield* control.approve({ target, scope: card.approval.scope, idempotencyKey: `once:${card.planId}` })
        return yield* Effect.exit(
          control.deny({ target, scope: card.approval.scope, idempotencyKey: `twice:${card.planId}` })
        )
      })
    )
    expect(Exit.isFailure(outcome)).toBe(true)
    if (Exit.isFailure(outcome)) {
      expect(Cause.squash(outcome.cause)).toBeInstanceOf(ControlError.AlreadyResolved)
    }
  })
})
