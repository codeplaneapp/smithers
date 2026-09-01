/**
 * Browser-safe client for replaying and following journal entries.
 *
 * @since 0.1.0
 */
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import type { ShareCapability } from "./BranchProtocol.ts"
import { causeText } from "./internal/causeText.ts"
import { positiveInt } from "./internal/options.ts"
import { SyncError, SyncGapError } from "./SyncError.ts"
import {
  covers,
  defaultMaxFrameBytes,
  duplicateCursorRunId,
  encodedByteLength,
  type EntriesFrame,
  type ReadResponse,
  type Resync,
  type Scope,
  type WorkspaceCursor
} from "./SyncProtocol.ts"
import { SyncRpcs } from "./SyncRpcs.ts"

/**
 * Frames one subscription round may carry before the follow replenishes it.
 *
 * A subscription's `credit` is a hard frame limit the server enforces with
 * `Stream.take`, so the number the client sends is the size of its window, not
 * a hint. At `credit: 1` the window closed after every single entry and the
 * follow resubscribed: following a run that emits a hundred entries cost a
 * hundred subscribe round trips, each of them a fresh cursor snapshot and a
 * fresh server-side fan-out. Replenishing 256 frames at a time makes the
 * round-trip cost proportional to the window rather than to the traffic, and
 * keeps it bounded — an unbounded window would hand the server one
 * never-closing subscription per follower.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCredit = 256

/**
 * Entries one catch-up page asks for.
 *
 * Bootstrap is the replay half of replay-then-follow, so the page size is the
 * memory one catch-up costs and the granularity at which its cursor advances.
 * It matches {@link defaultCredit} and stays under
 * `SyncProtocol.maxReadLimit`, which is the ceiling the server enforces.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultBootstrapLimit = 256

/**
 * Input accepted by a sync subscription.
 *
 * `capability` authorizes branch reads: following a shared branch's run
 * requires a capability that verifies for that branch on the server.
 *
 * @category models
 * @since 0.1.0
 */
export interface SubscribeOptions {
  readonly scope: Scope
  /**
   * Where this subscription starts, per run. The effective position is the
   * LATER of this and what the client has already acknowledged, so a caller
   * ahead of the shared view keeps its place and a caller behind it is
   * fast-forwarded. Rebuild from an earlier position with a fresh client.
   */
  readonly cursors: WorkspaceCursor
  readonly capability?: ShareCapability
  /**
   * Frames one subscription round may carry before the follow replenishes the
   * window. Defaults to {@link defaultCredit}, and must be a positive integer
   * no greater than `SyncProtocol.maxSubscribeCredit`.
   */
  readonly credit?: number | undefined
  /**
   * Applies one entry, and DEFINES what this subscription's cursor means.
   *
   * Without it the cursor advances as each entry is handed to the consumer,
   * so a consumer whose own application then fails has a cursor naming an
   * entry it never materialized. With it the cursor advances only after this
   * effect succeeds, which makes `RunCursor` mean what its schema says. A
   * failure here fails the subscription with the entry unacknowledged, so the
   * next subscription from `client.cursors` delivers it again; the effect must
   * therefore be idempotent, because a redelivery is exactly what a retry is.
   */
  readonly apply?: ((entry: JournalEvent.Entry) => Effect.Effect<void, SyncError>) | undefined
  /**
   * Runs when the server refuses a cursor below a run's compaction floor,
   * BEFORE the client moves that run's cursor to the checkpoint and restarts.
   *
   * The entries under the floor are deleted, and this wire carries no
   * checkpoint state to stand in for them, so a consumer rebuilding a
   * projection has a real hole to fill. This is the seam it fills it through:
   * load `Journal.latestCheckpoint(runId)`, or discard the run's derived
   * state, or refuse. A failure here fails the subscription with the cursor
   * unmoved, so nothing is silently skipped. The default logs the skipped
   * range and continues, which is what a follower with no derived state
   * wants.
   */
  readonly onResync?: ((resync: Resync) => Effect.Effect<void, SyncError>) | undefined
}

