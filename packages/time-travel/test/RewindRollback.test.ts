import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import type { LineageEdge } from "../src/Frame.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner: OwnerId = { hostId: "test-host", pid: 20, nonce: "rollback-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const runError = () =>
  new RunStore.RunStoreError({
    code: "not_found_row",
    method: "get",
    message: "run missing",
    cause: "get"
  })

const makeRuns = (
  initial: RunStore.RunRow,
  overrides: Partial<RunStore.Service> = {}
): RunStore.Service & { readonly state: () => RunStore.RunRow } => {
  let row = { ...initial }
  const service = RunStore.makeNoop({
    get: () => Effect.succeed({ ...row }),
    claim: (_runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        if (row.claim !== null) return { _tag: "AlreadyClaimed" as const }
        row.claim = claimant
        row.claimedAtMs = nowMs
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (_runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        if (row.claim?.nonce !== claimant.nonce || row.claimedAtMs !== claimedAtMs) {
          return { _tag: "ClaimLost" as const }
        }
        row.status = "running"
        row.owner = claimant
        row.heartbeatAtMs = claimedAtMs
        row.claim = null
        row.claimedAtMs = null
        return { _tag: "Activated" as const }
      }),
    abandonClaim: () => Effect.succeed({ _tag: "Abandoned" as const }),
    transitionOwned: (_runId, currentOwner, status, stateJson) =>
      Effect.sync(() => {
        if (row.owner?.nonce !== currentOwner.nonce) return { _tag: "FenceLost" as const }
        row.status = status
        row.stateJson = stateJson ?? row.stateJson
        if (status !== "running") {
          row.owner = null
          row.heartbeatAtMs = null
          row.claim = null
          row.claimedAtMs = null
        }
        return { _tag: "Transitioned" as const }
      }),
    create: () => Effect.fail(runError()),
    ...overrides
  })
  return Object.assign(service, { state: () => ({ ...row }) })
}

const runRow = (): RunStore.RunRow => ({
  runId: "run",
  status: "suspended",
  createdAtMs: 1,
  startedAtMs: 2,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{\"cursor\":9}"
})

const stored = (
  seq: number,
  eventType: string,
  payload: unknown
): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq,
  eventId: `event-${seq}`,
  lineageId: "run/root",
  payload: { eventType, payload, meta: { lineageId: "run/root" } }
})

const crossed = (
  id: string,
  kind: string,
  tier: EffectBoundary.EffectTier
): Omit<EffectBoundary.EffectRecord, "seq"> => ({
  id,
  kind,
  tier,
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  ...(tier === "compensable" ? { changeId: "target" } : {}),
  durableBoundary: true,
  providerStream: false
})

const records = (): ReadonlyArray<MemoryTimeTravelStore.JournalRecord> => [
  stored(0, "baseline", {}),
  stored(1, EffectBoundary.eventType, { version: 1, effect: crossed("send", "send", "irreversible") }),
  stored(2, EffectBoundary.eventType, { version: 1, effect: crossed("workspace", "fs-write", "compensable") })
]

const edge: LineageEdge = {
  parentRunId: "run",
  parentSeq: 1,
  childRunId: "run/root/attached",
  kind: "child",
  attached: true
}

const makeJournal = (
  store: ReturnType<typeof MemoryTimeTravelStore.make>
): Journal.Service =>
  Journal.makeNoop({
    entries: ({ runId, after, limit }) =>
      Effect.sync(() => {
        const all = store.state().records
          .filter((record) => record.runId === runId && record.seq > (after ?? -1))
          .sort((left, right) => left.seq - right.seq)
        const page = all.slice(0, limit)
        return {
          entries: page.map((record) => {
            const value = record.payload as {
              readonly eventType: string
              readonly payload: unknown
              readonly meta: unknown
            }
            return {
              runId: record.runId as JournalEvent.RunId,
              seq: record.seq as JournalEvent.Seq,
              eventId: record.eventId,
              sourceId: "rollback" as JournalEvent.SourceId,
              sourceSeq: record.seq as JournalEvent.SourceSeq,
              emittedAtMs: record.seq,
              eventType: value.eventType,
              payload: value.payload,
              meta: value.meta
            } as JournalEvent.Entry
          }),
          hasMore: all.length > page.length
        }
      })
  })

