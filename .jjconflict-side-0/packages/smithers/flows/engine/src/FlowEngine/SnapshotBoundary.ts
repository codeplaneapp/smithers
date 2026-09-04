// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The host snapshot boundary compensable actions are executed against.
 *
 * @since 0.1.0
 */
import type { Flow } from "@smthrs/flow"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

/**
 * Context passed to a compensable action snapshot boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SnapshotBoundaryOptions {
  readonly flow: Flow.Any
  readonly executionId: string
  readonly key: string
  readonly attempt: number
  readonly metadata: unknown
}

/**
 * Minimal host snapshot boundary required by compensable actions.
 *
 * TODO(piece-6): bind to @smthrs/kernel Jj in @smthrs/engine-store.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class SnapshotBoundary extends Context.Service<
  SnapshotBoundary,
  {
    readonly snapshot: (options: SnapshotBoundaryOptions) => Effect.Effect<unknown>
    readonly restore: (
      snapshot: unknown,
      options: SnapshotBoundaryOptions
    ) => Effect.Effect<void>
    readonly diff: (
      snapshot: unknown,
      options: SnapshotBoundaryOptions
    ) => Effect.Effect<unknown>
  }
>()("@smthrs/engine/FlowEngine/SnapshotBoundary") {}
