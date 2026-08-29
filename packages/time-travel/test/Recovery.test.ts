import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import type { Result as CompensationResult } from "../src/internal/Compensation.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import type { AuditDetail } from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.ts"
import { type Audit, TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner: OwnerId = { hostId: "recovery-host", pid: 40, nonce: "recovery-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const makeRuns = (): RunStore.Service & { readonly state: () => RunStore.RunRow } => {
  let row: RunStore.RunRow = {
    runId: "run",
    status: "running",
    createdAtMs: 0,
    startedAtMs: 0,
    finishedAtMs: null,
    owner,
    heartbeatAtMs: 0,
    claim: null,
    claimedAtMs: null,
    parentRunId: null,
    cancelRequestedAtMs: null,
    stateJson: "{\"cursor\":7}"
  }
  const service = RunStore.makeNoop({
    get: () => Effect.succeed({ ...row }),
    transitionOwned: (_runId, currentOwner, status, stateJson) =>
      Effect.sync(() => {
        if (row.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        row = {
          ...row,
          status,
          stateJson: stateJson ?? row.stateJson,
          ...(status === "running"
            ? {}
            : {
              owner: null,
              heartbeatAtMs: null,
              claim: null,
              claimedAtMs: null,
              parentRunId: null,
              cancelRequestedAtMs: null
            })
        }
        return { _tag: "Transitioned" as const }
      })
  })
  return Object.assign(service, { state: () => ({ ...row }) })
}

const journal = (hasSuffix: boolean): Journal.Service =>
  Journal.makeNoop({
    entries: () =>
      Effect.succeed({
        entries: hasSuffix
          ? [{
            runId: "run" as JournalEvent.RunId,
            seq: 1 as JournalEvent.Seq,
            eventId: "event-1",
            sourceId: "recovery" as JournalEvent.SourceId,
            sourceSeq: 1 as JournalEvent.SourceSeq,
            emittedAtMs: 1,
            eventType: "suffix",
            payload: {},
            meta: {}
          } as JournalEvent.Entry]
          : [],
        hasMore: false
      })
  })

const effect: EffectRecord = {
  id: "send",
  kind: "send",
  tier: "irreversible",
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  seq: 1,
  durableBoundary: true,
  providerStream: false
}

const compensation: CompensationResult = {
  handlerReceipts: [{
    id: "send:rollback",
    effect,
    data: { value: "sent" }
  }],
  workspace: {
    currentChangeId: "current",
    targetChangeId: "target"
  }
}

const audit = (
  phase: AuditDetail["phase"],
  detailCompensation?: CompensationResult
): Audit => ({
  id: `audit-${phase}`,
  runId: "run",
  frame,
  status: "in_progress",
  detail: {
    version: 1,
    phase,
    originalStatus: "suspended",
    suffixCount: 1,
    suffixTailSeq: 1,
    ...(detailCompensation === undefined ? {} : { compensation: detailCompensation }),
    warnings: [],
    cancelledChildren: []
  } satisfies AuditDetail
})

const seed = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  value: Audit
) => Effect.runSync(store.writeAudit(value))

const runRecovery = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  runs: RunStore.Service,
  jj: Jj.Jj,
  registry: EffectHandlerRegistry.Service,
  hasSuffix: boolean
) =>
  Recovery.recover({ owner }).pipe(
    Effect.provide(Layer.succeed(TimeTravelStore, store)),
    Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
    Effect.provide(Layer.succeed(Journal.Journal, journal(hasSuffix))),
    Effect.provide(Layer.succeed(Jj.Jj, jj)),
    Effect.provide(Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, registry))
  )