const makeJj = () => {
  let pointer = "current"
  const service = Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: pointer }),
    restore: (changeId) =>
      Effect.sync(() => {
        pointer = changeId
      })
  })
  return { service, pointer: () => pointer }
}

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options: {
    readonly store: ReturnType<typeof MemoryTimeTravelStore.make>
    readonly runs: RunStore.Service
    readonly jj: Jj.Jj
    readonly registry?: EffectHandlerRegistry.Service
    readonly journal?: Journal.Service
  }
) =>
  program.pipe(
    Effect.provide(Layer.succeed(TimeTravelStore, options.store)),
    Effect.provide(Layer.succeed(RunStore.RunStore, options.runs)),
    Effect.provide(Layer.succeed(Journal.Journal, options.journal ?? makeJournal(options.store))),
    Effect.provide(CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })),
    Effect.provide(Layer.succeed(Jj.Jj, options.jj)),
    Effect.provide(
      Layer.succeed(
        EffectHandlerRegistry.EffectHandlerRegistry,
        options.registry ?? EffectHandlerRegistry.makeNoop()
      )
    )
  )

const failureSteps: ReadonlyArray<Rewind.RewindStep> = [
  "claim-run",
  "rate-limit",
  "write-audit",
  "load-suffix",
  "assess-boundary",
  "compensate-effects",
  "restore-workspace",
  "archive-and-truncate"
]

describe("Rewind rollback parity row 4", () => {
  for (const step of failureSteps) {
    it.effect(`fault injection "${step}" restores journal, run, lineage, jj, and receipts while retaining the audit`, () =>
      Effect.gen(function*() {
        const timeStore = MemoryTimeTravelStore.make({
          records: records(),
          edges: [edge],
          snapshots: [{ runId: "run", frame, changeId: "target" }]
        })
        const runs = makeRuns(runRow())
        const jj = makeJj()
        const external = ["sent"]
        const handler: EffectHandlerRegistry.Handler = {
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message remains sent",
          revert: () =>
            Effect.sync(() => {
              const value = external.pop()
              return { value }
            }),
          rollback: (_effect, receipt) =>
            Effect.sync(() => {
              external.push(String((receipt as { readonly value: string }).value))
            })
        }
        const registry = Effect.runSync(EffectHandlerRegistry.make([handler]))
        const storeBefore = timeStore.state()
        const runBefore = runs.state()
        const failure = yield* (
          Effect.flip(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: `audit-${step}`,
              hooks: {
                beforeStep: (current) =>
                  current === step
                    ? Effect.fail(new Error(`injected ${step}`))
                    : Effect.void
              }
            }).pipe(
              Effect.provide(Layer.succeed(TimeTravelStore, timeStore)),
              Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
              Effect.provide(Layer.succeed(Journal.Journal, makeJournal(timeStore))),
              Effect.provide(CacheStore.layerNoop({
                get: () => Effect.succeed(Option.none())
              })),
              Effect.provide(Layer.succeed(Jj.Jj, jj.service)),
              Effect.provide(Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, registry))
            )
          )
        )
        const storeAfter = timeStore.state()

        expect(failure.code).toBe("unknown")
        expect(storeAfter.records).toEqual(storeBefore.records)
        expect(storeAfter.archived).toEqual(storeBefore.archived)
        expect(storeAfter.edges).toEqual(storeBefore.edges)
        expect(storeAfter.receipts).toEqual(storeBefore.receipts)
        expect(storeAfter.snapshots).toEqual(storeBefore.snapshots)
        expect(runs.state()).toEqual(runBefore)
        expect(jj.pointer()).toBe("current")
        expect(external).toEqual(["sent"])
        expect(storeAfter.audits).toHaveLength(1)
        expect(storeAfter.audits[0]).toMatchObject({
          id: `audit-${step}`,
          status: "failed"
        })
        expect(storeAfter.audits[0]?.status).not.toBe("in_progress")
      }))
  }
})

