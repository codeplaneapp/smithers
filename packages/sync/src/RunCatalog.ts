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
 * Constructs a mutable in-memory run catalog.
 *
 * A run is published exactly once, when it is first registered.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeMemory = (): Effect.Effect<{
  readonly catalog: Service
  readonly register: (runId: JournalEvent.RunId) => Effect.Effect<void>
}> =>
  Effect.gen(function*() {
    const known = new Set<JournalEvent.RunId>()
    const changes = yield* PubSub.unbounded<JournalEvent.RunId>()
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
