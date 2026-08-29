/**
 * Workspace run enumeration for synchronization.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"

/**
 * Workspace run enumeration operations.
 *
 * // TODO(port): supplied by Gateway/host until @smthrs/journal exposes a workspace list/watch contract.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly list: Effect.Effect<ReadonlyArray<JournalEvent.RunId>>
  readonly changes: Stream.Stream<JournalEvent.RunId>
}

/**
 * Host-provided workspace run catalog.
 *
 * @category services
 * @since 0.1.0
 */
export class RunCatalog extends Context.Service<RunCatalog, Service>()("@smthrs/sync/RunCatalog") {}

/**
 * Constructs a run catalog service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => RunCatalog.of(implementation)

/**
 * Provides an immutable run catalog.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerStatic = (
  ids: ReadonlyArray<JournalEvent.RunId>
): Layer.Layer<RunCatalog> =>
  Layer.succeed(
    RunCatalog,
    make({
      list: Effect.succeed(Array.from(new Set(ids))),
      changes: Stream.empty
    })
  )

/**
 * Announcements a stalled {@link Service.changes} subscriber may fall behind
 * by before the oldest are dropped.
 *
 * `changes` is a notification feed, not a log: a follower reads it to learn
 * that the workspace gained a run and then reads the run itself. Retaining an
 * unbounded backlog for a subscriber that has stopped pulling — a disconnected
 * tab whose socket has not timed out yet, a follower blocked behind a slow
 * consumer — is therefore pure cost, and the workspace's whole run history is
 * the upper bound on it. A subscriber that falls further behind than this
 * bound loses the oldest announcements; `list` still names every run, so a
 * follower that reconnects or re-lists converges.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultChangesCapacity = 1024

/**
 * Options for the in-memory run catalog.
 *
 * @category models
 * @since 0.1.0
 */
export interface MemoryOptions {
  /**
   * Announcements a stalled subscriber may fall behind by. Defaults to
   * {@link defaultChangesCapacity}.
   */
  readonly changesCapacity?: number | undefined
}

/**
 * Constructs a mutable in-memory run catalog.
 *
 * A run is published exactly once, when it is first registered. The
 * announcement feed slides: registering never waits on a stalled subscriber,
 * and never grows the process on its behalf.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (options: MemoryOptions = {}): Effect.Effect<{
  readonly catalog: Service
  readonly register: (runId: JournalEvent.RunId) => Effect.Effect<void>
}> =>
  Effect.gen(function*() {
    const known = new Set<JournalEvent.RunId>()
    const changes = yield* PubSub.sliding<JournalEvent.RunId>(
      options.changesCapacity ?? defaultChangesCapacity
    )
    return {
      catalog: make({
        list: Effect.fn("RunCatalog.list")(() => Effect.sync(() => Array.from(known)))(),
        changes: Stream.fromPubSub(changes)
      }),
      register: Effect.fn("RunCatalog.register")((runId) =>
        Effect.suspend(() => {
          if (known.has(runId)) return Effect.void
          known.add(runId)
          return PubSub.publish(changes, runId).pipe(Effect.asVoid)
        })
      )
    }
  })

/**
 * Provides an empty run catalog.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<RunCatalog> = layerStatic([])
