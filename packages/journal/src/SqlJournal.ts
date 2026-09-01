/**
 * SQLite-backed logical journal with durable and lossy channels.
 *
 * Lossy telemetry events remain optimistic until the single scoped writer
 * commits them, so a process crash can lose accepted-but-unwritten telemetry.
 * Lifecycle events use `emitDurable` and return only after commit.
 *
 * Governing design: `docs/pages/concepts/journal.md`.
 * Prior-art decision: `docs/pages/concepts/sync.md`.
 *
 * The replay-then-follow stream follows Effect `EventJournal` and opencode
 * `packages/core/src/event.ts`. The bounded send queue deliberately deviates
 * from their synchronous durable writes by allocating the canonical per-run
 * sequence before admission. SQLite retry and transaction behavior comes
 * through `@smthrs/database`.
 *
 * @since 0.1.0
 */
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
import {
  Checkpoint,
  type CheckpointOptions,
  type Compacted,
  type CompactOptions,
  type DurableReceipt,
  type EmitReceipt,
  type EntriesPage,
  Journal,
  JournalError,
  make as makeJournal,
  type OverflowPolicy,
  type Service,
  type StreamOptions
} from "./Journal.ts"
import { Entry, Input, makeEventId, type RunId, type Seq, type SourceId, type SourceSeq } from "./JournalEvent.ts"
import * as JournalMetrics from "./JournalMetrics.ts"
import { OwnerId } from "./OwnerId.ts"
import type { Projection } from "./Projection.ts"
import * as Redaction from "./Redaction.ts"

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/**
 * Automatic checkpoint-and-compact policy for the SQL journal.
 *
 * Disabled unless set on {@link SqlJournalOptions}. Once a run's committed
 * entry count reaches `entryThreshold`, the journal asks `capture` for the
 * caller's replay state at the run's durable tail, writes it as a checkpoint
 * at that sequence, and compacts the entries strictly below it.
 *
 * Both lossy and durable commits run the same post-commit policy after their
 * allocation permit is free. `capture` may therefore read or emit through the
 * journal without blocking unrelated allocation. A capture is interrupted
 * after 30 seconds so caller code cannot wedge journal admission indefinitely.
 *
 * A failed or refused attempt (a live stream behind the boundary, a capture
 * failure) is logged at warning, damped for `entryThreshold`
 * further committed entries, and never surfaced to the emit that triggered
 * it.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompactionPolicy {
  readonly entryThreshold: number
  readonly capture: (runId: RunId, upTo: Seq) => Effect.Effect<unknown, unknown>
}

/**
 * SQL journal queue and batching options.
 *
 * @category models
 * @since 0.1.0
 */
export interface SqlJournalOptions {
  /**
   * Bound on the number of ENTRIES held in two places at once: the lossy
   * admission queue, where `overflow` decides what happens when it is full,
   * and the sliding `changes` buffer, where a slow subscriber silently loses
   * the entries that fall out of it.
   *
   * It bounds entries, not bytes. There is no payload byte cap, so a handful
   * of very large payloads can still be the memory bill.
   */
  readonly capacity: number
  /** Policy applied when the lossy admission queue is full. */
  readonly overflow: OverflowPolicy
  /** Entries the queued writer commits per transaction. */
  readonly batchSize?: number | undefined
  /**
   * Upper bound on the in-process source-event index, the map that answers
   * producer idempotency from memory.
   *
   * The index is a cache, never the authority. An explicit producer sequence
   * missed by the cache is checked against `flows_journal_events` before the
   * journal allocates or admits it, so a retry synchronously returns the
   * durable original or fails `idempotency_conflict`. Bounding the cache keeps
   * startup decode and resident memory O(bound) rather than O(total events ever
   * written), mirroring
   * Temporal's refusal to hold unbounded history in a shard
   * (`service/history`). The separate sequence-floor maps start empty and grow
   * only with runs and producers this layer instance touches; they are lazy,
   * not governed by this bound.
   *
   * Idempotency compares canonical persisted JSON after redaction. Two inputs
   * that redact to the same value are therefore the same event, and JSON's
   * encoding intentionally treats `NaN` and `null` as the same `null` value.
   */
  readonly sourceEventCache?: number | undefined
  /**
   * Scrub applied to every `payload` and `meta` before it is encoded for
   * persistence.
   *
   * Journal rows are permanent and are replayed verbatim to sync subscribers
   * and time-travel consumers, so a credential that reaches `payload_json` is
   * a durable, broadly readable leak. Redaction therefore defaults to
   * `Redaction.make()`; pass `Redaction.makeNoop()` to persist payloads
   * verbatim by choice.
   */
  readonly redact?: Redaction.Redactor | undefined
  /**
   * Automatic checkpoint-and-compact policy. Off by default: without it the
   * journal never deletes an entry, and checkpointing stays a caller-driven
   * `checkpoint` / `compact` call.
   */
  readonly compaction?: CompactionPolicy | undefined
}

/** Default retained window of the source-event index. */
const defaultSourceEventCache = 4096

/** Bounds caller-supplied compaction capture work before the attempt is damped. */
const compactionCaptureTimeout = "30 seconds"

interface QueuedEntry {
  readonly runId: RunId
  readonly seq: Seq
  readonly eventId: string
  readonly sourceId: SourceId
  readonly sourceSeq: SourceSeq
  readonly emittedAtMs: number
  readonly eventType: string
  readonly payloadJson: string
  readonly metaJson: string
}

interface JournalRow {
  readonly run_id: string
  readonly seq: number
  readonly event_id: string
  readonly source_id: string
  readonly source_seq: number
  readonly emitted_at_ms: number
  readonly event_type: string
  readonly payload_json: string
  readonly meta_json: string
}

interface CheckpointRow {
  readonly run_id: string
  readonly seq: number
  readonly state_json: string
  readonly created_at_ms: number
  readonly compacted_at_ms: number | null
}

interface Prepared {
  readonly validated: Input
  readonly payloadJson: string
  readonly metaJson: string
}

interface Commit {
  readonly entry: Entry
  readonly inserted: boolean
}

interface SettledCommit {
  readonly queued: QueuedEntry
  readonly commit: Commit
}

interface EntryLoss {
  readonly queued: QueuedEntry
  readonly cause: JournalError
}

interface BatchOutcome {
  readonly commits: ReadonlyArray<SettledCommit>
  readonly losses: ReadonlyArray<EntryLoss>
}

interface RunBarrier {
  /**
   * Serializes one run's admission decisions against the moment a compaction
   * closes the run, so "read the gate, then admit" is one critical section.
   */
  readonly semaphore: Semaphore.Semaphore
  /**
   * Serializes compactions of one run. Held for the whole barrier, including
   * the drain, so `compaction` is only ever set and cleared by its holder and
   * a second compactor never observes a half-open barrier.
   */
  readonly compactionLock: Semaphore.Semaphore
  /** Open while a compaction owns the run; every admission awaits it. */
  compaction: Deferred.Deferred<void> | undefined
}

type RunAdmission<A> =
  | { readonly _tag: "Done"; readonly value: A }
  | { readonly _tag: "Wait"; readonly gate: Deferred.Deferred<void> }

interface SourceEvent {
  readonly seq: Seq
  readonly eventType: string
  readonly payloadJson: string
  readonly metaJson: string
  readonly status: "pending" | "committed"
}

type Status = "open" | "closing" | "closed"

interface State {
  status: Status
  /**
   * The most recent batch the optimistic writer lost. It is a *report*, not a
   * latch: the writer survives a failed batch, so a transient outage must not
   * revoke the lossy channel, and with it the durable delivery paths that call
   * `flush`, for the rest of the process's life.
   *
   * Each loss is reported to whoever was waiting on it (`flushWaiters`, live
   * streams) and, via `lossEpoch`, to at most one later `flush` and to every
   * live stream that had not yet observed it. After that the report is spent
   * and the journal is usable again the moment the database is.
   */
  sinkFailure: JournalError | undefined
  /** Incremented on every lost batch; identifies an unreported loss. */
  lossEpoch: number
  /** The highest `lossEpoch` already reported to a `flush` caller. */
  flushedLossEpoch: number
  pending: number
  readonly pendingByRun: Map<RunId, number>
  readonly sequences: Map<RunId, number>
  readonly sourceSequences: Map<string, number>
  readonly sourceEvents: Map<string, SourceEvent>
  readonly flushWaiters: Set<Deferred.Deferred<void, JournalError>>
}

const error = (code: JournalError["code"], message: string, cause?: unknown): JournalError =>
  new JournalError({
    code,
    message,
    ...(cause === undefined ? {} : { cause })
  })

/**
 * Post-commit settlements accumulated while a `transact` transaction is open.
 *
 * `emitDurable` publishes an entry and records it in the in-process
 * source-event index only once the entry is really committed. Inside a
 * transaction the innermost `writer.write` merely releases a savepoint, so
 * those two effects are parked here as thunks and replayed by the outermost
 * `transact` after COMMIT. The parked value is a closure, so several journal
 * instances sharing one transaction each settle their own PubSub and index.
 *
 * This is fiber-scoped context, not module state: two fibers in two
 * transactions never see each other's list.
 */
class Settlements extends Context.Service<Settlements, Array<Effect.Effect<void>>>()(
  "@smthrs/journal/SqlJournal/Settlements"
) {}

const sourceKey = (runId: RunId, sourceId: SourceId): string => `${runId.length}:${runId}${sourceId.length}:${sourceId}`

const sourceEventKey = (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq): string =>
  `${sourceKey(runId, sourceId)}:${sourceSeq}`

/**
 * Sorts the plain JSON tree used as an idempotency fingerprint.
 *
 * `@smthrs/canonical` is the repository's general-purpose implementation, but
 * journal cannot add that dependency while this release's lockfiles are frozen.
 */
const canonicalizeFingerprint = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeFingerprint)
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalizeFingerprint(record[key])])
  )
}

const encodeJson = (value: unknown, field: string): Result.Result<string, JournalError> =>
  Schema.encodeUnknownResult(UnknownFromJsonString)(value).pipe(
    Result.mapError((cause) => error("invalid_event", `${field} must be JSON-serializable`, cause))
  )