describe("Rewind protocol fault matrix", () => {
  for (
    const scenario of [
      { failAt: "writeAudit", auditStatus: undefined },
      { failAt: "updateAudit", auditStatus: "in_progress" },
      { failAt: "archiveAndTruncate:commit", auditStatus: "failed" }
    ] as const
  ) {
    it.effect(`restores ownership and history after the ${scenario.failAt} store fault`, () =>
      Effect.gen(function*() {
        const initialRecords = [stored(0, "baseline", {}), stored(1, "suffix", {})]
        const store = MemoryTimeTravelStore.make({ records: initialRecords, failAt: scenario.failAt })
        const runs = makeRuns(runRow())

        const failure = yield* (
          Effect.flip(
            provide(
              Rewind.rewind({
                runId: "run",
                frame,
                owner,
                auditId: `audit-${scenario.failAt}`
              }),
              { store, runs, jj: makeJj().service }
            )
          )
        )

        expect(failure).toMatchObject({
          code: "unknown",
          message: `injected failure at ${scenario.failAt}`
        })
        expect(runs.state()).toEqual(runRow())
        expect(store.state().records).toEqual(initialRecords)
        expect(store.state().archived).toEqual([])
        expect(store.state().receipts).toEqual([])
        expect(store.state().audits.map((audit) => audit.status)).toEqual(
          scenario.auditStatus === undefined ? [] : [scenario.auditStatus]
        )
      }))
  }

  // `Compensation.restoreWorkspace` rolls back every handler receipt itself on
  // both of its failure paths, so the outer failure branch must not roll them
  // back a second time. A handler's `rollback` re-performs the side effect the
  // revert undid and nothing requires it to be idempotent, so a jj snapshot or
  // restore failure at this phase used to duplicate the external effect. The
  // fault matrix cannot see it: its hooks fire BETWEEN phases, never inside
  // this one.
  it.effect("rolls each handler receipt back exactly once when restoreWorkspace fails", () =>
    Effect.gen(function*() {
      for (
        const scenario of [
          {
            name: "snapshot",
            jj: Jj.makeNoop({
              snapshot: () => Effect.fail(new Jj.JjError({ code: "unknown", message: "snapshot refused" })),
              restore: () => Effect.void
            })
          },
          {
            name: "restore",
            jj: Jj.makeNoop({
              snapshot: () => Effect.succeed({ changeId: "current" }),
              restore: () => Effect.fail(new Jj.JjError({ code: "unknown", message: "restore refused" }))
            })
          }
        ]
      ) {
        const store = MemoryTimeTravelStore.make({
          records: records(),
          snapshots: [{ runId: "run", frame, changeId: "target" }]
        })
        const runs = makeRuns(runRow())
        const external = ["sent"]
        const rollbacks: Array<string> = []
        const registry = Effect.runSync(
          EffectHandlerRegistry.make([{
            kind: "send",
            tier: "irreversible",
            requiresIdempotencyKey: true,
            residue: () => "message remains sent",
            revert: () => Effect.sync(() => ({ value: external.pop() })),
            rollback: (effect, receipt) =>
              Effect.sync(() => {
                rollbacks.push(effect.id)
                external.push(String((receipt as { readonly value: string }).value))
              })
          }])
        )

        const failure = yield* (
          Effect.flip(
            provide(
              Rewind.rewind({ runId: "run", frame, owner, auditId: `audit-restore-${scenario.name}` }),
              { store, runs, jj: scenario.jj, registry }
            )
          )
        )

        expect(failure.code, scenario.name).toBe("compensation_failed")
        expect(rollbacks, scenario.name).toEqual(["send"])
        expect(external, scenario.name).toEqual(["sent"])
        expect(runs.state(), scenario.name).toEqual(runRow())
        expect(store.state().records, scenario.name).toEqual(records())
      }
    }))

  it.effect("fails a journal read, rolls ownership back, and records the audit failure", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: records() })
      const runs = makeRuns(runRow())
      const jj = makeJj()

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-journal-failure" }),
            { store, runs, jj: jj.service, journal: Journal.makeNoop() }
          )
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not read suffix for run" })
      expect(runs.state()).toEqual(runRow())
      expect(store.state().records).toEqual(records())
      expect(store.state().audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
    }))

  it.effect("rejects an empty suffix continuation page without archiving history", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [stored(0, "baseline", {})] })
      const runs = makeRuns(runRow())
      const jj = makeJj()
      let pages = 0

      const failure = yield* Effect.flip(
        provide(
          Rewind.rewind({ runId: "run", frame, owner }),
          {
            store,
            runs,
            jj: jj.service,
            journal: Journal.makeNoop({
              entries: ({ after }) =>
                Effect.sync(() => {
                  pages += 1
                  return after === undefined
                    ? {
                      entries: [{
                        runId: "run" as JournalEvent.RunId,
                        seq: 0 as JournalEvent.Seq,
                        eventId: "event-0",
                        sourceId: "rollback" as JournalEvent.SourceId,
                        sourceSeq: 0 as JournalEvent.SourceSeq,
                        emittedAtMs: 0,
                        eventType: "baseline",
                        payload: {},
                        meta: { lineageId: frame.lineageId }
                      }],
                      hasMore: false
                    }
                    : { entries: [], hasMore: true }
                })
            })
          }
        )
      )

      expect(pages).toBe(2)
      expect(failure).toMatchObject({
        code: "invalid",
        message: "journal suffix returned an empty continuation page for run"
      })
      expect(store.state().archived).toEqual([])
    }))

  it.effect("persists handler receipts before workspace restoration and recovery can roll them back", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: records(),
        snapshots: [{ runId: "run", frame, changeId: "target" }]
      })
      const runs = makeRuns(runRow())
      const rollbacks: Array<string> = []
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ value: "sent" }),
          rollback: (crossedEffect) =>
            Effect.sync(() => {
              rollbacks.push(crossedEffect.id)
            })
        }])
      )
      let persisted: Rewind.AuditDetail | undefined

      yield* Effect.flip(provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit-receipts-before-workspace",
          hooks: {
            beforeStep: (step) =>
              step === "restore-workspace"
                ? Effect.sync(() => {
                  persisted = store.state().audits[0]?.detail as Rewind.AuditDetail
                }).pipe(Effect.andThen(Effect.fail(new Error("crash before workspace restore"))))
                : Effect.void
          }
        }),
        { store, runs, jj: makeJj().service, registry }
      ))

      expect(persisted?.compensation?.handlerReceipts).toHaveLength(1)
      rollbacks.length = 0
      const recoveryStore = MemoryTimeTravelStore.make({ records: records() })
      yield* recoveryStore.writeAudit({
        id: "audit-recover-persisted-receipts",
        runId: "run",
        frame,
        status: "in_progress",
        detail: persisted
      })
      const recoveryRuns = makeRuns({
        ...runRow(),
        status: "running",
        owner,
        heartbeatAtMs: 1
      })

      const outcomes = yield* provide(
        Recovery.recover({ owner }),
        { store: recoveryStore, runs: recoveryRuns, jj: makeJj().service, registry }
      )

      expect(outcomes).toEqual([{
        _tag: "RolledBack",
        auditId: "audit-recover-persisted-receipts"
      }])
      expect(rollbacks).toEqual(["send"])
    }))

  it.effect("leaves the audit recoverable when restoring run ownership fails or loses its fence", () =>
    Effect.gen(function*() {
      const persistenceError = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "transitionOwned",
        message: "restore database unavailable",
        cause: "restore database unavailable"
      })
      for (
        const scenario of [
          {
            label: "write failure",
            transition: () => Effect.fail(persistenceError),
            restoration: "restore run state failed"
          },
          {
            label: "fence loss",
            transition: () => Effect.succeed({ _tag: "FenceLost" as const }),
            restoration: "restore run state returned FenceLost"
          }
        ]
      ) {
        const store = MemoryTimeTravelStore.make({ records: [stored(0, "baseline", {})] })
        const runs = makeRuns(runRow(), { transitionOwned: scenario.transition })

        const failure = yield* Effect.flip(provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: `audit-restore-${scenario.label}`,
            hooks: {
              beforeStep: (step) =>
                step === "write-audit"
                  ? Effect.fail(new Error("original protocol failure"))
                  : Effect.void
            }
          }),
          { store, runs, jj: makeJj().service }
        ))

        expect(failure.message).toContain("original protocol failure")
        expect(failure.message).toContain(scenario.restoration)
        expect(store.state().audits[0]).toMatchObject({ status: "in_progress" })
      }
    }))

  it.effect("reads every non-empty suffix page before archiving history", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: [
          stored(0, "baseline", {}),
          stored(1, "suffix", { value: 1 }),
          stored(2, "suffix", { value: 2 })
        ]
      })
      const runs = makeRuns(runRow())

      const result = yield* (
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-paged", pageSize: 1 }),
          { store, runs, jj: makeJj().service }
        )
      )

      expect(result.archive.archived).toBe(2)
      expect(store.state().archived.map((record) => record.seq)).toEqual([1, 2])
      expect(store.state().records.map((record) => record.seq)).toEqual([0])
    }))

  it.effect("normalizes Error and non-Error protocol defects", () =>
    Effect.gen(function*() {
      for (
        const [defect, message] of [
          [new Error("rewind-error"), "rewind-error"],
          ["rewind-defect", "rewind-defect"]
        ] as const
      ) {
        const store = MemoryTimeTravelStore.make({ records: [stored(0, "baseline", {})] })
        const runs = makeRuns(runRow())
        const jj = makeJj()
        const failure = yield* (
          Effect.flip(
            provide(
              Rewind.rewind({
                runId: "run",
                frame,
                owner,
                auditId: `audit-${message}`,
                hooks: { beforeStep: () => Effect.die(defect) }
              }),
              { store, runs, jj: jj.service }
            )
          )
        )

        expect(failure).toMatchObject({ code: "unknown", message })
        expect(runs.state()).toEqual(runRow())
      }
    }))

  it.effect("does not compensate after the archive commit when suspension fails or loses its fence", () =>
    Effect.gen(function*() {
      const persistenceError = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "transitionOwned",
        message: "database unavailable",
        cause: "transitionOwned"
      })
      for (
        const scenario of [
          {
            message: "suspend rewound run failed",
            transition: () => Effect.fail(persistenceError)
          },
          {
            message: "run run lost ownership before suspension",
            transition: () => Effect.succeed({ _tag: "FenceLost" as const })
          }
        ]
      ) {
        const store = MemoryTimeTravelStore.make({ records: [stored(0, "baseline", {}), stored(1, "suffix", {})] })
        const runs = makeRuns(runRow(), { transitionOwned: scenario.transition })
        const jj = makeJj()

        const failure = yield* (
          Effect.flip(
            provide(
              Rewind.rewind({ runId: "run", frame, owner, auditId: `audit-${scenario.message}` }),
              { store, runs, jj: jj.service }
            )
          )
        )

        expect(failure.message).toBe(scenario.message)
        expect(store.state().records.map((record) => record.seq)).toEqual([0])
        expect(store.state().archived.map((record) => record.seq)).toEqual([1])
        expect(store.state().audits[0]).toMatchObject({
          status: "in_progress",
          detail: { phase: "archive_committed" }
        })
      }
    }))

  it.effect("abandons the activated claim when pre-audit failure and state restoration both fail", () =>
    Effect.gen(function*() {
      const abandoned: Array<number> = []
      const persistenceError = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "transitionOwned",
        message: "database unavailable",
        cause: "transitionOwned"
      })
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(runRow()),
        claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 8 }),
        activate: () => Effect.succeed({ _tag: "Activated" as const }),
        transitionOwned: () => Effect.fail(persistenceError),
        abandonClaim: (_runId, _owner, claimedAtMs) =>
          Effect.sync(() => {
            abandoned.push(claimedAtMs)
            return { _tag: "Abandoned" as const }
          })
      })
      const store = MemoryTimeTravelStore.make({ records: [stored(0, "baseline", {})] })

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: "audit-preflight-failure",
              rateLimit: () => Effect.fail(error("rate_limited", "rate limiter unavailable"))
            }),
            { store, runs, jj: makeJj().service }
          )
        )
      )

      expect(failure).toMatchObject({ code: "rate_limited", message: "rate limiter unavailable" })
      expect(abandoned).toEqual([8])
      expect(store.state().audits).toEqual([])
    }))

  it.effect("reports a terminal compensation failure when rewind rollback fails", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({
        records: records(),
        snapshots: [{ runId: "run", frame, changeId: "target" }]
      })
      const runs = makeRuns(runRow())
      const jj = makeJj()
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ sent: true }),
          rollback: () => Effect.fail(error("compensation_failed", "provider rollback failed"))
        }])
      )

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: "audit-rollback-failure",
              hooks: {
                beforeStep: (step) =>
                  step === "restore-workspace" ? Effect.fail(new Error("stop before archive")) : Effect.void
              }
            }),
            { store, runs, jj: jj.service, registry }
          )
        )
      )

      expect(failure).toMatchObject({ code: "compensation_failed" })
      expect(failure.cause).toMatchObject({ rewind: expect.anything(), rollback: expect.anything() })
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        detail: { phase: "terminal_failure", failure: expect.stringContaining("rollback failed") }
      })
      expect(store.state().records).toEqual(records())
    }))

  it.effect("finishes rollback cleanup after interruption", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: records() })
      const runs = makeRuns(runRow())
      const jj = makeJj()
      const entered = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      const fiber = Effect.runFork(
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: "audit-interrupted",
            hooks: {
              beforeStep: (step) =>
                step === "load-suffix"
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Effect.void
            }
          }),
          { store, runs, jj: jj.service }
        )
      )

      yield* (Deferred.await(entered))
      yield* (Fiber.interrupt(fiber))
      yield* (Deferred.succeed(release, undefined))
      const exit = yield* (Fiber.await(fiber))

      expect(exit._tag).toBe("Failure")
      expect(runs.state()).toEqual(runRow())
      expect(store.state().records).toEqual(records())
      expect(store.state().audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
    }))

  it.effect("leaves an interrupted rewind interrupted rather than failing with code unknown (B5)", () =>
    Effect.gen(function*() {
      // The case above asserts the rollback side effects. Nothing asserted the
      // Exit itself, and it was wrong: `toFailure` squashed the interrupt-only
      // cause into `TimeTravelError{code:"unknown"}`, so a cancelled rewind
      // reported as a failed rewind and the interruption never propagated.
      const store = MemoryTimeTravelStore.make({ records: records() })
      const runs = makeRuns(runRow())
      const jj = makeJj()
      const entered = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      const fiber = Effect.runFork(
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: "audit-interrupt-propagates",
            hooks: {
              beforeStep: (step) =>
                step === "load-suffix"
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                  : Effect.void
            }
          }),
          { store, runs, jj: jj.service }
        )
      )

      yield* (Deferred.await(entered))
      yield* (Fiber.interrupt(fiber))
      yield* (Deferred.succeed(release, undefined))
      const exit = yield* (Fiber.await(fiber))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      // The rollback still completes; the interruption is what the caller sees.
      expect(store.state().audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
    }))
})