/**
 * Replicated journal subscription operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly subscribe: (options: SubscribeOptions) => Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError>
  readonly cursors: Effect.Effect<WorkspaceCursor>
}

/**
 * The browser-safe journal replication client.
 *
 * @category services
 * @since 0.1.0
 */
export class Sync extends Context.Service<Sync, Service>()("@smthrs/sync/Sync") {}

/**
 * Constructs a closed sync stub, optionally overriding individual operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  Sync.of({
    subscribe: () => Stream.fail(new SyncError({ code: "closed", message: "Sync client is closed" })),
    cursors: Effect.succeed([]),
    ...overrides
  })

/**
 * Provides a closed sync stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Sync> =>
  Layer.succeed(Sync, makeNoop(overrides))

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof SyncRpcs>, RpcClientError.RpcClientError>

const transportError = (cause: unknown): SyncError =>
  cause instanceof SyncError
    ? cause
    : new SyncError({
      code: "transport_failed",
      message: cause instanceof Error ? cause.message : "Sync RPC transport failed",
      cause: causeText(cause)
    })

type Cursors = Map<JournalEvent.RunId, JournalEvent.Seq>

const cursorMap = (cursors: WorkspaceCursor): Cursors =>
  new Map(cursors.map((cursor) => [cursor.runId, cursor.afterSeq]))

const canonicalCursors = (cursors: ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>): WorkspaceCursor =>
  Array.from(cursors, ([runId, afterSeq]) => ({ runId, afterSeq })).sort((left, right) =>
    // A Map has one value per key, so this comparator never receives equal
    // run IDs. `cursorMap` and the acknowledged cursor state both establish
    // that invariant before reaching this boundary.
    left.runId > right.runId ? 1 : -1
  )

/**
 * Advances the shared acknowledged view monotonically. A lagging subscription
 * commits what it just consumed, but it must never move the shared cursor
 * backward past another subscription's progress.
 */
const advance = (
  cursors: ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>,
  runId: JournalEvent.RunId,
  throughSeq: JournalEvent.Seq
): ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq> => {
  const current = cursors.get(runId)
  if (current !== undefined && current >= throughSeq) return cursors
  const next = new Map(cursors)
  next.set(runId, throughSeq)
  return next
}

/**
 * Live-follow reconnect policy: exponential backoff capped at five seconds,
 * the same shape as `RpcClient`'s own transport retry policy, and only for
 * transport failures — gaps, authorization refusals, and server closes
 * propagate to the consumer.
 */
const reconnectPolicy = Schedule.min([
  Schedule.exponential(500, 1.5),
  Schedule.spaced(5000)
]).pipe(
  Schedule.while(({ input }) => SyncError.is(input) && input.code === "transport_failed")
)

const isTransportCause = (cause: Cause.Cause<SyncError | SyncGapError>): boolean =>
  cause.reasons.filter(Cause.isFailReason).some((reason) =>
    SyncError.is(reason.error) && reason.error.code === "transport_failed"
  )

const entriesByteLength = (entries: ReadonlyArray<JournalEvent.Entry>): number =>
  entries.reduce((bytes, entry) => bytes + encodedByteLength(entry), 0)

const oversized = (bytes: number, maxFrameBytes: number): SyncError =>
  new SyncError({
    code: "frame_too_large",
    message: `Encoded entries of ${bytes} bytes exceed the ${maxFrameBytes}-byte frame ceiling`
  })

/**
 * The first internal inconsistency of a server frame, or `undefined` for a
 * consistent one.
 *
 * A schema-valid frame can still contradict itself: carry another run's
 * entry, repeat or reorder sequences, or carry an entry outside its own
 * declared covered interval. Applying one would corrupt the client's cursor
 * bookkeeping, so an inconsistent frame is refused as a protocol violation
 * before any entry is admitted or any cursor moves.
 */