const encodeFingerprint = (value: unknown, field: string): Result.Result<string, JournalError> =>
  encodeJson(canonicalizeFingerprint(value), field)

/**
 * Whether one write is fenced on a run's persisted ownership.
 *
 * The journal used to pass `OwnerId | undefined` and fence only when the value
 * happened to be present, so an untyped caller that omitted the argument
 * silently selected the unfenced path on three public methods. The tag makes
 * the choice explicit: only `emitDurableUnfenced` and the internal
 * auto-compaction path construct `unfenced`, and they say so at the call site.
 */
type Fence =
  | { readonly _tag: "Owned"; readonly owner: OwnerId }
  | { readonly _tag: "Unfenced" }

/** The one unfenced write posture, named so a call site cannot mean it by accident. */
const unfenced: Fence = { _tag: "Unfenced" }

const decodeOwner = Schema.decodeUnknownResult(OwnerId)

/**
 * Decodes the mandatory owner of a fenced method.
 *
 * A missing, null, or malformed owner is a caller contract violation, not a
 * lost race: reporting it as `fence_lost` would tell the caller another
 * process owns the run and send it looking for a conflict that never
 * happened.
 */
const requireFence = (owner: unknown, method: string): Result.Result<Fence, JournalError> =>
  Result.match(decodeOwner(owner), {
    onFailure: (cause) => Result.fail(error("invalid_event", `${method} requires a well-formed owner fence`, cause)),
    onSuccess: (value) => Result.succeed<Fence>({ _tag: "Owned", owner: value })
  })

const decodeInput = Schema.decodeUnknownResult(Input)
const decodeEntry = Schema.decodeUnknownEffect(Entry)

const decodeRow = (row: JournalRow): Effect.Effect<Entry, JournalError> =>
  Effect.all({
    payload: Schema.decodeUnknownEffect(UnknownFromJsonString)(row.payload_json),
    meta: Schema.decodeUnknownEffect(UnknownFromJsonString)(row.meta_json)
  }).pipe(
    Effect.map(({ meta, payload }) => ({
      runId: row.run_id as RunId,
      seq: Number(row.seq),
      eventId: row.event_id,
      sourceId: row.source_id,
      sourceSeq: Number(row.source_seq),
      emittedAtMs: Number(row.emitted_at_ms),
      eventType: row.event_type,
      payload,
      meta
    })),
    Effect.flatMap(decodeEntry),
    Effect.mapError((cause) => error("decode_failed", "could not decode a durable journal row", cause))
  )

const decodeCheckpoint = Schema.decodeUnknownEffect(Checkpoint)

const decodeCheckpointRow = (row: CheckpointRow): Effect.Effect<Checkpoint, JournalError> =>
  Schema.decodeUnknownEffect(UnknownFromJsonString)(row.state_json).pipe(
    Effect.flatMap((state) =>
      decodeCheckpoint({
        runId: row.run_id,
        seq: Number(row.seq),
        state,
        createdAtMs: Number(row.created_at_ms),
        compactedAtMs: row.compacted_at_ms === null ? null : Number(row.compacted_at_ms)
      })
    ),
    Effect.mapError((cause) => error("decode_failed", "could not decode a durable checkpoint row", cause))
  )

/** Freezes the one object graph shared by every changes subscriber. */
const freezePublished = <A>(value: A): A => {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return
    /* v8 ignore next -- decoded JSON and Entry instances are acyclic, but this guard keeps the walk total */
    if (seen.has(node)) return
    seen.add(node)
    for (const key of Reflect.ownKeys(node)) {
      walk((node as Record<PropertyKey, unknown>)[key])
    }
    Object.freeze(node)
  }
  walk(value)
  return value
}

interface ValidatedOptions {
  readonly batchSize: number
  readonly sourceEventCache: number
  readonly redact: Redaction.Redactor
}

const validateOptions = (options: SqlJournalOptions): Effect.Effect<ValidatedOptions, JournalError> =>
  Effect.suspend(() => {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      return Effect.fail(error("invalid_event", "capacity must be a positive safe integer"))
    }
    const batchSize = options.batchSize ?? Math.min(options.capacity, 64)
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      return Effect.fail(error("invalid_event", "batchSize must be a positive safe integer"))
    }
    const sourceEventCache = options.sourceEventCache ?? defaultSourceEventCache
    if (!Number.isSafeInteger(sourceEventCache) || sourceEventCache <= 0) {
      return Effect.fail(error("invalid_event", "sourceEventCache must be a positive safe integer"))
    }
    if (
      options.compaction !== undefined &&
      (!Number.isSafeInteger(options.compaction.entryThreshold) || options.compaction.entryThreshold <= 0)
    ) {
      return Effect.fail(error("invalid_event", "compaction.entryThreshold must be a positive safe integer"))
    }
    return Effect.succeed({ batchSize, sourceEventCache, redact: options.redact ?? Redaction.make() })
  })

const isJournalError = Schema.is(JournalError)