describe("Rewind after the archive is committed", () => {
  it.effect("leaves the audit at archive_committed when the run fence is lost", () =>
    Effect.gen(function*() {
      // Once the archive commits, the rewind cannot be rolled back: the whole
      // compensation block at Rewind.ts:611-660 is skipped. The failure path from
      // that point on was never driven, so nothing asserted what state it leaves
      // for Recovery to pick up. It has to leave the audit at
      // `archive_committed` — a rewind that archived and then lost the fence is
      // half-applied, and an audit marked `failed` or `rolled_back` would tell
      // Recovery there is nothing to finish.
      const store = MemoryTimeTravelStore.make({
        records: records(),
        snapshots: [{ runId: "run", frame, changeId: "target" }]
      })
      const jj = makeJj()
      // The post-archive transition to `suspended` is the step that loses the
      // fence; every earlier transition still succeeds.
      const runs = makeRuns(runRow(), {
        transitionOwned: (_runId, _owner, status) =>
          Effect.succeed(status === "suspended" ? { _tag: "FenceLost" as const } : { _tag: "Transitioned" as const })
      })
      const rollbacks: Array<string> = []
      const registry = Effect.runSync(
        EffectHandlerRegistry.make([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "message residue",
          revert: () => Effect.succeed({ sent: true }),
          rollback: () =>
            Effect.sync(() => {
              rollbacks.push("send")
            })
        }])
      )

      const failure = yield* (
        Effect.flip(
          provide(
            Rewind.rewind({ runId: "run", frame, owner, auditId: "audit-fence-lost" }),
            { store, runs, jj: jj.service, registry }
          )
        )
      )

      expect(failure.code).toBe("busy")
      const audit = store.state().audits[0]
      // Left for Recovery: the archive is durable and the audit says so.
      expect(audit).toMatchObject({ id: "audit-fence-lost", detail: { phase: "archive_committed" } })
      expect(audit?.status).not.toBe("failed")
      // And no compensation ran: the archive is durable, so undoing the
      // effect handlers would contradict it.
      expect(rollbacks).toEqual([])
    }))
})