const frameViolation = (frame: EntriesFrame): SyncError | undefined => {
  let previous = -1
  for (const entry of frame.entries) {
    if (entry.runId !== frame.runId) {
      return new SyncError({
        code: "protocol_violation",
        message: `Frame for run ${frame.runId} carried an entry for run ${entry.runId}`
      })
    }
    if (entry.seq <= previous) {
      return new SyncError({
        code: "protocol_violation",
        message: `Frame entries must ascend strictly: sequence ${entry.seq} arrived after ${previous}`
      })
    }
    if (entry.seq < frame.fromSeq || frame.toSeq < entry.seq) {
      return new SyncError({
        code: "protocol_violation",
        message: `Entry ${entry.seq} lies outside the frame's covered interval ${frame.fromSeq}..${frame.toSeq}`
      })
    }
    previous = entry.seq
  }
  return undefined
}

/**
 * The first semantic inconsistency of a catch-up page, or `undefined` for a
 * consistent one.
 *
 * The live path has admitted, never trusted, its frames since it was written;
 * the bootstrap path took every schema-valid page on faith, so a compromised
 * or buggy server could hand a run-scoped subscription an entry for a
 * different run and move that run's cursor in a client that never asked about
 * it. These are the same four questions {@link frameViolation} asks, put to a
 * page: is every entry inside the scope the caller asked for, does each run's
 * sequence ascend strictly, is every entry above the cursor the request
 * carried, and does the response echo one cursor per run.
 *
 * Strictly-above-the-cursor is also what makes an incomplete page CONVERGE: a
 * page that carries entries but moves no cursor would be re-read forever.
 */
const pageViolation = (
  scope: Scope,
  requested: ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>,
  response: ReadResponse
): SyncError | undefined => {
  const violation = (message: string): SyncError => new SyncError({ code: "protocol_violation", message })
  const highest = new Map<JournalEvent.RunId, JournalEvent.Seq>()
  for (const entry of response.entries) {
    if (!covers(scope, entry.runId)) {
      return violation(`Read page carried an entry for run ${entry.runId}, which the request's scope excludes`)
    }
    const floor = requested.get(entry.runId)
    if (floor !== undefined && entry.seq <= floor) {
      return violation(
        `Read page carried sequence ${entry.seq} for run ${entry.runId}, at or below the requested cursor ${floor}`
      )
    }
    const previous = highest.get(entry.runId)
    if (previous !== undefined && entry.seq <= previous) {
      return violation(
        `Read page entries for run ${entry.runId} must ascend strictly: sequence ${entry.seq} arrived after ${previous}`
      )
    }
    highest.set(entry.runId, entry.seq)
  }
  const duplicate = duplicateCursorRunId(response.cursors)
  return duplicate === undefined ? undefined : violation(`Read page echoed run ${duplicate} more than once`)
}