describe("Recovery", () => {
  it.effect("finishes the suspended transition when the archive transaction committed", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const runs = makeRuns()
      const registry = EffectHandlerRegistry.makeNoop()
      const jj = Jj.makeNoop({
        snapshot: () => Effect.succeed({ changeId: "current" }),
        restore: () => Effect.void
      })

      const outcomes = yield* runRecovery(store, runs, jj, registry, false)

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit-archive_committed" }])
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
      expect(store.state().audits).toMatchObject([
        { id: "audit-archive_committed", status: "completed" }
      ])
    }))

  it.effect("restores jj and handler receipts when the archive transaction did not commit", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      const runs = makeRuns()
      const external: Array<string> = []
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: (_crossed, receipt) =>
            Effect.sync(() => {
              external.push(String((receipt as { readonly value: string }).value))
            })
        }])
      )
      let pointer = "target"
      const jj = Jj.makeNoop({
        snapshot: () => Effect.succeed({ changeId: pointer }),
        restore: (changeId) =>
          Effect.sync(() => {
            pointer = changeId
          })
      })

      const outcomes = yield* runRecovery(store, runs, jj, registry, true)

      expect(outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit-compensated" }])
      expect(pointer).toBe("current")
      expect(external).toEqual(["sent"])
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
      expect(store.state().audits).toMatchObject([
        { id: "audit-compensated", status: "failed" }
      ])
    }))

  it.effect("records an unrecoverable typed terminal failure without inventing a run status", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("compensated", compensation))
      const runs = makeRuns()
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: () => Effect.fail(error("compensation_failed", "rollback failed"))
        }])
      )
      const jj = Jj.makeNoop({
        snapshot: () => Effect.succeed({ changeId: "target" }),
        restore: () => Effect.void
      })

      const outcomes = yield* runRecovery(store, runs, jj, registry, true)

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        auditId: "audit-compensated",
        error: { code: "compensation_failed" }
      })
      expect(runs.state().status).toBe("running")
      expect(["pending", "running", "suspended", "completed", "failed", "cancelled"]).toContain(
        runs.state().status
      )
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        detail: { phase: "terminal_failure" }
      })
    }))

  it.effect("isolates malformed audits so one terminal failure does not block later recovery", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, {
        id: "audit-malformed",
        runId: "run",
        frame,
        status: "in_progress",
        detail: { version: 2 }
      })
      seed(store, { ...audit("archive_committed"), id: "audit-good" })
      const runs = makeRuns()

      const outcomes = yield* runRecovery(
        store,
        runs,
        Jj.makeNoop({ restore: () => Effect.void }),
        EffectHandlerRegistry.makeNoop(),
        false
      )

      expect(outcomes).toEqual([
        expect.objectContaining({ _tag: "Failed", auditId: "audit-malformed" }),
        { _tag: "Completed", auditId: "audit-good" }
      ])
      expect(store.state().audits.map((item) => ({ id: item.id, status: item.status }))).toEqual([
        { id: "audit-malformed", status: "failed" },
        { id: "audit-good", status: "completed" }
      ])
    }))

  it.effect("propagates a pending-audit persistence failure before touching run ownership", () =>
    Effect.gen(function*() {
      let reads = 0
      const failure = yield* (
        Effect.flip(
          Recovery.recover({ owner }).pipe(
            Effect.provide(
              Layer.succeed(
                TimeTravelStore,
                TimeTravelStore.of({
                  ...MemoryTimeTravelStore.make(),
                  pendingAudits: () => Effect.fail(error("unknown", "audit store unavailable"))
                })
              )
            ),
            Effect.provide(
              Layer.succeed(
                RunStore.RunStore,
                RunStore.makeNoop({
                  get: () =>
                    Effect.sync(() => {
                      reads += 1
                      return makeRuns().state()
                    })
                })
              )
            ),
            Effect.provide(Layer.succeed(Journal.Journal, journal(false))),
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
            Effect.provide(
              Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
            )
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "audit store unavailable" })
      expect(reads).toBe(0)
    }))

  it.effect("finishes the atomic recovery transition when interrupted mid-protocol", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      seed(store, audit("archive_committed"))
      const entered = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(makeRuns().state()),
        transitionOwned: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ _tag: "Transitioned" as const })
          )
      })
      const program = Recovery.recover({ owner }).pipe(
        Effect.provide(Layer.succeed(TimeTravelStore, store)),
        Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
        Effect.provide(Layer.succeed(Journal.Journal, journal(false))),
        Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({}))),
        Effect.provide(
          Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
        )
      )
      const fiber = Effect.runFork(program)

      yield* (Deferred.await(entered))
      const interrupt = Effect.runFork(Fiber.interrupt(fiber))
      yield* (Deferred.succeed(release, undefined))
      yield* (Fiber.join(interrupt))
      const exit = yield* (Fiber.await(fiber))

      expect(exit._tag).toBe("Failure")
      expect(store.state().audits).toMatchObject([
        { id: "audit-archive_committed", status: "completed", detail: { phase: "completed" } }
      ])
    }))
})