/**
 * Provides the SQLite-backed journal.
 *
 * `emitLossy` validates and admits telemetry to the non-blocking queue;
 * `emitDurable` allocates and commits inside the database transaction.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: SqlJournalOptions
): Layer.Layer<Journal, JournalError, DurableWriter | SqlClient.SqlClient> =>
  Layer.effect(
    Journal,
    Effect.gen(function*() {
      const { batchSize, redact, sourceEventCache } = yield* validateOptions(options)
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const writer = yield* DurableWriter

      const queue = yield* Queue.dropping<QueuedEntry>(options.capacity)
      const changes = yield* PubSub.sliding<Entry>(options.capacity)
      const wakes = new Map<RunId, Set<PubSub.PubSub<void>>>()
      /**
       * The durable cursor of every live in-process stream, per run: the
       * highest committed sequence the stream has read from the store, or its
       * starting `afterSequence`. `compact` refuses to truncate below a
       * registered cursor, so a live follower's next durable page is never
       * deleted out from under it. Readers this process cannot see, pagers
       * of `entries`, followers in other processes, are covered by the
       * read-side `compacted` guard instead.
       */
      const readers = new Map<RunId, Set<{ cursor: number }>>()
      /**
       * Only the most recent `sourceEventCache` events are decoded at startup.
       * Older events stay durable-only: their idempotency is enforced by the
       * writer's `(run_id, source_id, source_seq)` re-check, so the process
       * never has to hold the whole history to stay correct.
       */
      const sourceEventRows = yield* sql<JournalRow>`
        SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
          event_type, payload_json, meta_json
        FROM flows_journal_events
        ORDER BY emitted_at_ms DESC, run_id DESC, seq DESC
        LIMIT ${sourceEventCache}
      `.pipe(
        Effect.mapError((cause) => error("sink_failed", "could not initialize journal source events", cause))
      )
      const durableEntries = yield* Effect.forEach(sourceEventRows, decodeRow)
      const initialized = yield* Effect.fromResult(
        Result.gen(function*() {
          // The two allocation floors start EMPTY and are filled one run at a
          // time by `ensureFloors`. They used to be seeded by two unbounded
          // `GROUP BY` aggregations, one entry per run that ever wrote an
          // event, one per `(run_id, source_id)` pair, so layer construction
          // scanned the whole table and built a map proportional to total
          // history, which is exactly what the bound below exists to avoid.
          const sequences = new Map<RunId, number>()
          const sourceSequences = new Map<string, number>()
          const sourceEvents = new Map<string, SourceEvent>()
          // Seeded oldest-first so the map's insertion order stays the
          // eviction order once `retain` starts adding newer events.
          for (const entry of [...durableEntries].reverse()) {
            if (
              !Number.isSafeInteger(entry.seq) ||
              !Number.isSafeInteger(entry.sourceSeq) ||
              entry.seq === Number.MAX_SAFE_INTEGER ||
              entry.sourceSeq === Number.MAX_SAFE_INTEGER
            ) {
              return yield* Result.fail(
                error("decode_failed", "durable event sequence is outside the allocatable safe integer range")
              )
            }
            sourceEvents.set(sourceEventKey(entry.runId, entry.sourceId, entry.sourceSeq), {
              seq: entry.seq,
              eventType: entry.eventType,
              payloadJson: yield* encodeFingerprint(entry.payload, "payload"),
              metaJson: yield* encodeFingerprint(entry.meta, "meta"),
              status: "committed"
            })
          }
          return {
            sequences,
            sourceSequences,
            sourceEvents
          }
        })
      )
      const state: State = {
        status: "open",
        sinkFailure: undefined,
        lossEpoch: 0,
        flushedLossEpoch: 0,
        pending: 0,
        pendingByRun: new Map(),
        sequences: initialized.sequences,
        sourceSequences: initialized.sourceSequences,
        sourceEvents: initialized.sourceEvents,
        flushWaiters: new Set()
      }
      // The permit protects only synchronous in-memory reservation. It must
      // never be held while waiting on SQLite: an enclosing `transact` owns a
      // database transaction, so DB -> allocator and allocator -> DB ordering
      // would otherwise deadlock concurrent lifecycle writers.
      const allocation = yield* Semaphore.make(1)
      const runBarriers = new Map<RunId, RunBarrier>()
      const runDrainWaiters = new Map<RunId, Set<Deferred.Deferred<void>>>()
      const activeWritesByRun = new Map<RunId, number>()

      const barrierFor = (runId: RunId): RunBarrier => {
        const existing = runBarriers.get(runId)
        if (existing !== undefined) return existing
        const created: RunBarrier = {
          semaphore: Semaphore.makeUnsafe(1),
          compactionLock: Semaphore.makeUnsafe(1),
          compaction: undefined
        }
        runBarriers.set(runId, created)
        return created
      }

      /** Blocks new admissions while a compaction owns the run. */
      const withRunAdmission = <A, E, R>(
        runId: RunId,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> =>
        Effect.suspend(() => {
          const barrier = barrierFor(runId)
          return barrier.semaphore.withPermit(
            Effect.suspend((): Effect.Effect<RunAdmission<A>, E, R> => {
              const gate = barrier.compaction
              return gate === undefined
                ? Effect.map(effect, (value): RunAdmission<A> => ({ _tag: "Done", value }))
                : Effect.succeed<RunAdmission<A>>({ _tag: "Wait", gate })
            })
          ).pipe(
            Effect.flatMap((attempt): Effect.Effect<A, E, R> =>
              attempt._tag === "Done"
                ? Effect.succeed(attempt.value)
                : Deferred.await(attempt.gate).pipe(
                  Effect.andThen(withRunAdmission(runId, effect))
                )
            )
          )
        })

      /** Acquires batch run permits in stable order so mixed-run batches cannot deadlock. */
      const withRunPermits = <A, E, R>(
        runIds: ReadonlyArray<RunId>,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> => {
        const ordered = [...new Set(runIds)].sort()
        const acquire = (index: number): Effect.Effect<A, E, R> =>
          index === ordered.length
            ? effect
            : barrierFor(ordered[index]!).semaphore.withPermit(acquire(index + 1))
        return acquire(0)
      }

      const admitRunPending = (queued: QueuedEntry): void => {
        state.pendingByRun.set(queued.runId, (state.pendingByRun.get(queued.runId) ?? 0) + 1)
      }

      const completeRunDrain = (runId: RunId): void => {
        if ((state.pendingByRun.get(runId) ?? 0) + (activeWritesByRun.get(runId) ?? 0) > 0) return
        const waiters = runDrainWaiters.get(runId)
        runDrainWaiters.delete(runId)
        for (const waiter of waiters ?? []) {
          Deferred.doneUnsafe(waiter, Effect.void)
        }
      }

      const settleRunPending = (batch: ReadonlyArray<QueuedEntry>): void => {
        for (const queued of batch) {
          // Every batched entry was counted by `admitRunPending` when it was
          // admitted, so the run always has a count to settle here.
          const remaining = state.pendingByRun.get(queued.runId)! - 1
          if (remaining > 0) {
            state.pendingByRun.set(queued.runId, remaining)
            continue
          }
          state.pendingByRun.delete(queued.runId)
          completeRunDrain(queued.runId)
        }
      }

      const endRunWrite = (runId: RunId): void => {
        // `withActiveRunWrite` counted this write in before running it, and
        // releases through here exactly once.
        const remaining = activeWritesByRun.get(runId)! - 1
        if (remaining > 0) {
          activeWritesByRun.set(runId, remaining)
          return
        }
        activeWritesByRun.delete(runId)
        completeRunDrain(runId)
      }

      /** Claims a durable write without yielding between the compaction check and the count. */
      const withActiveRunWrite = <A, E, R>(
        runId: RunId,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> =>
        Effect.suspend(() => {
          const gate = barrierFor(runId).compaction
          if (gate !== undefined) {
            return Deferred.await(gate).pipe(
              Effect.andThen(withActiveRunWrite(runId, effect))
            )
          }
          activeWritesByRun.set(runId, (activeWritesByRun.get(runId) ?? 0) + 1)
          return effect.pipe(Effect.ensuring(Effect.sync(() => endRunWrite(runId))))
        })

      const awaitRunDrained = (runId: RunId): Effect.Effect<void> =>
        Effect.suspend(() => {
          if ((state.pendingByRun.get(runId) ?? 0) + (activeWritesByRun.get(runId) ?? 0) === 0) {
            return Effect.void
          }
          const waiter = Deferred.makeUnsafe<void>()
          const waiters = runDrainWaiters.get(runId) ?? new Set()
          waiters.add(waiter)
          runDrainWaiters.set(runId, waiters)
          // No cleanup on the way out: `completeRunDrain` deletes the whole
          // set as it completes it, and an interrupted waiter is a Deferred
          // nobody awaits that the next drain of this run discards. Deleting
          // it here would only add an unreachable branch.
          return Deferred.await(waiter)
        })

      /**
       * Stops admissions, drains accepted work, then runs one compaction
       * transaction.
       *
       * `compactionLock` is held across the whole barrier, so the run's gate
       * is only ever set and cleared by its holder: a second compactor waits
       * for the lock instead of finding a half-open barrier. The admission
       * semaphore is taken twice and released in between, because the drain
       * this waits for needs it: holding it across the drain would deadlock
       * the compaction against the writer it is waiting for.
       */
      const withCompactionBarrier = <A, E, R>(
        runId: RunId,
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E, R> =>
        Effect.suspend(() => {
          const barrier = barrierFor(runId)
          return barrier.compactionLock.withPermit(
            Effect.uninterruptibleMask((restore) => {
              const gate = Deferred.makeUnsafe<void>()
              return barrier.semaphore.withPermit(
                Effect.sync(() => {
                  barrier.compaction = gate
                })
              ).pipe(
                Effect.andThen(restore(
                  awaitRunDrained(runId).pipe(
                    Effect.andThen(barrier.semaphore.withPermit(effect))
                  )
                )),
                Effect.ensuring(Effect.sync(() => {
                  barrier.compaction = undefined
                  Deferred.doneUnsafe(gate, Effect.void)
                }))
              )
            })
          )
        })

      /**
       * Raises the in-process seq allocation floor for a run.
       *
       * Both emit paths call this at the moment they allocate, so the floor
       * never names a seq some writer has already taken. It used to move only
       * in `rememberCommitted`, which `settleCommit` parks until the outermost
       * COMMIT, so a durable emit inside an open `transact` left the floor
       * behind, `emitLossy` allocated the same seq from it, and the lossy
       * INSERT hit `PRIMARY KEY (run_id, seq)`.
       *
       * The floor only ever rises. `insertOne` can settle on a raced duplicate
       * whose row was written by another process at a higher seq, and that
       * still has to raise the floor here.
       */
      const raiseSequenceFloor = (runId: RunId, seq: number): void => {
        state.sequences.set(runId, Math.max(state.sequences.get(runId) ?? 0, seq + 1))
      }

      /** Raises the in-process producer-sequence allocation floor. */
      const raiseSourceSequenceFloor = (runId: RunId, sourceId: SourceId, sourceSeq: number): void => {
        const key = sourceKey(runId, sourceId)
        state.sourceSequences.set(key, Math.max(state.sourceSequences.get(key) ?? 0, sourceSeq + 1))
      }

      /**
       * Adds an entry to the bounded source-event index, evicting the
       * least-recently added *committed* entry when the bound is exceeded.
       *
       * Uncommitted entries are never evicted: they are not in the database
       * yet, so memory is the only place their identity exists. Committed ones
       * are always re-derivable from `flows_journal_events`, which is what
       * makes the bound safe.
       */
      const retain = (identity: string, event: SourceEvent): void => {
        state.sourceEvents.delete(identity)
        state.sourceEvents.set(identity, event)
        if (state.sourceEvents.size <= sourceEventCache) return
        for (const [candidate, retained] of state.sourceEvents) {
          if (retained.status !== "committed" || candidate === identity) continue
          state.sourceEvents.delete(candidate)
          return
        }
      }

      const completeFlushWaiters = (exit: Effect.Effect<void, JournalError>): void => {
        const waiters = Array.from(state.flushWaiters)
        state.flushWaiters.clear()
        for (const waiter of waiters) {
          Deferred.doneUnsafe(waiter, exit)
        }
      }

      const flushInternal: Effect.Effect<void, JournalError> = Effect.suspend(() => {
        // A loss that happened while nothing was registered still has to reach
        // a caller, so the first flush after it reports it, once. A later
        // flush has nothing to do with the lost batch and must succeed, or a
        // single transient outage would stall every durable delivery that
        // flushes (`DeferredPersistence.completeDeferred`, `recordClockScheduled`)
        // for the process's lifetime.
        if (state.sinkFailure !== undefined && state.lossEpoch > state.flushedLossEpoch) {
          state.flushedLossEpoch = state.lossEpoch
          return Effect.fail(state.sinkFailure)
        }
        if (state.status === "closed") {
          return Effect.fail(error("journal_closed", "journal is closed"))
        }
        if (state.pending === 0) {
          return Effect.void
        }
        const waiter = Deferred.makeUnsafe<void, JournalError>()
        state.flushWaiters.add(waiter)
        return Deferred.await(waiter).pipe(
          Effect.ensuring(Effect.sync(() => {
            state.flushWaiters.delete(waiter)
          }))
        )
      })

      const prepare = (input: Input, emittedAtMs: number): Result.Result<Prepared, JournalError> =>
        Result.gen(function*() {
          if (state.status !== "open") {
            return yield* Result.fail(error("journal_closed", "journal is closed"))
          }
          // `RunId`, `SourceId`, and `Input.eventType` carry the non-empty and
          // well-formed-UTF-16 checks themselves, so decode is the whole
          // identifier contract. The service used to re-check emptiness here,
          // which let a caller hold an identifier that decoded and then failed
          // at the write.
          const validated = yield* Result.mapError(
            decodeInput(input),
            (cause) => error("invalid_event", "event violates the journal input contract", cause)
          )
          if (!Number.isSafeInteger(emittedAtMs) || emittedAtMs < 0) {
            return yield* Result.fail(
              error("invalid_event", "emittedAtMs must be a non-negative safe integer")
            )
          }
          // Redaction happens here, at the single point every channel funnels
          // through, so no write path can bypass it (issue #46).
          const redactedPayload = yield* Result.try({
            try: () => redact(validated.payload),
            catch: (cause) => error("invalid_event", "payload could not be redacted", cause)
          })
          const redactedMeta = yield* Result.try({
            try: () => redact(validated.meta ?? null),
            catch: (cause) => error("invalid_event", "meta could not be redacted", cause)
          })
          return {
            validated,
            payloadJson: yield* encodeFingerprint(redactedPayload, "payload"),
            metaJson: yield* encodeFingerprint(redactedMeta, "meta")
          }
        })

      const compareSourceEvent = (
        prepared: Prepared,
        sourceSeq: SourceSeq,
        existing: SourceEvent
      ): Result.Result<EmitReceipt, JournalError> => {
        const { metaJson, payloadJson, validated } = prepared
        if (
          existing.eventType !== validated.eventType ||
          existing.payloadJson !== payloadJson ||
          existing.metaJson !== metaJson
        ) {
          return Result.fail(error(
            "idempotency_conflict",
            `source event ${validated.sourceId}:${sourceSeq} for run ${validated.runId} was reused with different content`
          ))
        }
        return Result.succeed({
          _tag: "Duplicate",
          seq: existing.seq,
          sourceSeq,
          status: existing.status
        })
      }

      /** Resolves an explicit producer retry before sequence allocation. */
      const preflightExplicit = (prepared: Prepared): Effect.Effect<EmitReceipt | undefined, JournalError> =>
        Effect.suspend(() => {
          const { validated } = prepared
          const sourceSeq = validated.sourceSeq
          if (sourceSeq === undefined) return Effect.succeed(undefined)
          if (
            !Number.isSafeInteger(sourceSeq) ||
            sourceSeq < 0 ||
            sourceSeq === Number.MAX_SAFE_INTEGER
          ) {
            return Effect.fail(
              error("invalid_event", "journal sequence is outside the allocatable safe integer range")
            )
          }
          const identity = sourceEventKey(validated.runId, validated.sourceId, sourceSeq)
          const cached = state.sourceEvents.get(identity)
          if (cached !== undefined) {
            return Effect.fromResult(compareSourceEvent(prepared, sourceSeq, cached))
          }
          return sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE event_id = ${makeEventId(validated.runId, validated.sourceId, sourceSeq)}
              OR (
                run_id = ${validated.runId}
                AND source_id = ${validated.sourceId}
                AND source_seq = ${sourceSeq}
              )
            ORDER BY seq ASC
            LIMIT 1
          `.pipe(
            Effect.mapError((cause) => error("sink_failed", "could not read durable source event", cause)),
            Effect.flatMap((rows) => {
              const row = rows[0]
              if (row === undefined) return Effect.succeed(undefined)
              const existing: SourceEvent = {
                seq: Number(row.seq) as Seq,
                eventType: row.event_type,
                payloadJson: row.payload_json,
                metaJson: row.meta_json,
                status: "committed"
              }
              return Effect.fromResult(compareSourceEvent(prepared, sourceSeq, existing)).pipe(
                Effect.tap(() => Effect.sync(() => retain(identity, existing)))
              )
            })
          )
        })

      const queuedEmit: Service["emitLossy"] = Effect.fn("Journal.emitLossy")((input: Input) =>
        Effect.annotateCurrentSpan({
          runId: input.runId,
          sourceId: input.sourceId,
          eventType: input.eventType
        }).pipe(Effect.andThen(
          withRunAdmission(
            input.runId,
            Effect.flatMap(Clock.currentTimeMillis, (emittedAtMs) =>
              Effect.flatMap(
                Effect.suspend(() => Effect.fromResult(prepare(input, emittedAtMs))),
                (prepared) =>
                  Effect.flatMap(
                    preflightExplicit(prepared),
                    (preflight) =>
                      preflight !== undefined
                        ? Effect.succeed(preflight)
                        : Effect.flatMap(
                          ensureFloors(prepared.validated.runId, prepared.validated.sourceId),
                          (floors) =>
                            allocation.withPermit(Effect.fromResult(
                              Result.gen(function*() {
                                const { metaJson, payloadJson, validated } = prepared
                                const key = sourceKey(validated.runId, validated.sourceId)
                                const nextSourceSeq = Math.max(
                                  floors.sourceSeq,
                                  state.sourceSequences.get(key) ?? 0
                                )
                                if (validated.sourceSeq !== undefined) {
                                  const identity = sourceEventKey(
                                    validated.runId,
                                    validated.sourceId,
                                    validated.sourceSeq
                                  )
                                  const cached = state.sourceEvents.get(identity)
                                  if (cached !== undefined) {
                                    return yield* compareSourceEvent(prepared, validated.sourceSeq, cached)
                                  }
                                }
                                // An explicit producer sequence was validated and
                                // answered by `preflightExplicit`, and an implicit one
                                // is the floor `ensureFloors` already proved to be a
                                // non-negative safe integer. Only exhaustion is left:
                                // the allocator cannot advance past MAX_SAFE_INTEGER,
                                // and neither can the identity that follows it.
                                const sourceSeq: SourceSeq = validated.sourceSeq ?? (nextSourceSeq as SourceSeq)
                                if (sourceSeq === Number.MAX_SAFE_INTEGER) {
                                  return yield* Result.fail(
                                    error(
                                      "invalid_event",
                                      "journal sequence is outside the allocatable safe integer range"
                                    )
                                  )
                                }
                                const nextSeq = Math.max(
                                  floors.seq,
                                  state.sequences.get(validated.runId) ?? 0
                                )
                                if (nextSeq === Number.MAX_SAFE_INTEGER) {
                                  return yield* Result.fail(
                                    error(
                                      "invalid_event",
                                      "journal sequence is outside the allocatable safe integer range"
                                    )
                                  )
                                }
                                const seq = nextSeq as Seq
                                raiseSequenceFloor(validated.runId, seq)
                                state.sourceSequences.set(key, Math.max(nextSourceSeq, sourceSeq + 1))

                                const queued: QueuedEntry = {
                                  runId: validated.runId,
                                  seq,
                                  eventId: makeEventId(validated.runId, validated.sourceId, sourceSeq),
                                  sourceId: validated.sourceId,
                                  sourceSeq,
                                  emittedAtMs,
                                  eventType: validated.eventType,
                                  payloadJson,
                                  metaJson
                                }
                                let evicted: QueuedEntry | undefined
                                if (Queue.sizeUnsafe(queue) >= options.capacity && options.overflow === "drop-oldest") {
                                  const exit = Queue.takeUnsafe(queue)
                                  /* v8 ignore next -- size and take run synchronously while the journal and queue are open */
                                  if (exit === undefined || !Exit.isSuccess(exit)) {
                                    return yield* Result.fail(
                                      error("journal_closed", "journal admission queue is unavailable")
                                    )
                                  }
                                  evicted = exit.value
                                  const evictedIdentity = sourceEventKey(
                                    evicted.runId,
                                    evicted.sourceId,
                                    evicted.sourceSeq
                                  )
                                  state.sourceEvents.delete(evictedIdentity)
                                  state.pending = Math.max(0, state.pending - 1)
                                  settleRunPending([evicted])
                                }
                                const accepted = Queue.offerUnsafe(queue, queued)
                                if (!accepted) {
                                  if (options.overflow === "reject") {
                                    return yield* Result.fail(
                                      error("queue_overflow", "journal admission queue is full")
                                    )
                                  }
                                  return {
                                    _tag: "Dropped",
                                    seq,
                                    sourceSeq,
                                    policy: "drop-newest"
                                  } satisfies EmitReceipt
                                }

                                retain(sourceEventKey(validated.runId, validated.sourceId, sourceSeq), {
                                  seq,
                                  eventType: validated.eventType,
                                  payloadJson,
                                  metaJson,
                                  status: "pending"
                                })
                                state.pending += 1
                                admitRunPending(queued)
                                if (evicted !== undefined) {
                                  return {
                                    _tag: "Accepted",
                                    seq,
                                    sourceSeq,
                                    evicted: {
                                      policy: "drop-oldest",
                                      count: 1
                                    }
                                  } satisfies EmitReceipt
                                }
                                return {
                                  _tag: "Accepted",
                                  seq,
                                  sourceSeq
                                } satisfies EmitReceipt
                              })
                            ))
                        )
                  )
              )).pipe(Effect.tap((receipt) => Metric.update(JournalMetrics.lossy[receipt._tag], 1)))
          )
        ))
      )

      /**
       * The run's compaction floor: the largest checkpoint sequence whose
       * lower entries have been truncated, or `undefined` while the run has
       * never been compacted.
       */
      const compactionFloor = (runId: RunId): Effect.Effect<number | undefined, SqlError.SqlError> =>
        Effect.map(
          sql<{ readonly floor: number | null }>`
            SELECT MAX(seq) AS floor FROM flows_journal_checkpoints
            WHERE run_id = ${runId} AND compacted_at_ms IS NOT NULL
          `,
          (rows) => {
            const floor = rows[0]?.floor
            return floor === null || floor === undefined ? undefined : Number(floor)
          }
        )

      const readPage: Service["entries"] = Effect.fn("Journal.entries")((pageOptions) =>
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: pageOptions.runId,
            limit: pageOptions.limit,
            ...(pageOptions.after === undefined ? {} : { after: pageOptions.after })
          })
          if (pageOptions.runId.length === 0) {
            return yield* Effect.fail(error("invalid_event", "runId must not be empty"))
          }
          if (!Number.isSafeInteger(pageOptions.limit) || pageOptions.limit <= 0) {
            return yield* Effect.fail(error("invalid_event", "limit must be a positive safe integer"))
          }
          const after = pageOptions.after ?? -1
          if (!Number.isSafeInteger(after) || after < -1) {
            return yield* Effect.fail(error("invalid_event", "after must be a canonical sequence or undefined"))
          }
          const rows = yield* sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE run_id = ${pageOptions.runId} AND seq > ${after}
            ORDER BY seq ASC
            LIMIT ${pageOptions.limit + 1}
          `.pipe(
            Effect.mapError((cause) => error("read_failed", "durable journal read failed", cause))
          )
          // The floor is read AFTER the page. Truncation and the floor
          // advance commit atomically, so any deletion that could have
          // shortened the page above is visible in this floor read, and a
          // cursor at or above `floor - 1` therefore read a complete page.
          // The converse order would let a compaction commit between the two
          // reads and hand back a silently gapped history.
          const floor = yield* compactionFloor(pageOptions.runId).pipe(
            Effect.mapError((cause) => error("read_failed", "durable journal read failed", cause))
          )
          if (floor !== undefined && after < floor - 1) {
            return yield* Effect.fail(
              new JournalError({
                code: "compacted",
                message: `run ${pageOptions.runId} is compacted through sequence ${floor}; resync from its checkpoint`,
                checkpointSeq: floor as Seq
              })
            )
          }
          const page = rows.slice(0, pageOptions.limit)
          const entries = yield* Effect.forEach(page, decodeRow)
          return {
            entries,
            hasMore: rows.length > pageOptions.limit
          } satisfies EntriesPage
        })
      )

      const subscribeRun = (runId: RunId) =>
        Effect.gen(function*() {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const subscribers = wakes.get(runId) ?? new Set()
              subscribers.add(wake)
              wakes.set(runId, subscribers)
            }),
            () =>
              Effect.sync(() => {
                const subscribers = wakes.get(runId)
                subscribers?.delete(wake)
                if (subscribers?.size === 0) {
                  wakes.delete(runId)
                }
              }).pipe(Effect.andThen(PubSub.shutdown(wake)))
          )
          return subscription
        })

      const stream = (streamOptions: StreamOptions): Stream.Stream<Entry, JournalError> =>
        Stream.unwrap(
          Effect.fn("Journal.stream")(function*() {
            yield* Effect.annotateCurrentSpan({
              runId: streamOptions.runId,
              ...(streamOptions.afterSequence === undefined ? {} : { afterSequence: streamOptions.afterSequence })
            })
            const wake = yield* subscribeRun(streamOptions.runId)
            // The cursor lives in a registered box for the stream's lifetime
            // so `compact` can see how far every live follower has read.
            const reader = { cursor: streamOptions.afterSequence ?? -1 }
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const registered = readers.get(streamOptions.runId) ?? new Set()
                registered.add(reader)
                readers.set(streamOptions.runId, registered)
              }),
              () =>
                Effect.sync(() => {
                  const registered = readers.get(streamOptions.runId)
                  registered?.delete(reader)
                  if (registered?.size === 0) {
                    readers.delete(streamOptions.runId)
                  }
                })
            )
            // A live consumer is told about losses that happen while it is
            // following, and only about those: a loss it never overlapped is
            // already spent by the time it subscribes.
            const subscribedLossEpoch = state.lossEpoch
            const readPages = (initialCursor: number): Stream.Stream<Entry, JournalError> =>
              Stream.paginate(initialCursor, (cursor) =>
                Effect.suspend(() =>
                  state.sinkFailure !== undefined && state.lossEpoch > subscribedLossEpoch
                    ? Effect.fail(state.sinkFailure)
                    : readPage({
                      runId: streamOptions.runId,
                      ...(cursor < 0 ? {} : { after: cursor as Seq }),
                      limit: batchSize
                    })
                ).pipe(
                  Effect.map((page) => {
                    const last = page.entries.at(-1)
                    if (last !== undefined) {
                      reader.cursor = last.seq
                    }
                    return [
                      page.entries,
                      page.hasMore ? Option.some(reader.cursor) : Option.none<number>()
                    ] as const
                  })
                ))
            const historical = readPages(reader.cursor)
            // PubSub is only a local fast path. Another journal process cannot
            // publish into it, so a bounded poll must recheck both the durable
            // tail and the compaction floor while the follower is otherwise idle.
            // One raced wake keeps the live tail in the consumer fiber instead
            // of merging two background streams, which also preserves a plain
            // interruption cause when the consumer is cancelled.
            const live = Stream.fromEffectRepeat(
              Effect.raceFirst(PubSub.take(wake), Effect.sleep("1 second"))
            ).pipe(Stream.flatMap(() => readPages(reader.cursor)))
            return Stream.concat(historical, live)
          })()
        )

      /**
       * Owner fence for the fenced append's conflict classification, for
       * checkpoint, and for compaction, evaluated inside the caller's write
       * transaction. A guard SELECT is equivalent to the `WHERE EXISTS`
       * predicate `insertOne` uses because `DurableWriter` serializes write
       * transactions: no reclaim can commit between this read and the
       * statements that run beside it in the same transaction.
       */
      const fenceGuard = (
        runId: RunId,
        owner: OwnerId
      ): Effect.Effect<void, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          const held = yield* sql<{ readonly ok: number }>`
            SELECT 1 AS ok FROM flows_runs
            WHERE run_id = ${runId}
              AND status = 'running'
              AND owner_host_id = ${owner.hostId}
              AND owner_pid = ${owner.pid}
              AND owner_nonce = ${owner.nonce}
          `
          if (held.length === 0) {
            return yield* Effect.fail(
              error("fence_lost", `run ${runId} is no longer owned by ${owner.hostId}:${owner.pid}:${owner.nonce}`)
            )
          }
        })

      /**
       * Reads the row a duplicate emit collides with.
       *
       * The lookup covers BOTH unique constraints the insert can conflict on:
       * `UNIQUE (event_id)` and `UNIQUE (run_id, source_id, source_seq)`. It is
       * tempting to keep only the first, because `makeEventId` is injective in
       * exactly that triple, but that argument holds only for rows this
       * journal minted. `TimeTravelStore.createFork` copies a parent's rows
       * under the child's `run_id` with `'fork:' || run_id || ':' || event_id`,
       * so a forked run carries rows whose triple is live and whose event id it
       * will never mint. Looking those up by event id alone finds nothing, and
       * the caller reports the resulting empty insert as `fence_lost`, a
       * healthy fork failing with "someone else owns this run".
       */
      const selectExisting = (
        queued: QueuedEntry
      ): Effect.Effect<Commit | undefined, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          const existing = yield* sql<JournalRow>`
            SELECT run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            FROM flows_journal_events
            WHERE event_id = ${queued.eventId}
              OR (
                run_id = ${queued.runId}
                AND source_id = ${queued.sourceId}
                AND source_seq = ${queued.sourceSeq}
              )
            ORDER BY seq ASC
            LIMIT 1
          `
          if (existing.length === 0) {
            return undefined
          }
          const row = existing[0]!
          if (
            row.event_type !== queued.eventType ||
            row.payload_json !== queued.payloadJson ||
            row.meta_json !== queued.metaJson
          ) {
            return yield* Effect.fail(
              error(
                "idempotency_conflict",
                `source event ${queued.sourceId}:${queued.sourceSeq} for run ${queued.runId} was reused with different content`
              )
            )
          }
          return {
            entry: yield* decodeRow(row),
            inserted: false
          }
        })

      /**
       * When `owner` is present the insert is fenced on the run's persisted
       * ownership with the same `WHERE EXISTS` predicate
       * `DurableEngineState.scheduleClock` uses, following Temporal's shard
       * `rangeID` check (`service/history/shard/context_impl.go`,
       * `renewRangeLocked`) reduced to one SQL predicate: a zombie owner whose
       * run was reclaimed cannot append, and fails with `fence_lost`.
       *
       * The fence outranks dedup. The duplicate lookup answers an ownerless
       * insert up front, but a fenced insert consults it only after the
       * INSERT produced no row AND `fenceGuard` has confirmed the owner in
       * the same serialized transaction, Temporal conditions every request
       * on the `rangeID` before anything else. Answering a zombie's
       * resubmission from the dedup index would launder its lost fence into
       * a `Duplicate` receipt for work the live owner committed; a confirmed
       * owner's conflict, by contrast, is a genuine duplicate (its own
       * earlier commit, or a forked run's copied row).
       */
      const insertOne = (
        queued: QueuedEntry,
        fence: Fence,
        enforceCompactionFloor = false
      ): Effect.Effect<Commit, JournalError | SqlError.SqlError> =>
        Effect.gen(function*() {
          if (fence._tag === "Unfenced") {
            const duplicate = yield* selectExisting(queued)
            if (duplicate !== undefined) {
              return duplicate
            }
          }
          const insert = enforceCompactionFloor
            ? sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              )
              SELECT
                ${queued.runId},
                ${queued.seq},
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              WHERE NOT EXISTS (
                SELECT 1 FROM flows_journal_checkpoints
                WHERE run_id = ${queued.runId}
                  AND compacted_at_ms IS NOT NULL
                  AND seq >= ${queued.seq}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
            : fence._tag === "Unfenced"
            ? sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${queued.runId},
                ${queued.seq},
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
            : sql<JournalRow>`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              )
              SELECT
                ${queued.runId},
                ${queued.seq},
                ${queued.eventId},
                ${queued.sourceId},
                ${queued.sourceSeq},
                ${queued.emittedAtMs},
                ${queued.eventType},
                ${queued.payloadJson},
                ${queued.metaJson}
              WHERE EXISTS (
                SELECT 1
                FROM flows_runs
                WHERE run_id = ${queued.runId}
                  AND status = 'running'
                  AND owner_host_id = ${fence.owner.hostId}
                  AND owner_pid = ${fence.owner.pid}
                  AND owner_nonce = ${fence.owner.nonce}
              )
              ON CONFLICT DO NOTHING
              RETURNING run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
            `
          const inserted = yield* insert
          if (inserted.length > 0) {
            return {
              entry: yield* decodeRow(inserted[0]!),
              inserted: true
            }
          }
          if (fence._tag === "Owned") {
            // The fenced INSERT produced no row either because the fence
            // predicate failed or because a unique constraint fired. The
            // fence is checked first, so a lost fence is reported as
            // `fence_lost` even when the resubmitted identity already names
            // a committed entry.
            yield* fenceGuard(queued.runId, fence.owner)
          }
          const racedDuplicate = yield* selectExisting(queued)
          if (racedDuplicate !== undefined) {
            return racedDuplicate
          }
          // The insert produced no row and names no committed identity. Before
          // blaming a racing writer, ask whether a compaction moved the floor
          // above this sequence: that is a drop, not a sequence conflict, and
          // the caller needs the floor to resync from. A durable write cannot
          // reach this case, because it allocates above the surviving
          // checkpoint row, so the read costs nothing on that path.
          {
            const floor = yield* compactionFloor(queued.runId)
            if (floor !== undefined && queued.seq <= floor) {
              return yield* Effect.fail(
                new JournalError({
                  code: "compacted",
                  message:
                    `queued sequence ${queued.seq} for run ${queued.runId} was dropped below compaction floor ${floor}`,
                  checkpointSeq: floor as Seq
                })
              )
            }
          }
          return yield* Effect.fail(
            error(
              "sequence_conflict",
              `sequence ${queued.seq} for run ${queued.runId} was committed by another writer`
            )
          )
        })

      const persistBatch = (
        batch: ReadonlyArray<QueuedEntry>
      ): Effect.Effect<BatchOutcome, JournalError> =>
        writer.write(withRunPermits(
          batch.map((queued) =>
            queued.runId
          ),
          Effect.gen(function*() {
            const results = yield* Effect.forEach(
              batch,
              (queued) => Effect.map(Effect.result(insertOne(queued, unfenced, true)), (result) => ({ queued, result }))
            )
            const commits: Array<SettledCommit> = []
            const losses: Array<EntryLoss> = []
            for (const settled of results) {
              if (Result.isSuccess(settled.result)) {
                commits.push({ queued: settled.queued, commit: settled.result.success })
              } else if (isJournalError(settled.result.failure)) {
                losses.push({ queued: settled.queued, cause: settled.result.failure })
              } else {
                return yield* Effect.fail(settled.result.failure)
              }
            }
            return { commits, losses }
          })
        )).pipe(
          // Every per-entry `JournalError` is settled inside the transaction
          // above, so the only failure that escapes is the transaction itself:
          // a database outage, which is what `sink_failed` names.
          Effect.mapError((cause) => error("sink_failed", "journal sink failed", cause))
        )

      const publish = (commits: ReadonlyArray<Commit>): Effect.Effect<void> =>
        Effect.forEach(
          commits,
          (commit) => {
            if (!commit.inserted) {
              return Effect.void
            }
            return PubSub.publish(changes, freezePublished(commit.entry)).pipe(
              Effect.andThen(
                Effect.forEach(
                  wakes.get(commit.entry.runId) ?? [],
                  (wake) => PubSub.publish(wake, undefined),
                  { discard: true }
                )
              ),
              Effect.asVoid
            )
          },
          { discard: true }
        )

      const rememberCommitted = (queued: QueuedEntry, seq: Seq): void => {
        retain(sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq), {
          seq,
          eventType: queued.eventType,
          payloadJson: queued.payloadJson,
          metaJson: queued.metaJson,
          status: "committed"
        })
        raiseSequenceFloor(queued.runId, seq)
        raiseSourceSequenceFloor(queued.runId, queued.sourceId, queued.sourceSeq)
      }

      /**
       * Reads the durable allocation floor for a run (or a producer) inside the
       * caller's transaction.
       *
       * Stated deviation from smithers `packages/db/src/adapter.js`, which
       * allocates `MAX(seq) + 1` under `BEGIN IMMEDIATE`: Effect's SQL client
       * has no `beginTransaction` hook on the SQLite backends we ship
       * (`@effect/sql-sqlite-node` never forwards one), so `DurableWriter.write`
       * runs the default DEFERRED transaction. The read therefore takes a
       * shared lock and the later INSERT upgrades it. Under WAL, enabled by
       * `NodeDatabase`, a concurrent writer makes that upgrade fail with
       * `SQLITE_BUSY_SNAPSHOT`, which `WriteRetry.isRetryableSqliteWriteError`
       * classifies as retryable, so the whole transaction (floor read
       * included) replays against the committed snapshot. Allocation is
       * conflict-free by retry rather than by lock escalation; the invariant
       * is proved by
       * `packages/journal/test/JournalDurable.test.ts` ("emitDurable never
       * collides when two connections write one run concurrently").
       *
       * Governing design: `docs/pages/concepts/journal.md`.
       */
      const nextDurable = (
        column: "seq" | "source_seq",
        runId: RunId,
        sourceId: SourceId | undefined
      ): Effect.Effect<number, SqlError.SqlError> =>
        Effect.map(
          column === "seq"
            ? sql<{ readonly next: number | null }>`
              SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${runId}
            `
            : sql<{ readonly next: number | null }>`
              SELECT MAX(source_seq) + 1 AS next FROM flows_journal_events
              WHERE run_id = ${runId} AND source_id = ${sourceId!}
            `,
          (rows) => Number(rows[0]?.next ?? 0)
        )

      /**
       * Reads a run's durable allocation floors when the in-process cache has
       * not observed them yet.
       *
       * `emitLossy` allocates from the index alone, it queues rather than
       * writing, so it cannot read the database mid-allocation, which is why
       * the floors used to be seeded for every run at construction. Reading
       * them on first use instead keeps the index proportional to the runs this
       * process touches rather than to total history, and the durable read is
       * the same `MAX(...) + 1` the seed computed.
       *
       * This function never mutates the cache. Its SQL reads deliberately run
       * without the allocator; the caller later takes the short allocator
       * permit, re-checks the monotonic cache, and reserves both sequences in
       * one synchronous step.
       */
      const ensureFloors = (
        runId: RunId,
        sourceId: SourceId
      ): Effect.Effect<{ readonly seq: number; readonly sourceSeq: number }, JournalError> =>
        Effect.suspend(() => {
          const key = sourceKey(runId, sourceId)
          const seq = state.sequences.get(runId)
          const sourceSeq = state.sourceSequences.get(key)
          if (seq !== undefined && sourceSeq !== undefined) {
            return Effect.succeed({ seq, sourceSeq })
          }
          return Effect.all({
            seq: seq === undefined ? nextDurable("seq", runId, undefined) : Effect.succeed(seq),
            sourceSeq: nextDurable("source_seq", runId, sourceId)
          }).pipe(
            Effect.mapError((cause) => error("sink_failed", "could not read journal allocation floor", cause)),
            Effect.flatMap((floors) => {
              if (
                !Number.isSafeInteger(floors.seq) ||
                floors.seq < 0 ||
                !Number.isSafeInteger(floors.sourceSeq) ||
                floors.sourceSeq < 0
              ) {
                return Effect.fail(
                  error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                )
              }
              return Effect.succeed(floors)
            })
          )
        })

      /**
       * Records a committed entry in the in-process index and publishes it,
       * immediately outside a transaction, parked on the enclosing
       * {@link Settlements} list inside one.
       */
      const settleCommit = (
        queued: QueuedEntry,
        commit: Commit
      ): Effect.Effect<Effect.Effect<void>> =>
        Effect.flatMap(Effect.serviceOption(Settlements), (enclosing) => {
          const mandatory = Effect.sync(() => rememberCommitted(queued, commit.entry.seq)).pipe(
            Effect.andThen(publish([commit]))
          )
          const maintenance = Effect.interruptible(noteCommitted(queued.runId, commit.inserted ? 1 : 0))
          return Option.isNone(enclosing)
            ? mandatory.pipe(Effect.as(maintenance))
            : Effect.sync(() => {
              enclosing.value.push(mandatory.pipe(Effect.andThen(maintenance)))
            }).pipe(Effect.as(Effect.void))
        })

      /**
       * Opens (or joins) the write transaction that keeps the logical WAL
       * atomic with the executable state it describes.
       *
       * The transaction body is re-entered verbatim when `DurableWriter.write`
       * replays a transient conflict, so the settlement list is reset on each
       * attempt: an abandoned attempt's entries were rolled back with it and
       * must never be published or indexed.
       */
      const transact: Service["transact"] = <A, E, R>(
        effect: Effect.Effect<A, E, R>
      ): Effect.Effect<A, E | JournalError, R> =>
        Effect.flatMap(Effect.serviceOption(Settlements), (enclosing) => {
          const write = <A2, E2, R2>(body: Effect.Effect<A2, E2, R2>) =>
            writer.write(body).pipe(
              Effect.catchIf(
                (cause): cause is DatabaseError => cause instanceof DatabaseError,
                (cause) => Effect.fail(error("sink_failed", "journal transaction failed", cause))
              )
            )
          // A nested transact is a savepoint of the enclosing one; the
          // outermost owner of the list publishes for all of them.
          if (Option.isSome(enclosing)) {
            return write(effect)
          }
          const settlements: Array<Effect.Effect<void>> = []
          return Effect.uninterruptibleMask((restore) =>
            restore(write(
              Effect.suspend(() => {
                settlements.length = 0
                return Effect.provideService(effect, Settlements, settlements)
              })
            )).pipe(
              Effect.tap(() => Effect.forEach(settlements, (settlement) => settlement, { discard: true }))
            )
          )
        })

      const writeDurable = (
        input: Input,
        fence: Fence
      ): Effect.Effect<DurableReceipt, JournalError> =>
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: input.runId,
            sourceId: input.sourceId,
            eventType: input.eventType
          })
          const emittedAtMs = yield* Clock.currentTimeMillis
          const prepared = yield* Effect.fromResult(prepare(input, emittedAtMs))
          const committed = yield* withActiveRunWrite(
            prepared.validated.runId,
            Effect.gen(function*() {
              const { metaJson, payloadJson, validated } = prepared
              const written = yield* Effect.uninterruptibleMask((restore) =>
                restore(writer.write(Effect.gen(function*() {
                  const durableSourceSeq = yield* nextDurable(
                    "source_seq",
                    validated.runId,
                    validated.sourceId
                  )
                  const durableSeq = yield* nextDurable("seq", validated.runId, undefined)
                  const reserved = yield* allocation.withPermit(Effect.fromResult(Result.gen(function*() {
                    const key = sourceKey(validated.runId, validated.sourceId)
                    const sourceSeq: SourceSeq = validated.sourceSeq ??
                      (Math.max(
                        durableSourceSeq,
                        state.sourceSequences.get(key) ?? 0
                      ) as SourceSeq)
                    if (
                      !Number.isSafeInteger(sourceSeq) ||
                      sourceSeq < 0 ||
                      sourceSeq === Number.MAX_SAFE_INTEGER
                    ) {
                      return yield* Result.fail(
                        error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                      )
                    }
                    const seq = Math.max(
                      durableSeq,
                      state.sequences.get(validated.runId) ?? 0
                    ) as Seq
                    if (!Number.isSafeInteger(seq) || seq === Number.MAX_SAFE_INTEGER) {
                      return yield* Result.fail(
                        error("invalid_event", "journal sequence is outside the allocatable safe integer range")
                      )
                    }
                    // Claim the seq NOW, not at commit: a concurrent `emitLossy`
                    // allocates from this floor alone, and `settleCommit` parks
                    // the commit-time raise until the outermost COMMIT.
                    // Re-entering the transaction body is idempotent because the
                    // floor only rises. An abandoned attempt leaves the number
                    // unused, which is a gap: allocation is `MAX(seq) + 1` and
                    // replay is `ORDER BY seq`, so neither reads a gap as anything.
                    raiseSequenceFloor(validated.runId, seq)
                    // Claim the producer sequence at the same allocation seam.
                    // Without this, a lossy emit from the same producer can read
                    // the pre-transaction source floor and reuse this identity
                    // while an enclosing `transact` is still open.
                    raiseSourceSequenceFloor(validated.runId, validated.sourceId, sourceSeq)
                    return { seq, sourceSeq }
                  })))
                  const { seq, sourceSeq } = reserved
                  const queued: QueuedEntry = {
                    runId: validated.runId,
                    seq,
                    eventId: makeEventId(validated.runId, validated.sourceId, sourceSeq),
                    sourceId: validated.sourceId,
                    sourceSeq,
                    emittedAtMs,
                    eventType: validated.eventType,
                    payloadJson,
                    metaJson
                  }
                  const commit = yield* insertOne(queued, fence)
                  return { commit, queued, sourceSeq }
                })))
              )
              /**
               * `writer.write` is a retrying transaction: its body replays on
               * `SQLITE_BUSY(_SNAPSHOT)` and can still abort at COMMIT after the
               * body succeeded. Cache mutation and publication therefore happen
               * strictly after the transaction returns, so subscribers never
               * observe a rolled-back entry and a replayed body never publishes
               * twice. Mirrors the queued path, which publishes in a `.tap`
               * outside `persistBatch`.
               *
               * Under `transact` "after the transaction returns" is not yet
               * "after COMMIT": this write is a savepoint of the caller's
               * transaction, so `settleCommit` parks both effects until the
               * outermost transaction commits. The run permit is already free,
               * which lets automatic compaction take the same run barrier.
               */
              const maintenance = yield* settleCommit(written.queued, written.commit)
              const receipt: DurableReceipt = written.commit.inserted
                ? { _tag: "Accepted", seq: written.commit.entry.seq, sourceSeq: written.sourceSeq }
                : {
                  _tag: "Duplicate",
                  seq: written.commit.entry.seq,
                  sourceSeq: written.sourceSeq,
                  status: "committed"
                }
              yield* Metric.update(JournalMetrics.durable[receipt._tag], 1)
              return { maintenance, receipt }
            }).pipe(
              Effect.mapError((cause) =>
                isJournalError(cause) ? cause : error("sink_failed", "durable journal write failed", cause)
              )
            )
          )
          yield* committed.maintenance
          return committed.receipt
        })

      const emitDurable: Service["emitDurable"] = Effect.fn("Journal.emitDurable")((
        input: Input,
        owner: OwnerId
      ) =>
        Effect.flatMap(
          Effect.fromResult(requireFence(owner, "emitDurable")),
          (fence) => writeDurable(input, fence)
        )
      )

      const emitDurableUnfenced: Service["emitDurableUnfenced"] = Effect.fn("Journal.emitDurableUnfenced")((
        input: Input
      ) => writeDurable(input, unfenced))

      const emitLossy: Service["emitLossy"] = queuedEmit

      const checkpointInternal = (
        checkpointOptions: CheckpointOptions,
        fence: Fence
      ): Effect.Effect<Checkpoint, JournalError> =>
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: checkpointOptions.runId,
            seq: checkpointOptions.seq
          })
          if (checkpointOptions.runId.length === 0) {
            return yield* Effect.fail(error("invalid_event", "runId must not be empty"))
          }
          if (!Number.isSafeInteger(checkpointOptions.seq) || checkpointOptions.seq < 0) {
            return yield* Effect.fail(error("invalid_event", "seq must be a canonical committed sequence"))
          }
          // The state round-trips verbatim: it is replay input, so redaction
          // deliberately does not apply, rewriting it would resume the run
          // with the wrong data. A secret that must not persist belongs in a
          // `Redacted` field of the caller's own state schema.
          const stateJson = yield* Effect.fromResult(encodeJson(checkpointOptions.state, "state"))
          const receiptState = yield* Schema.decodeUnknownEffect(UnknownFromJsonString)(stateJson).pipe(
            Effect.mapError(
              /* v8 ignore next -- encodeJson produced these valid JSON bytes immediately above */
              (cause) => error("decode_failed", "could not decode persisted checkpoint state", cause)
            )
          )
          const createdAtMs = yield* Clock.currentTimeMillis
          return yield* writer.write(Effect.gen(function*() {
            if (fence._tag === "Owned") {
              yield* fenceGuard(checkpointOptions.runId, fence.owner)
            }
            // The target must be a committed entry: the surviving row is what
            // keeps the run's durable `MAX(seq)` allocation floor at or above
            // the compaction boundary, so a process restarted after
            // compaction can never re-allocate a truncated sequence.
            const target = yield* sql<{ readonly ok: number }>`
              SELECT 1 AS ok FROM flows_journal_events
              WHERE run_id = ${checkpointOptions.runId} AND seq = ${checkpointOptions.seq}
            `
            if (target.length === 0) {
              return yield* Effect.fail(error(
                "checkpoint_invalid",
                `checkpoint sequence ${checkpointOptions.seq} names no committed entry of run ${checkpointOptions.runId}`
              ))
            }
            const floor = yield* compactionFloor(checkpointOptions.runId)
            if (floor !== undefined && checkpointOptions.seq <= floor) {
              return yield* Effect.fail(
                new JournalError({
                  code: "checkpoint_invalid",
                  message: `run ${checkpointOptions.runId} is already compacted through sequence ${floor}`,
                  checkpointSeq: floor as Seq
                })
              )
            }
            yield* sql`
              INSERT INTO flows_journal_checkpoints (run_id, seq, state_json, created_at_ms)
              VALUES (${checkpointOptions.runId}, ${checkpointOptions.seq}, ${stateJson}, ${createdAtMs})
              ON CONFLICT (run_id, seq) DO UPDATE SET
                state_json = excluded.state_json,
                created_at_ms = excluded.created_at_ms
            `
            return new Checkpoint({
              runId: checkpointOptions.runId,
              seq: checkpointOptions.seq,
              state: receiptState,
              createdAtMs,
              compactedAtMs: null
            })
          })).pipe(
            Effect.mapError((cause) =>
              isJournalError(cause) ? cause : error("sink_failed", "durable checkpoint write failed", cause)
            )
          )
        })

      const checkpoint: Service["checkpoint"] = Effect.fn("Journal.checkpoint")((
        checkpointOptions: CheckpointOptions,
        owner: OwnerId
      ) =>
        Effect.flatMap(
          Effect.fromResult(requireFence(owner, "checkpoint")),
          (fence) => checkpointInternal(checkpointOptions, fence)
        )
      )

      const latestCheckpoint: Service["latestCheckpoint"] = Effect.fn("Journal.latestCheckpoint")((runId: RunId) =>
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({ runId })
          if (runId.length === 0) {
            return yield* Effect.fail(error("invalid_event", "runId must not be empty"))
          }
          const rows = yield* sql<CheckpointRow>`
            SELECT run_id, seq, state_json, created_at_ms, compacted_at_ms
            FROM flows_journal_checkpoints
            WHERE run_id = ${runId}
            ORDER BY seq DESC
            LIMIT 1
          `.pipe(Effect.mapError((cause) => error("read_failed", "durable checkpoint read failed", cause)))
          const row = rows[0]
          return row === undefined ? Option.none() : Option.some(yield* decodeCheckpointRow(row))
        })
      )

      const compactInternal = (
        compactOptions: CompactOptions,
        fence: Fence
      ): Effect.Effect<Compacted, JournalError> =>
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({
            runId: compactOptions.runId,
            ...(compactOptions.upTo === undefined ? {} : { upTo: compactOptions.upTo })
          })
          if (compactOptions.runId.length === 0) {
            return yield* Effect.fail(error("invalid_event", "runId must not be empty"))
          }
          const compactedAtMs = yield* Clock.currentTimeMillis
          return yield* withCompactionBarrier(
            compactOptions.runId,
            writer.write(Effect.gen(function*() {
              if (fence._tag === "Owned") {
                yield* fenceGuard(compactOptions.runId, fence.owner)
              }
              const upTo = compactOptions.upTo
              const rows = upTo === undefined
                ? yield* sql<CheckpointRow>`
                SELECT run_id, seq, state_json, created_at_ms, compacted_at_ms
                FROM flows_journal_checkpoints
                WHERE run_id = ${compactOptions.runId}
                ORDER BY seq DESC
                LIMIT 1
              `
                : yield* sql<CheckpointRow>`
                SELECT run_id, seq, state_json, created_at_ms, compacted_at_ms
                FROM flows_journal_checkpoints
                WHERE run_id = ${compactOptions.runId} AND seq = ${upTo}
              `
              const row = rows[0]
              if (row === undefined) {
                return yield* Effect.fail(error(
                  "checkpoint_invalid",
                  `run ${compactOptions.runId} has no checkpoint${
                    upTo === undefined ? "" : ` at sequence ${upTo}`
                  } to compact to`
                ))
              }
              const checkpointSeq = Number(row.seq) as Seq
              if (row.compacted_at_ms !== null) {
                // A retried compaction: the floor is already here and the rows
                // below it are already gone.
                return { runId: compactOptions.runId, checkpointSeq, deleted: 0 } satisfies Compacted
              }
              for (const reader of readers.get(compactOptions.runId) ?? []) {
                if (reader.cursor < checkpointSeq - 1) {
                  return yield* Effect.fail(
                    new JournalError({
                      code: "reader_behind",
                      message:
                        `a live stream of run ${compactOptions.runId} still needs sequences below checkpoint ${checkpointSeq}`,
                      checkpointSeq
                    })
                  )
                }
              }
              const doomed = yield* sql<{ readonly total: number }>`
              SELECT COUNT(*) AS total FROM flows_journal_events
              WHERE run_id = ${compactOptions.runId} AND seq < ${checkpointSeq}
            `
              // Strictly below the checkpoint: the checkpointed entry survives,
              // holding the run's `MAX(seq)` allocation floor. Superseded
              // checkpoints go with their entries; the truncation and the floor
              // advance are one transaction, so a crash between them is
              // unrepresentable.
              yield* sql`
              DELETE FROM flows_journal_events
              WHERE run_id = ${compactOptions.runId} AND seq < ${checkpointSeq}
            `
              yield* sql`
              DELETE FROM flows_journal_checkpoints
              WHERE run_id = ${compactOptions.runId} AND seq < ${checkpointSeq}
            `
              yield* sql`
              UPDATE flows_journal_checkpoints
              SET compacted_at_ms = ${compactedAtMs}
              WHERE run_id = ${compactOptions.runId} AND seq = ${checkpointSeq}
            `
              return {
                runId: compactOptions.runId,
                checkpointSeq,
                deleted: Number(doomed[0]?.total ?? 0)
              } satisfies Compacted
            })).pipe(
              Effect.mapError((cause) =>
                isJournalError(cause) ? cause : error("sink_failed", "journal compaction failed", cause)
              )
            )
          )
        })

      const compact: Service["compact"] = Effect.fn("Journal.compact")((
        compactOptions: CompactOptions,
        owner: OwnerId
      ) =>
        Effect.flatMap(
          Effect.fromResult(requireFence(owner, "compact")),
          (fence) => compactInternal(compactOptions, fence)
        )
      )

      const compactionPolicy = options.compaction
      const compactionCounts = new Map<RunId, number>()
      const compactingRuns = new Set<RunId>()

      const countEntries = (runId: RunId): Effect.Effect<number, SqlError.SqlError> =>
        Effect.map(
          sql<{ readonly total: number }>`
            SELECT COUNT(*) AS total FROM flows_journal_events WHERE run_id = ${runId}
          `,
          (rows) => Number(rows[0]?.total ?? 0)
        )

      /**
       * One automatic checkpoint-and-compact attempt at the run's durable
       * tail. Runs post-commit; a failure or refusal is logged and damped,
       * the counter restarts, so the next attempt waits for another
       * `entryThreshold` commits, and is never surfaced to the emit whose
       * settlement crossed the threshold.
       */
      const policyCompact = (policy: CompactionPolicy, runId: RunId): Effect.Effect<void> =>
        Effect.gen(function*() {
          const tail = yield* sql<{ readonly last: number | null }>`
            SELECT MAX(seq) AS last FROM flows_journal_events WHERE run_id = ${runId}
          `
          const last = tail[0]?.last
          if (last === null || last === undefined) {
            return
          }
          const upTo = Number(last) as Seq
          const captured = yield* Effect.timeoutOrElse(policy.capture(runId, upTo), {
            duration: compactionCaptureTimeout,
            orElse: () =>
              Effect.fail(
                new Error(
                  `journal compaction capture for run ${runId} exceeded ${compactionCaptureTimeout}`
                )
              )
          })
          // The policy is the journal's OWN post-commit maintenance, not a
          // caller's mutating entrypoint: it owns no run and holds no fence,
          // so it drives the internal channel. The attempt only ever
          // truncates below a tail the run's own commits produced, a retry is
          // idempotent (a re-attempt after a reclaim compacts the same
          // committed prefix the live owner also sees), and every failure is
          // damped below, never surfaced to the emit that crossed the
          // threshold.
          yield* checkpointInternal({ runId, seq: upTo, state: captured }, unfenced)
          yield* compactInternal({ runId, upTo }, unfenced)
          compactionCounts.set(runId, yield* countEntries(runId))
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.sync(() => {
                compactionCounts.set(runId, 0)
              }).pipe(
                Effect.andThen(
                  Effect.logWarning("journal auto-compaction failed; retrying after the next threshold", cause)
                )
              )
          )
        )

      /**
       * Counts a run's committed entries toward the compaction policy and
       * triggers an attempt at the threshold.
       *
       * The count is seeded lazily from the durable COUNT on the run's first
       * committed entry in this process, mirroring `ensureFloors`, so a
       * restarted process still compacts a long pre-existing history. The
       * durable COUNT already includes the rows the caller is reporting: they
       * committed before this settlement ran.
       */
      const noteCommitted = (runId: RunId, committed: number): Effect.Effect<void> => {
        const policy = compactionPolicy
        if (policy === undefined || committed <= 0) {
          return Effect.void
        }
        return Effect.gen(function*() {
          if (compactingRuns.has(runId)) {
            return
          }
          const known = compactionCounts.get(runId)
          const current = known === undefined ? yield* countEntries(runId) : known + committed
          compactionCounts.set(runId, current)
          if (current < policy.entryThreshold) {
            return
          }
          compactingRuns.add(runId)
          yield* Effect.ensuring(
            policyCompact(policy, runId),
            Effect.sync(() => {
              compactingRuns.delete(runId)
            })
          )
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.logWarning("journal compaction policy bookkeeping failed", cause)
          )
        )
      }

      const recordCommits = (
        commits: ReadonlyArray<SettledCommit>
      ): void => {
        for (const { commit, queued } of commits) {
          retain(
            sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq),
            {
              seq: commit.entry.seq,
              eventType: queued.eventType,
              payloadJson: queued.payloadJson,
              metaJson: queued.metaJson,
              status: "committed"
            }
          )
        }
      }

      const settle = (count: number): void => {
        state.pending = Math.max(0, state.pending - count)
        if (state.pending === 0) {
          completeFlushWaiters(Effect.void)
        }
      }

      /** Reports entries that left the queue without durable commits. */
      const reportLoss = (cause: JournalError, batch: ReadonlyArray<QueuedEntry>): void => {
        for (const queued of batch) {
          const identity = sourceEventKey(queued.runId, queued.sourceId, queued.sourceSeq)
          // Allocation is serialized until this batch settles, so no newer
          // admission can replace this exact identity before the deletion.
          state.sourceEvents.delete(identity)
        }
        state.sinkFailure = cause
        state.lossEpoch += 1
        state.pending = Math.max(0, state.pending - batch.length)
        // A waiter that is already registered is the flush the loss belongs
        // to, so reporting it there spends the report; only a loss nobody was
        // waiting on is left for the next flush to pick up.
        if (state.flushWaiters.size > 0) {
          state.flushedLossEpoch = state.lossEpoch
        }
        completeFlushWaiters(Effect.fail(cause))
        for (const subscribers of wakes.values()) {
          for (const wake of subscribers) {
            PubSub.publishUnsafe(wake, undefined)
          }
        }
      }

      // A failed transaction loses the whole batch. Release its per-run drain
      // counts before reporting the failure so a waiting compactor can retry
      // against the same database outage instead of waiting forever.
      const failSink = (cause: JournalError, batch: ReadonlyArray<QueuedEntry>): void => {
        settleRunPending(batch)
        reportLoss(cause, batch)
      }

      // One failed batch loses that batch and is reported as such; it never
      // ends the writer. Only interruption (scope closure) stops the loop, so
      // the queue keeps draining as soon as the database is healthy again.
      const writeBatch = Queue.takeBetween(queue, 1, batchSize).pipe(
        Effect.flatMap((batch) =>
          persistBatch(batch).pipe(
            Effect.tap((outcome) => Effect.sync(() => recordCommits(outcome.commits))),
            Effect.tap((outcome) => publish(outcome.commits.map(({ commit }) => commit))),
            // The transaction has committed and publication is complete. Drop
            // the barrier counts before policy compaction takes this run's
            // permit, while the global flush count still waits for the policy.
            Effect.tap(() => Effect.sync(() => settleRunPending(batch))),
            // The policy runs BEFORE the batch settles so a `flush` barrier
            // does not return while an auto-compaction it triggered is still
            // in flight.
            Effect.tap((outcome) => {
              const perRun = new Map<RunId, number>()
              outcome.commits.forEach(({ commit, queued }) => {
                if (!commit.inserted) {
                  return
                }
                perRun.set(queued.runId, (perRun.get(queued.runId) ?? 0) + 1)
              })
              return Effect.forEach(perRun, ([runId, committed]) => noteCommitted(runId, committed), {
                discard: true
              })
            }),
            Effect.tap((outcome) =>
              Effect.sync(() => {
                for (const loss of outcome.losses) {
                  reportLoss(loss.cause, [loss.queued])
                }
                settle(outcome.commits.length)
              })
            ),
            Effect.catch((cause) => Effect.sync(() => failSink(cause, batch))),
            // Defects only: an interruption is scope closure, and it must end
            // the writer rather than be reported as a lost batch.
            Effect.catchDefect((defect) =>
              Effect.sync(() =>
                failSink(
                  error("sink_failed", "journal writer failed", Cause.die(defect)),
                  batch
                )
              )
            )
          )
        )
      )

      const drain = Effect.forever(writeBatch)

      yield* Effect.forkScoped(drain)
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          // A scope finalizer runs once, and nothing else moves the status, so
          // the journal is always `open` here.
          yield* Effect.sync(() => {
            state.status = "closing"
          })
          yield* Effect.ignore(flushInternal)
          yield* Effect.sync(() => {
            state.status = "closed"
          })
          yield* Queue.shutdown(queue)
          yield* PubSub.shutdown(changes)
          wakes.clear()
        })
      )

      const project = <S, E, R>(
        projection: Projection<S, E, R>,
        streamOptions: StreamOptions
      ): Stream.Stream<S, JournalError, R> =>
        Stream.unwrap(
          Effect.fn("Journal.project")(
            <S2, E2, R2>(
              activeProjection: Projection<S2, E2, R2>,
              activeOptions: StreamOptions
            ) =>
              Effect.annotateCurrentSpan({
                projection: activeProjection.name,
                runId: activeOptions.runId,
                ...(activeOptions.afterSequence === undefined ? {} : { afterSequence: activeOptions.afterSequence })
              }).pipe(Effect.andThen(Effect.succeed(
                stream(activeOptions).pipe(
                  Stream.scanEffect(activeProjection.initial, (state, entry) =>
                    Effect.suspend(() => activeProjection.reduce(state, entry)).pipe(
                      Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Effect.failCause(cause as Cause.Cause<never>)
                          : Effect.fail(
                            error(
                              "projection_failed",
                              `projection ${activeProjection.name} failed`,
                              cause
                            )
                          )
                      )
                    ))
                )
              )))
          )(projection, streamOptions)
        )

      return makeJournal({
        emitLossy,
        emitDurable,
        emitDurableUnfenced,
        transact,
        stream,
        entries: readPage,
        changes: PubSub.subscribe(changes),
        project,
        flush: Effect.fn("Journal.flush")(() =>
          Effect.suspend(() => Effect.annotateCurrentSpan({ pending: state.pending })).pipe(
            Effect.andThen(flushInternal)
          )
        )(),
        checkpoint,
        latestCheckpoint,
        compact
      })
    })
  )
