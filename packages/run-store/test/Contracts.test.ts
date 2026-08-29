import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as RunStore from "../src/RunStore.ts"

const owner = { hostId: "host", pid: 1, nonce: "nonce" }
const expected: RunStore.RunSnapshot = {
  status: "pending",
  owner: null,
  heartbeatAtMs: null
}

describe("service contracts", () => {
  it.effect("constructs and exercises the AttemptStore stub", () =>
    Effect.gen(function*() {
      const service = AttemptStore.makeNoop()
      const attempt: AttemptStore.Attempt = {
        runId: "run",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "running",
        startedAtMs: 0,
        meta: {}
      }
      const finish: AttemptStore.FinishAttempt = {
        runId: "run",
        stepKeyDigest: "digest",
        attempt: 0,
        state: "completed",
        finishedAtMs: 1
      }
      expect((yield* (Effect.flip(service.put(attempt, owner)))).message).toContain("put")
      expect((yield* (Effect.flip(service.get(attempt)))).message).toContain("get")
      expect(
        (yield* (Effect.flip(
          service.heartbeat("run", "digest", 0, owner, 1)
        ))).message
      ).toContain("heartbeat")
      expect((yield* (Effect.flip(service.finish(finish, owner)))).message).toContain("finish")

      const result = yield* (
        Effect.gen(function*() {
          return yield* (yield* AttemptStore.AttemptStore).get(attempt)
        }).pipe(
          Effect.provide(AttemptStore.layerNoop({
            get: () => Effect.succeed(Option.none())
          }))
        )
      )
      expect(Option.isNone(result)).toBe(true)
    }))

  it.effect("constructs and exercises the RunStore stub", () =>
    Effect.gen(function*() {
      const service = RunStore.makeNoop()
      expect((yield* (Effect.flip(service.create("run", "{}")))).method).toBe("create")
      expect((yield* (Effect.flip(service.get("run")))).method).toBe("get")
      expect(yield* (service.claim("run", expected, owner, 0))).toEqual({ _tag: "NotFound" })
      expect(yield* (service.claimAndOwn("run", expected, owner, 0))).toEqual({ _tag: "NotFound" })
      expect(yield* (service.activate("run", owner, 0, expected))).toEqual({ _tag: "ClaimLost" })
      expect(yield* (service.abandonClaim("run", owner, 0))).toEqual({ _tag: "ClaimLost" })
      expect(
        yield* (service.recoverClaim("run", owner, 0, owner, 31_000, {
          expectedOwner: owner,
          checkedAtMs: 31_000,
          kind: "same-host-pid-dead"
        }))
      ).toEqual({ _tag: "NotFound" })
      expect(yield* (service.heartbeat("run", owner, 0))).toEqual({ _tag: "NotFound" })
      expect(yield* (service.transitionOwned("run", owner, "failed"))).toEqual({ _tag: "NotFound" })
      expect(
        yield* (service.steal("run", expected, owner, 0, {
          expectedOwner: owner,
          checkedAtMs: 0,
          kind: "same-host-pid-dead"
        }))
      ).toEqual({ _tag: "NotFound" })

      const result = yield* (
        Effect.gen(function*() {
          return yield* (yield* RunStore.RunStore).heartbeat("run", owner, 0)
        }).pipe(
          Effect.provide(RunStore.layerNoop({
            heartbeat: () => Effect.succeed({ _tag: "Updated" })
          }))
        )
      )
      expect(result).toEqual({ _tag: "Updated" })
    }))
})
