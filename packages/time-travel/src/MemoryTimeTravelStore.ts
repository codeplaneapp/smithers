/**
 * A `TimeTravelStore` held entirely in JavaScript objects.
 *
 * This is the reference implementation of the store contract and the one every
 * time-travel test runs against: it is deterministic, needs no database, and
 * works in the browser. {@link make} additionally exposes the whole mutable
 * world as a {@link MemoryState} snapshot, so a test asserts on what a rewind
 * *did* rather than on what it returned, and {@link Options.failAt} injects a
 * failure at a named step so crash-recovery paths are reachable without
 * actually crashing.
 *
 * It is a behavioural peer of `SqlTimeTravelStore`, not a lesser one: the two
 * are held to the same answers for the same history.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Frame, LineageEdge } from "./Frame.ts"
import { error, TimeTravelError } from "./TimeTravelError.ts"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/**
 * One journal record as this store holds it.
 *
 * It is a seeded stand-in for a real engine journal row, carrying only the
 * fields the derived reads fold over: the `(runId, seq)` coordinate, the
 * `lineageId` the frame addresses, and an opaque `payload`. A test seeds these
 * through {@link Options.records} to describe a run's past.
 *
 * @since 0.1.0
 * @category models
 */
export interface JournalRecord {
  readonly runId: string
  readonly seq: number
  readonly eventId: string
  readonly lineageId: string
  readonly payload: unknown
  /**
   * The engine record type this stands in for, when a test drives the derived
   * reads. Absent means "some other record", which the folds skip.
   */
  readonly eventType?: string | undefined
}
/**
 * The store's entire contents, as returned by the `state()` method
 * {@link make} attaches.
 *
 * Every collection is copied on read, so a test can capture the world before
 * an operation and compare it with the world after — including the parts no
 * operation returns, like which records were archived rather than dropped and
 * which lineage edges survived.
 *
 * @since 0.1.0
 * @category models
 */
export interface MemoryState {
  readonly records: ReadonlyArray<JournalRecord>
  readonly archived: ReadonlyArray<JournalRecord>
  readonly edges: ReadonlyArray<LineageEdge>
  readonly audits: ReadonlyArray<TimeTravelStore.Audit>
  readonly receipts: ReadonlyArray<TimeTravelStore.Receipt>
  readonly snapshots: ReadonlyArray<TimeTravelStore.Snapshot>
  readonly liveRuns: ReadonlySet<string>
}
/**
 * The history a memory store starts life holding, plus the one knob that makes
 * it misbehave on purpose.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  /** Journal records the run has already written, oldest first. */
  readonly records?: ReadonlyArray<JournalRecord>
  /** Pre-existing lineage edges, so a test can describe a run that already has descendants. */
  readonly edges?: ReadonlyArray<LineageEdge>
  /** Tier-2 anchors the snapshot projector would have recorded. */
  readonly snapshots?: ReadonlyArray<TimeTravelStore.Snapshot>
  /**
   * Runs to treat as still executing. A frame belonging to one of these is
   * refused with `live_parent` or `live_child`.
   */
  readonly liveRuns?: ReadonlySet<string>
  /**
   * Throws an `unknown`-coded {@link TimeTravelError} at the named internal
   * step, so a test can interrupt a rewind mid-flight and then assert that
   * recovery finishes or rolls it back.
   */
  readonly failAt?: string
}

const descendantsFrom = (
  edges: ReadonlyArray<LineageEdge>,
  runId: string,
  frame: Frame
): {
  readonly attached: ReadonlyArray<LineageEdge>
  readonly detached: ReadonlyArray<LineageEdge>
  readonly attachedRunIds: ReadonlySet<string>
} => {
  const attached: Array<LineageEdge> = []
  const detached: Array<LineageEdge> = []
  const attachedRunIds = new Set<string>()
  const detachedRunIds = new Set<string>()
  const queue: Array<string> = []

  const include = (edge: LineageEdge): void => {
    if (edge.attached) {
      if (attachedRunIds.has(edge.childRunId)) return
      attached.push(edge)
      attachedRunIds.add(edge.childRunId)
      queue.push(edge.childRunId)
    } else {
      if (detachedRunIds.has(edge.childRunId)) return
      detached.push(edge)
      detachedRunIds.add(edge.childRunId)
    }
  }

  for (const edge of edges) {
    if (edge.parentRunId === runId && edge.parentSeq > frame.seq) include(edge)
  }
  while (queue.length > 0) {
    const parentRunId = queue.shift()!
    for (const edge of edges) {
      if (edge.parentRunId === parentRunId) include(edge)
    }
  }

  return { attached, detached, attachedRunIds }
}

