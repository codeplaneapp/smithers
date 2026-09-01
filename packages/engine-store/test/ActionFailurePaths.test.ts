/**
 * Failure and hard-boundary-violation paths of the action executor
 * (issue #21): failed execute, prepare/settle boundary failures, suspended
 * attempt rows, and the fence guard on the failed-attempt finish path.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as Clocks from "./Clocks.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const ownerA: Ownership.OwnerId = { hostId: "failure-host-a", pid: 1, nonce: "failure-owner-a" }
const ownerB: Ownership.OwnerId = { hostId: "failure-host-b", pid: 2, nonce: "failure-owner-b" }

const hardBoundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["declared.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "failure-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

type Services =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Journal.Journal
  | RunStore.RunStore
  | StepBoundary.Service
  | Jj.Jj
  | Crypto.Crypto

const run = <A, E>(
  effect: Effect.Effect<A, E, Services | Scope.Scope>,
  boundary: Layer.Layer<StepBoundary.Service> = StepBoundary.layerTest()
) =>
  withCrypto(
    effect.pipe(
      Effect.provide(Layer.mergeAll(TestStores.layer(), boundary, jj)),
      Effect.scoped
    ) as Effect.Effect<A, E, Crypto.Crypto>
  )

const activate = (runId: string, owner: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    yield* takeover(runs, runId, owner)
  })

const takeover = (runs: RunStore.Service, runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stealing = row.status === "running" && row.owner !== null
    if (stealing) {
      yield* TestClock.adjust(Duration.millis(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1))
    }
    const now = yield* Clock.currentTimeMillis
    const evidence: Ownership.LivenessEvidence | undefined = stealing
      ? { expectedOwner: row.owner!, checkedAtMs: now, kind: "cross-host-unreachable-stale" }
      : undefined
    // The store decides staleness from the clock IT reads, never from `now`,
    // so the steal is taken at the skewed moment rather than merely described
    // by it (`@smthrs/run-store` `claimAndOwn`).
    const outcome = yield* Clocks.at(now, runs.claimAndOwn(runId, snapshot, claimant, now, evidence))
    if (outcome._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} takeover was lost: ${outcome._tag}`))
    }
  })

class ExecuteFailed extends Error {
  override readonly name = "ExecuteFailed"
}

const executor = (options: {
  readonly runId: string
  readonly owner?: Ownership.OwnerId
  readonly execute?: () => Effect.Effect<unknown, unknown>
}) =>
  ActionPersistence.make({
    runId: options.runId,
    owner: options.owner ?? ownerA,
    sourceId: `failure-paths-${options.runId}`,
    execute: options.execute ?? (() => Effect.fail(new ExecuteFailed("action execute failed")))
  })

const input = (key: string, attempt = 1): ActionPersistence.ActionInput => ({
  action: {},
  attempt,
  key,
  tier: "sealed",
  metadata: hardBoundary
})

const journalState = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const entries = yield* journal.entries({ runId: runId as never, limit: 50 })
    return entries.entries.map((entry) => ({ eventType: entry.eventType, payload: entry.payload }))
  })

describe("action executor failure paths", () => {
  it.effect("records a failed finish and journals a failed attempt-finished when execute fails", () =>
    Effect.gen(function*() {
      const key = "failure/execute"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("execute-fails", ownerA)
        const exit = yield* executor({ runId: "execute-fails" })(input(key)).pipe(Effect.exit)
        const attempts = yield* AttemptStore.AttemptStore
        const row = yield* attempts.get({
          runId: "execute-fails",
          stepKeyDigest: sha256(key),
          attempt: 1
        })
        const cache = yield* CacheStore.CacheStore
        const cached = yield* cache.get(sha256(key))
        const events = yield* journalState("execute-fails")
        return { exit, row, cached, events }
      }))

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(
        Exit.isFailure(result.exit) && Cause.squash(result.exit.cause) instanceof ExecuteFailed
      ).toBe(true)
      const row = Option.getOrThrow(result.row)
      expect(row.state).toBe("failed")
      expect(row.finishedAtMs).toBeDefined()
      // A failed action never populates the sealed cache.
      expect(Option.isNone(result.cached)).toBe(true)
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
      // An ordinary execute failure is not a boundary violation.
      expect(result.events.map((event) => event.eventType)).not.toContain("flows.engine.hard-violation")
    }))

  /**
   * A defect JSON cannot express reaches the attempt row as `null`, and the
   * finish still lands.
   *
   * `AttemptStore` admits inert JSON only, so the write side reduces a live
   * failure value before handing it over. Two shapes have no JSON at all: one
   * `JSON.stringify` answers `undefined` for, and one it throws on. Both must
   * settle the attempt rather than fail the finish with an attempt-store
   * refusal, because a refused finish leaves the row `running` and the reclaim
   * machinery reads that as a crash.
   */
  const unserializable: ReadonlyArray<readonly [string, string, () => unknown]> = [
    ["a symbol", "die-symbol", () => Symbol("no JSON form")],
    ["a cycle", "die-cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }]
  ]

  for (const [what, runId, defect] of unserializable) {
    it.effect(`settles the attempt when the defect is ${what} JSON cannot express`, () =>
      Effect.gen(function*() {
        const key = `failure/${runId}`
        const result = yield* run(Effect.gen(function*() {
          yield* activate(runId, ownerA)
          const exit = yield* executor({
            runId,
            execute: () => Effect.die(defect())
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
          return { exit, row }
        }))

        expect(Exit.isFailure(result.exit)).toBe(true)
        const row = Option.getOrThrow(result.row)
        expect(row.state).toBe("failed")
        expect(row.error).toEqual({ reasons: [{ _tag: "Die", defect: null }] })
      }))
  }

  it.effect("journals a hard violation and a failed finish when boundary.prepare fails", () =>
    Effect.gen(function*() {
      const key = "failure/prepare"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("prepare-fails", ownerA)
          const exit = yield* executor({
            runId: "prepare-fails",
            execute: () => Effect.succeed("never dispatched? no: prepare fails first")
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "prepare-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const events = yield* journalState("prepare-fails")
          return { exit, row, events }
        }),
        StepBoundary.layerTest({ supported: false })
      )

      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/UnsupportedBoundary")
      expect(Option.getOrThrow(result.row).state).toBe("failed")
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).toContain("flows.engine.hard-violation")
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
    }))

  it.effect("settles the attempt when the injected sandbox refuses to open", () =>
    Effect.gen(function*() {
      // `StepSandbox.layerNoop` is the browser story: a host that cannot build
      // the forest refuses typed. The refusal must settle the attempt exactly
      // like a prepare failure — a row left "running" would read as a crash to
      // the reclaim machinery instead of a refusal.
      const key = "failure/sandbox-open"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("sandbox-open-fails", ownerA)
          const exit = yield* executor({
            runId: "sandbox-open-fails",
            execute: () => Effect.succeed("never dispatched: open refuses first")
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "sandbox-open-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const events = yield* journalState("sandbox-open-fails")
          return { exit, row, events }
        }),
        Layer.mergeAll(StepBoundary.layerTest(), StepSandbox.layerNoop)
      )

      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/UnsupportedBoundary")
      expect(Option.getOrThrow(result.row).state).toBe("failed")
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).toContain("flows.engine.hard-violation")
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
    }))

  it.effect("journals a hard violation and a failed finish when boundary.settle rejects an undeclared write", () =>
    Effect.gen(function*() {
      const key = "failure/settle"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("settle-fails", ownerA)
          const exit = yield* executor({
            runId: "settle-fails",
            execute: () => Effect.succeed("value")
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "settle-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const cache = yield* CacheStore.CacheStore
          const cached = yield* cache.get(sha256(key))
          const events = yield* journalState("settle-fails")
          return { exit, row, cached, events }
        }),
        StepBoundary.layerTest({ changedPaths: ["undeclared.txt"] })
      )

      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/UndeclaredWrite")
      expect(Option.getOrThrow(result.row).state).toBe("failed")
      expect(Option.isNone(result.cached)).toBe(true)
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).toContain("flows.engine.hard-violation")
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
    }))

  it.effect("fails with AttemptSuspended when the durable attempt row is suspended", () =>
    Effect.gen(function*() {
      const key = "failure/suspended"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("suspended-row", ownerA)
        const attempts = yield* AttemptStore.AttemptStore
        const now = yield* Clock.currentTimeMillis
        const seeded = yield* attempts.put({
          runId: "suspended-row",
          stepKeyDigest: sha256(key),
          attempt: 1,
          state: "suspended",
          startedAtMs: now,
          meta: { tier: "sealed" }
        }, ownerA)
        const exit = yield* executor({ runId: "suspended-row" })(input(key)).pipe(Effect.exit)
        return { seeded, exit }
      }))

      expect(result.seeded._tag).toBe("Inserted")
      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/AttemptSuspended")
    }))

  it.effect("fence lost while finishing a FAILED attempt: the finish is discarded and no failed lifecycle record leaks", () =>
    Effect.gen(function*() {
      const key = "failure/fence-failed-finish"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("fence-failed-finish", ownerA)
        const runs = yield* RunStore.RunStore
        const attempts = yield* AttemptStore.AttemptStore
        const failedFinish = (args: ReadonlyArray<unknown>): boolean =>
          (args[0] as { readonly state: string }).state === "failed"
        const steal: Notifying.Hook = (op, order, args) =>
          op === "finish" && order === "before" && failedFinish(args)
            ? takeover(runs, "fence-failed-finish", ownerB).pipe(Effect.orDie)
            : Effect.void

        const fencedOut = executor({ runId: "fence-failed-finish" })
        const exit = yield* fencedOut(input(key)).pipe(
          Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal)),
          Effect.forkChild({ startImmediately: true }),
          Effect.flatMap(Fiber.await)
        )
        const row = yield* attempts.get({
          runId: "fence-failed-finish",
          stepKeyDigest: sha256(key),
          attempt: 1
        })
        const events = yield* journalState("fence-failed-finish")
        return { exit, row, events }
      }))

      // The fenced owner self-interrupts instead of surfacing the action
      // failure under a lost fence.
      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
      // The failed finish never seals under the lost fence.
      expect(Option.getOrThrow(result.row).state).toBe("running")
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).not.toContain("flows.engine.attempt-finished")
      expect(eventTypes).not.toContain("flows.engine.hard-violation")
    }))

  it.effect("fence lost while settling a refused sandbox open: the finish is discarded", () =>
    Effect.gen(function*() {
      // The same fence discipline as every other settle path, on the
      // sandbox-open refusal branch: a steal between the refusal and the finish
      // self-interrupts instead of sealing under the lost fence.
      const key = "failure/fence-sandbox-open"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("fence-sandbox-open", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const failedFinish = (args: ReadonlyArray<unknown>): boolean =>
            (args[0] as { readonly state: string }).state === "failed"
          const steal: Notifying.Hook = (op, order, args) =>
            op === "finish" && order === "before" && failedFinish(args)
              ? takeover(runs, "fence-sandbox-open", ownerB).pipe(Effect.orDie)
              : Effect.void

          const fencedOut = executor({
            runId: "fence-sandbox-open",
            execute: () => Effect.succeed("never dispatched: open refuses first")
          })
          const exit = yield* fencedOut(input(key)).pipe(
            Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal)),
            Effect.forkChild({ startImmediately: true }),
            Effect.flatMap(Fiber.await)
          )
          const row = yield* attempts.get({
            runId: "fence-sandbox-open",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const events = yield* journalState("fence-sandbox-open")
          return { exit, row, events }
        }),
        Layer.mergeAll(StepBoundary.layerTest(), StepSandbox.layerNoop)
      )

      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
      expect(Option.getOrThrow(result.row).state).toBe("running")
      expect(result.events.map((event) => event.eventType)).not.toContain("flows.engine.attempt-finished")
    }))

  it.effect("persists the failing cause as explicit tagged-reason JSON, independent of the store's serializer", () =>
    Effect.gen(function*() {
      // The write side owns the durable shape: `Fail`, `Die`, and `Interrupt`
      // reasons (with and without a fiber id) all round-trip as `{reasons}` so
      // failed-attempt replay (issue #59) cannot be broken by a change in how
      // the attempt store serializes opaque values.
      const cause = Cause.fromReasons([
        Cause.makeFailReason("boom"),
        Cause.makeDieReason("defective"),
        Cause.makeInterruptReason(5),
        Cause.makeInterruptReason(undefined)
      ])
      const result = yield* run(Effect.gen(function*() {
        yield* activate("tagged-cause", ownerA)
        const attempts = yield* AttemptStore.AttemptStore
        const exit = yield* executor({
          runId: "tagged-cause",
          execute: () => Effect.failCause(cause)
        })(input("cause/tagged")).pipe(Effect.exit)
        const row = yield* attempts.get({
          runId: "tagged-cause",
          stepKeyDigest: sha256("cause/tagged"),
          attempt: 1
        })
        return { exit, row }
      }))

      expect(Exit.isFailure(result.exit)).toBe(true)
      const persisted = Option.getOrThrow(result.row).error as {
        readonly reasons: ReadonlyArray<Record<string, unknown>>
      }
      expect(persisted.reasons).toEqual([
        { _tag: "Fail", error: "boom" },
        { _tag: "Die", defect: "defective" },
        { _tag: "Interrupt", fiberId: 5 },
        { _tag: "Interrupt", fiberId: null }
      ])
    }))
})