/**
 * Projects a Sync RPC client into the local replication service.
 *
 * The acknowledged cursors are per-service state in a `Ref`: concurrent
 * subscriptions share the view, and each commit only ever advances it. A
 * cursor advances in the same stream pull that admits each entry to the
 * consumer, or — when the caller supplies `SubscribeOptions.apply` — only
 * after that callback has applied the entry. Interrupted partial pages
 * therefore retain the last admitted entry rather than incorrectly
 * acknowledging the server's whole page.
 *
 * Server responses are admitted, never trusted, on BOTH paths. A frame or
 * bootstrap page whose encoded entries exceed `maxFrameBytes` is refused with
 * `frame_too_large`; a frame or page that carries another run's entry,
 * repeats or reorders a sequence, or serves an entry at or below the cursor
 * the request carried is refused as a protocol violation before any cursor
 * moves; and an incomplete bootstrap page that makes no progress fails typed
 * instead of re-reading forever.
 *
 * A live follow that loses its transport reconnects under
 * {@link reconnectPolicy}, resuming from the acknowledged cursors; the failure
 * cause is logged before the retry folds it. The follow spends a credit window
 * of {@link defaultCredit} frames per subscription round and replenishes it by
 * resubscribing from the cursors it has acknowledged, so an entry is never
 * re-read and the round-trip cost does not scale with the run's traffic.
 *
 * A `compacted` refusal is recoverable rather than terminal: the run's cursor
 * moves to the checkpoint the server named and the subscription restarts, so
 * one compacted run costs a reconnect instead of the whole subscription. The
 * entries below that checkpoint are gone from the journal, and this wire
 * carries no checkpoint state to stand in for them, so the hole is real:
 * `SubscribeOptions.onResync` is the seam a consumer fills it through, and it
 * runs to success before the cursor moves. The default logs the skipped
 * range, which is what a follower with no derived state wants.
 *
 * A subscription's effective cursor per run is the LATER of the caller's and
 * the acknowledged one: a caller that restored its own progress is never
 * regressed, and a caller asking for history this client already acknowledged
 * is fast-forwarded. Rebuild a projection from an earlier position with a
 * fresh client, whose acknowledged map is empty.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = ({
  bootstrapLimit = defaultBootstrapLimit,
  client,
  maxFrameBytes = defaultMaxFrameBytes
}: {
  readonly client: Client
  /**
   * Largest summed encoded-entry size one frame or bootstrap page may carry,
   * in bytes. Defaults to {@link defaultMaxFrameBytes}.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Entries one catch-up page asks for. Defaults to
   * {@link defaultBootstrapLimit}.
   */
  readonly bootstrapLimit?: number | undefined
}): Effect.Effect<Service> =>
  Effect.sync(() => {
    const acknowledged = Ref.makeUnsafe<ReadonlyMap<JournalEvent.RunId, JournalEvent.Seq>>(new Map())

    const cursors = Effect.map(Ref.get(acknowledged), canonicalCursors)

    const subscribe = (options: SubscribeOptions): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
      Stream.unwrap(Effect.gen(function*() {
        // Every policy this subscription runs under is checked once, here.
        // The declared types say `number`, and `NaN` disabled each comparison
        // it appears in rather than tightening it.
        const credit = yield* positiveInt("SyncClient.SubscribeOptions.credit", options.credit, defaultCredit)
        yield* positiveInt("SyncClient.make.maxFrameBytes", maxFrameBytes, defaultMaxFrameBytes)
        yield* positiveInt("SyncClient.make.bootstrapLimit", bootstrapLimit, defaultBootstrapLimit)
        const cursor = cursorMap(options.cursors)
        // The contract: the effective cursor is `max(caller, acknowledged)`
        // per run. The shared map used to win in BOTH directions, which broke
        // the promise this client is built on from either side — a caller that
        // restored its own progress was regressed and re-received entries it
        // had already materialized, and a caller asking for history the client
        // had already acknowledged was silently fast-forwarded past it.
        //
        // Dedupe wins the tie because it is the promise every consumer of a
        // shared client already depends on: an entry is never re-read, and the
        // subscriptions sharing this map would each have to re-decide what to
        // do about a redelivery if one of them could rewind it. Rebuilding a
        // projection from an older position is a different object, and it has
        // an exact answer: construct a fresh client, whose acknowledged map is
        // empty, so the caller's cursor is the only one there is.
        for (const [runId, afterSeq] of yield* Ref.get(acknowledged)) {
          const supplied = cursor.get(runId)
          if (supplied === undefined || supplied < afterSeq) cursor.set(runId, afterSeq)
        }

        const snapshot = (): WorkspaceCursor => canonicalCursors(cursor)

        const commit = (runId: JournalEvent.RunId, throughSeq: JournalEvent.Seq) =>
          Effect.sync(() => {
            cursor.set(runId, throughSeq)
          }).pipe(
            Effect.andThen(Ref.update(acknowledged, (shared) => advance(shared, runId, throughSeq)))
          )

        const applyEntry = options.apply

        /**
         * Hands one entry to the consumer and moves its cursor.
         *
         * With an `apply` callback the cursor moves only after the callback
         * succeeds, so a cursor names what the consumer materialized. Without
         * one it moves as the entry is admitted, which is the weaker promise
         * this client has always made and the one `RunCursor`'s JSDoc now
         * states.
         */
        const deliver = (
          runId: JournalEvent.RunId,
          entry: JournalEvent.Entry
        ): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.concat(
            Stream.drain(Stream.fromEffect(
              applyEntry === undefined
                ? commit(runId, entry.seq)
                : Effect.andThen(applyEntry(entry), commit(runId, entry.seq))
            )),
            Stream.succeed(entry)
          )

        const batch = (frame: EntriesFrame): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> => {
          const frameBytes = entriesByteLength(frame.entries)
          if (frameBytes > maxFrameBytes) return Stream.fail(oversized(frameBytes, maxFrameBytes))
          const violation = frameViolation(frame)
          if (violation !== undefined) return Stream.fail(violation)
          const afterSeq: number = cursor.get(frame.runId) ?? -1
          // `fromSeq` is the start of the server-declared covered interval. It is
          // intentionally compared to the cursor, not to the first entry's seq:
          // dropped journal admissions legitimately leave holes inside that range.
          if (frame.fromSeq > afterSeq + 1) {
            return Stream.fail(
              new SyncGapError({
                runId: frame.runId,
                expectedFrom: (afterSeq + 1) as JournalEvent.Seq,
                receivedFrom: frame.fromSeq
              })
            )
          }
          if (frame.toSeq <= afterSeq) return Stream.empty

          const entries = frame.entries.filter((entry) => entry.seq > afterSeq)
          return Stream.flatMap(Stream.fromIterable(entries), (entry) => deliver(frame.runId, entry))
        }

        const livePage = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.unwrap(
            Effect.sync(() =>
              client["Sync.Subscribe"]({
                scope: options.scope,
                cursors: snapshot(),
                credit,
                ...(options.capability === undefined ? {} : { capability: options.capability })
              })
            )
          ).pipe(
            Stream.mapError(transportError),
            Stream.flatMap((frame) => {
              switch (frame._tag) {
                case "Entries":
                  return batch(frame)
                case "Closed":
                  return Stream.fail(new SyncError({ code: "closed", message: "Sync subscription closed" }))
                default:
                  return Stream.empty
              }
            })
          )

        const live = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.concat(
            livePage(),
            Stream.unwrap(Effect.sync(live))
          )

        // The retry re-runs the whole follow from the acknowledged cursors,
        // and its schedule resets once entries flow again, so a long-lived
        // subscription pays the backoff only across consecutive failures.
        const follow = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          live().pipe(
            Stream.tapCause((cause) =>
              isTransportCause(cause)
                ? Effect.logWarning("sync live follow transport failed; reconnecting with backoff", cause)
                : Effect.void
            ),
            Stream.retry(reconnectPolicy)
          )

        const bootstrap = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.unwrap(
            // SUSPENDED, exactly as `livePage` is. Building the payload where
            // the recursive call is written snapshotted the cursors as page N
            // was mapped, before a single one of its entries had reached
            // `commit` — so read N+1 carried read N's request cursors and the
            // server correctly re-served the page it had just served. Every
            // catch-up page past the first arrived twice.
            Effect.suspend(() => {
              const requested = snapshot()
              return client["Sync.Read"]({
                scope: options.scope,
                cursors: requested,
                limit: bootstrapLimit,
                ...(options.capability === undefined ? {} : { capability: options.capability })
              }).pipe(
                Effect.mapError(transportError),
                Effect.map((response) => {
                  const pageBytes = entriesByteLength(response.entries)
                  if (pageBytes > maxFrameBytes) return Stream.fail(oversized(pageBytes, maxFrameBytes))
                  const violation = pageViolation(options.scope, cursorMap(requested), response)
                  if (violation !== undefined) return Stream.fail(violation)
                  const page = Stream.flatMap(
                    Stream.fromIterable(response.entries),
                    (entry) => deliver(entry.runId, entry)
                  )
                  if (response.done) return Stream.concat(page, follow())
                  if (response.entries.length === 0) {
                    // An incomplete page with no entries can never converge:
                    // the next read would carry the same cursors and receive
                    // the same page. Fail typed instead of spinning.
                    return Stream.fail(
                      new SyncError({
                        code: "protocol_violation",
                        message: "Bootstrap read reported more durable entries but returned an empty page"
                      })
                    )
                  }
                  return Stream.concat(page, bootstrap())
                })
              )
            })
          )

        /**
         * The checkpoint one failure says to resume from, or `undefined` when
         * the failure is not a recoverable compaction.
         *
         * A compaction whose checkpoint is at or below what this subscription
         * already covers cannot move it forward, so retrying would re-read the
         * same refusal forever. That is the same non-convergence rule the
         * empty incomplete bootstrap page is refused under, and it is why a
         * `compacted` failure carrying no {@link Resync} stays a failure
         * rather than becoming a silent stall.
         */
        const resyncTarget = (failure: SyncError | SyncGapError): Resync | undefined => {
          if (!SyncError.is(failure) || failure.code !== "compacted" || failure.resync === undefined) {
            return undefined
          }
          const covered: number = cursor.get(failure.resync.runId) ?? -1
          return covered >= failure.resync.checkpointSeq ? undefined : failure.resync
        }

        /**
         * The subscription, restarted from a run's checkpoint whenever the
         * server refuses a cursor below that run's compaction floor.
         *
         * Compaction is opt-in today, but the day a workspace enables it this
         * is the difference between a follower that catches up and one that
         * never can: the refusal repeats for the same cursors, so without a
         * resync every resubscribe fails identically, and a whole-workspace
         * subscription dies over a single compacted run.
         *
         * The entries between the old cursor and the checkpoint are gone from
         * the journal and are therefore never delivered. That is a REAL hole
         * in what the consumer sees, so it is logged rather than absorbed: the
         * checkpoint state that stands for those entries is not carried on
         * this wire, and a consumer rebuilding a projection has to read it
         * from the journal's own `latestCheckpoint`.
         */
        const onResync = options.onResync ?? ((resync: Resync) =>
          Effect.logWarning(
            "sync follower resyncing a compacted run from its checkpoint; entries below it are gone"
          ).pipe(Effect.annotateLogs({ runId: resync.runId, checkpointSeq: resync.checkpointSeq })))

        const resynced = (): Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError> =>
          Stream.catch(bootstrap(), (failure) => {
            const resync = resyncTarget(failure)
            if (resync === undefined) return Stream.fail(failure)
            return Stream.unwrap(
              // The consumer's hook runs FIRST and must succeed. It is the
              // only point at which a projection can restore the prefix the
              // checkpoint stands for, and a failure here leaves the cursor
              // where it was, so nothing is skipped behind the consumer's
              // back.
              onResync(resync).pipe(
                // The cursor must move BEFORE the restart reads it: the
                // bootstrap snapshots the cursors as it is issued.
                Effect.andThen(commit(resync.runId, resync.checkpointSeq)),
                Effect.map(resynced)
              )
            )
          })

        return resynced()
      }))

    return Sync.of({ subscribe, cursors })
  })

/**
 * Provides a Sync client from the active RPC protocol.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Sync, never, RpcClient.Protocol> = Layer.effect(
  Sync,
  Effect.flatMap(RpcClient.make(SyncRpcs), (client) => make({ client }))
)