/**
 * Creates an in-memory store seeded from `options`, returning the store
 * *widened* with a `state()` inspector.
 *
 * The widened return is the reason to call this instead of {@link layer}: the
 * inspector is not part of the `TimeTravelStore` contract, so a test that
 * wants to assert on archived records or surviving edges must hold the
 * concrete store rather than resolve the service.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options: Options = {}): TimeTravelStore.Service & { readonly state: () => MemoryState } => {
  let records = [...(options.records ?? [])]
  let archived: Array<JournalRecord> = []
  let edges = [...(options.edges ?? [])]
  let audits: Array<TimeTravelStore.Audit> = []
  let receipts: Array<TimeTravelStore.Receipt> = []
  let snapshots = [...(options.snapshots ?? [])]
  const liveRuns = new Set(options.liveRuns ?? [])
  let sequence = 0
  const fail = (step: string): void => {
    if (options.failAt === step) throw error("unknown", `injected failure at ${step}`)
  }
  const state = (): MemoryState => ({
    records: [...records],
    archived: [...archived],
    edges: [...edges],
    audits: [...audits],
    receipts: [...receipts],
    snapshots: [...snapshots],
    liveRuns: new Set(liveRuns)
  })
  /** The lineage-filtered prefix of one record type, mirroring the SQL store. */
  const framed = (
    runId: string,
    frame: Frame,
    eventType: string
  ): ReadonlyArray<JournalRecord> =>
    records
      .filter((record) =>
        record.runId === runId &&
        record.seq <= frame.seq &&
        record.eventType === eventType &&
        record.lineageId === frame.lineageId
      )
      .sort((left, right) => left.seq - right.seq)
  const atomic = <A>(body: () => A): Effect.Effect<A, TimeTravelError> =>
    Effect.try({
      try: () => {
        const before = state()
        const beforeSequence = sequence
        try {
          return body()
        } catch (cause) {
          records = [...before.records]
          archived = [...before.archived]
          edges = [...before.edges]
          audits = [...before.audits]
          receipts = [...before.receipts]
          snapshots = [...before.snapshots]
          liveRuns.clear()
          for (const runId of before.liveRuns) liveRuns.add(runId)
          sequence = beforeSequence
          throw cause
        }
      },
      catch: (cause) =>
        cause instanceof TimeTravelError
          ? cause
          : error("unknown", "memory transaction failed", cause)
    })
  const service = TimeTravelStore.make({
    snapshotAt: Effect.fn("TimeTravelStore.snapshotAt")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() =>
          snapshots.filter((snapshot) =>
            snapshot.runId === runId && snapshot.frame.lineageId === frame.lineageId && snapshot.frame.seq <= frame.seq
          ).sort((a, b) => b.frame.seq - a.frame.seq)[0]
        )
      ))
    ),
    recordSnapshot: Effect.fn("TimeTravelStore.recordSnapshot")((snapshot) =>
      Effect.annotateCurrentSpan({
        runId: snapshot.runId,
        lineageId: snapshot.frame.lineageId,
        seq: snapshot.frame.seq
      }).pipe(Effect.andThen(atomic(() => {
        fail("recordSnapshot")
        snapshots = [
          ...snapshots.filter((existing) =>
            !(
              existing.runId === snapshot.runId &&
              existing.frame.lineageId === snapshot.frame.lineageId &&
              existing.frame.seq === snapshot.frame.seq
            )
          ),
          snapshot
        ]
      })))
    ),
    stateAt: Effect.fn("TimeTravelStore.stateAt")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() => {
          let state: unknown = undefined
          for (const record of framed(runId, frame, "flows.engine.run-decision")) {
            const payload = record.payload as { readonly state?: unknown } | null
            if (payload !== null && payload !== undefined && payload.state !== undefined) state = payload.state
          }
          return state === undefined ? undefined : JSON.stringify(state)
        })
      ))
    ),
    attemptsAt: Effect.fn("TimeTravelStore.attemptsAt")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() => {
          const refs = new Map<string, TimeTravelStore.AttemptRef>()
          for (const record of framed(runId, frame, "flows.engine.attempt-started")) {
            const payload = record.payload as
              | { readonly stepKeyDigest?: unknown; readonly attempt?: unknown }
              | null
            if (typeof payload?.stepKeyDigest !== "string" || typeof payload.attempt !== "number") continue
            refs.set(`${payload.stepKeyDigest}:${payload.attempt}`, {
              stepKeyDigest: payload.stepKeyDigest,
              attempt: payload.attempt
            })
          }
          return [...refs.values()]
        })
      ))
    ),
    descendants: Effect.fn("TimeTravelStore.descendants")((runId, frame) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(Effect.andThen(
        Effect.sync(() => {
          const descendants = descendantsFrom(edges, runId, frame)
          return { attached: descendants.attached, detached: descendants.detached }
        })
      ))
    ),
    writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
      Effect.annotateCurrentSpan({
        auditId: audit.id,
        runId: audit.runId,
        lineageId: audit.frame.lineageId,
        seq: audit.frame.seq
      }).pipe(Effect.andThen(atomic(() => {
        fail("writeAudit")
        audits.push(audit)
      })))
    ),
    updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
      Effect.annotateCurrentSpan({ auditId: id }).pipe(Effect.andThen(atomic(() => {
        fail("updateAudit")
        const index = audits.findIndex((audit) => audit.id === id)
        if (index < 0) throw error("not_found", `audit ${id} was not found`)
        audits[index] = { ...audits[index]!, ...patch }
      })))
    ),
    pendingAudits: Effect.fn("TimeTravelStore.pendingAudits")(() =>
      Effect.sync(() => audits.filter((audit) => audit.status === "in_progress"))
    ),
    archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")((runId, frame, newReceipts) =>
      Effect.annotateCurrentSpan({ runId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
        Effect.andThen(atomic(() => {
          fail("archiveAndTruncate:start")
          const descendants = descendantsFrom(edges, runId, frame)
          const doomed = records.filter((record) =>
            (record.runId === runId && record.seq > frame.seq) ||
            descendants.attachedRunIds.has(record.runId)
          )
          fail("archiveAndTruncate:before-archive")
          archived.push(...doomed)
          fail("archiveAndTruncate:before-truncate")
          records = records.filter((record) =>
            !(
              (record.runId === runId && record.seq > frame.seq) ||
              descendants.attachedRunIds.has(record.runId)
            )
          )
          const attachedChildren = new Set(descendants.attached.map((edge) => edge.childRunId))
          edges = edges.filter((edge) => !attachedChildren.has(edge.childRunId))
          receipts.push(...newReceipts)
          fail("archiveAndTruncate:commit")
          return { archived: doomed.length, orphaned: descendants.detached }
        }))
      )
    ),
    archivedAt: Effect.fn("TimeTravelStore.archivedAt")((runId, seq) =>
      Effect.annotateCurrentSpan({ runId, seq }).pipe(Effect.andThen(
        Effect.sync(() => archived.some((record) => record.runId === runId && record.seq === seq))
      ))
    ),
    createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame) =>
      Effect.annotateCurrentSpan({ parentRunId, lineageId: frame.lineageId, seq: frame.seq }).pipe(
        Effect.andThen(atomic(() => {
          fail("createFork:start")
          let currentRunId: string | undefined = parentRunId
          const seen = new Set<string>()
          while (currentRunId !== undefined && !seen.has(currentRunId)) {
            seen.add(currentRunId)
            if (liveRuns.has(currentRunId)) {
              throw error("live_parent", `ancestor run ${currentRunId} is live`)
            }
            currentRunId = edges.find((edge) => edge.childRunId === currentRunId)?.parentRunId
          }
          const runId = `${parentRunId}:fork:${++sequence}`
          const prefix = records.filter((record) => record.runId === parentRunId && record.seq <= frame.seq)
          fail("createFork:copy")
          records.push(...prefix.map((record) => ({ ...record, runId, eventId: `fork:${runId}:${record.seq}` })))
          // The frame's anchors cross the fork with the prefix, mirroring the
          // SQL store: the child's history must be self-contained without a
          // later projection of its copied journal.
          snapshots = [
            ...snapshots,
            ...snapshots
              .filter((snapshot) => snapshot.runId === parentRunId && snapshot.frame.seq <= frame.seq)
              .map((snapshot) => ({ ...snapshot, runId }))
          ]
          const edge: LineageEdge = {
            parentRunId,
            parentSeq: frame.seq,
            childRunId: runId,
            kind: "fork",
            attached: false
          }
          edges.push(edge)
          fail("createFork:commit")
          return { runId, edge, warnings: [] }
        }))
      )
    ),
    recordReceipt: Effect.fn("TimeTravelStore.recordReceipt")((receipt) =>
      Effect.annotateCurrentSpan({
        receiptId: receipt.id,
        auditId: receipt.auditId,
        effectId: receipt.effectId
      }).pipe(Effect.andThen(atomic(() => {
        fail("recordReceipt")
        receipts.push(receipt)
      })))
    )
  })
  return Object.assign(service, { state })
}
/**
 * Provides a seeded memory store as the `TimeTravelStore` service. The
 * `state()` inspector is not reachable through the service key — use
 * {@link make} when a test needs it.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options: Options = {}): Layer.Layer<TimeTravelStore.TimeTravelStore> =>
  Layer.succeed(TimeTravelStore.TimeTravelStore)(make(options))
