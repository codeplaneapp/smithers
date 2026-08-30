/**
 * The gateway read path: served projections computed from the control plane.
 *
 * Every projection here is a fold over facts `@smthrs/control` already
 * publishes: `Control.list` for run and flow listings, `Control.watch` for a
 * run's ordered events. The gateway never opens the engine database, so a
 * projection served to a browser through a relay is the same projection a
 * local reader computes, and a projection cannot drift from the control plane
 * by reading a column the control plane does not expose.
 *
 * A subscription is a snapshot followed by deltas. A delta recomputes the
 * selector's rows from the accumulated events rather than patching them: a
 * projection is a reproducible fold (`@smthrs/journal` `Projection`), and
 * recomputation is the only delta that cannot disagree with a fresh snapshot.
 *
 * @since 1.0.0
 */
import type { Service as ControlService } from "@smthrs/control/Control"
import { Control } from "@smthrs/control/Control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Context, Effect, Layer, Stream } from "effect"
import { GatewayError } from "./GatewayError.ts"
import * as GatewayProjection from "./GatewayProjection.ts"
import type * as GatewaySchema from "./GatewaySchema.ts"

/**
 * How often an idle subscription emits a keepalive frame.
 *
 * Plue's relay cuts an idle tunnel at 600 s (plue-consumer-contract §11), so a
 * quiet run must produce a frame well inside that window or the connection is
 * dropped and every follower reconnects. Thirty seconds leaves twenty
 * heartbeats of margin.
 *
 * @since 1.0.0
 * @category models
 */
export const heartbeatIntervalMillis = 30_000

/**
 * Read-path operations served by the gateway.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  /** Every row the selector currently projects, and the cursor they were read at. */
  readonly snapshot: (
    selector: GatewaySchema.ProjectionSelector
  ) => Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError>
  /** A snapshot followed by recomputed deltas and keepalive frames. */
  readonly subscribe: (
    selector: GatewaySchema.ProjectionSelector
  ) => Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>
}

/**
 * The gateway read path.
 *
 * @since 1.0.0
 * @category services
 */
export class Projections extends Context.Service<Projections, Service>()("@smthrs/gateway/Projections") {}

const unavailable = (message: string, cause: unknown): GatewayError =>
  new GatewayError({ code: "run_unavailable", message, cause })

/** The run a selector is scoped to, or undefined for a workspace selector. */
const scopeOf = (selector: GatewaySchema.ProjectionSelector): string | undefined =>
  "runId" in selector ? selector.runId : undefined

const cursorOf = (
  selector: GatewaySchema.ProjectionSelector,
  value: number
): GatewaySchema.ProjectionCursor => ({
  projection: selector._tag,
  runId: scopeOf(selector) ?? null,
  value
})

/**
 * Builds the read path over a control plane.
 *
 * @param control the control service to read through
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category constructors
 */
export const make = (
  control: ControlService,
  options: { readonly heartbeatMillis?: number | undefined } = {}
): Service => {
  const heartbeatMillis = options.heartbeatMillis ?? heartbeatIntervalMillis

  /** Every committed event of one run, oldest first. */
  const eventsOf = (runId: string): Effect.Effect<ReadonlyArray<ControlSchema.ControlEvent>, GatewayError> =>
    Stream.runCollect(control.watch({ runId, follow: false })).pipe(
      Effect.mapError((cause) => unavailable(`Reading the events of ${runId} failed`, cause))
    )

  const runsMatching = (
    filters: { readonly runId?: string; readonly status?: ControlSchema.RunStatus }
  ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> =>
    control.list({ _tag: "runs", filters }).pipe(
      Effect.mapError((cause) => unavailable("Listing runs failed", cause)),
      Effect.map((response) => response._tag === "runs" ? response.items : [])
    )

  /** The one run a run-scoped selector names, or a typed refusal. */
  const runOf = (runId: string): Effect.Effect<ControlSchema.RunSummary, GatewayError> =>
    runsMatching({ runId }).pipe(
      Effect.flatMap((runs) => {
        const run = runs.find((candidate) => candidate.runId === runId)
        return run === undefined
          ? Effect.fail(new GatewayError({ code: "run_unavailable", message: `No run ${runId}`, cause: runId }))
          : Effect.succeed(run)
      })
    )

  const workspaceRuns: Effect.Effect<ReadonlyArray<GatewayProjection.RunSummaryRow>, GatewayError> = Effect.gen(
    function*() {
      const runs = yield* runsMatching({})
      return yield* Effect.forEach(
        runs,
        (run) => Effect.map(eventsOf(run.runId), (events) => GatewayProjection.runSummary(run, events))
      )
    }
  )

  const pendingApprovals: Effect.Effect<ReadonlyArray<GatewayProjection.ApprovalRow>, GatewayError> = Effect.gen(
    function*() {
      const runs = yield* runsMatching({ status: "waiting-approval" })
      const perRun = yield* Effect.forEach(
        runs,
        (run) =>
          Effect.map(
            eventsOf(run.runId),
            (events) => GatewayProjection.approvals(events).filter((row) => row.status === "pending")
          )
      )
      return perRun.flat()
    }
  )

  const rowsFor = (selector: GatewaySchema.ProjectionSelector): Effect.Effect<ReadonlyArray<unknown>, GatewayError> => {
    switch (selector._tag) {
      case "workspace-runs":
        return workspaceRuns
      case "approvals":
        return selector.runId === undefined
          ? pendingApprovals
          : Effect.map(eventsOf(selector.runId), GatewayProjection.approvals)
      case "run-summary":
        return Effect.map(
          Effect.all([runOf(selector.runId), eventsOf(selector.runId)]),
          ([run, events]) => [GatewayProjection.runSummary(run, events)]
        )
      case "run-tree":
        return Effect.map(
          Effect.all([runOf(selector.runId), eventsOf(selector.runId)]),
          ([run, events]) => GatewayProjection.runTree(run, events)
        )
      case "run-events":
        return eventsOf(selector.runId)
      case "transcript":
        return Effect.map(eventsOf(selector.runId), GatewayProjection.transcript)
      case "node-output":
        return Effect.map(
          eventsOf(selector.runId),
          (events) => GatewayProjection.nodeOutput(events).filter((row) => row.nodeId === selector.nodeId)
        )
      case "plan-cards":
        return Effect.fail(
          new GatewayError({
            code: "unsupported_projection",
            message: "plan-cards is not served at 1.0.0-rc.0: a plan card is returned by Control.plan, not projected",
            cause: selector
          })
        )
    }
  }

  /** The highest committed sequence a selector's scope has reached. */
  const cursorValue = (selector: GatewaySchema.ProjectionSelector): Effect.Effect<number, GatewayError> => {
    const runId = scopeOf(selector)
    return runId === undefined
      ? Effect.succeed(0)
      : Effect.map(eventsOf(runId), (events) => events.at(-1)?.sequence ?? 0)
  }

  const snapshot = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
    Effect.map(
      Effect.all([rowsFor(selector), cursorValue(selector)]),
      ([rows, value]) => ({ cursor: cursorOf(selector, value), rows })
    )

  const snapshotFrames = (
    selector: GatewaySchema.ProjectionSelector
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.unwrap(
      Effect.map(snapshot(selector), ({ cursor, rows }) =>
        Stream.fromIterable<GatewaySchema.GatewayFrame>([
          { _tag: "snapshot-start", selector, cursor },
          ...rows.map((row): GatewaySchema.GatewayFrame => ({ _tag: "row", selector, cursor, row })),
          { _tag: "snapshot-end", selector, cursor }
        ]))
    )

  /**
   * Deltas for a run-scoped selector. A workspace selector has no single
   * event stream to follow, so its subscription is the snapshot plus
   * keepalives; a client refreshes it by re-subscribing.
   *
   * A folded selector recomputes its whole row set per event, because a
   * projection is a reproducible fold and recomputation is the only delta that
   * cannot disagree with a fresh snapshot. `run-events` is the exception: its
   * rows ARE the ordered events, so its delta is the one event that arrived.
   * Re-reading the history for every event made a subscription quadratic in
   * run length and re-sent the whole log on each frame, which is the opposite
   * of what a follower asked for.
   */
  const deltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    after: number
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    const runId = scopeOf(selector)
    if (runId === undefined) return Stream.never
    const delta = (event: ControlSchema.ControlEvent): Effect.Effect<ReadonlyArray<unknown>, GatewayError> =>
      selector._tag === "run-events" ? Effect.succeed([event]) : rowsFor(selector)
    return control.watch({ runId, afterSequence: after, follow: true }).pipe(
      Stream.mapError((cause) => unavailable(`Following ${runId} failed`, cause)),
      Stream.mapEffect((event) =>
        Effect.map(delta(event), (rows): GatewaySchema.GatewayFrame => ({
          _tag: "delta",
          selector,
          cursor: cursorOf(selector, event.sequence),
          delta: rows
        }))
      )
    )
  }

  /**
   * The keepalive channel. `Stream.tick` emits immediately and then on the
   * interval, and an immediate keepalive would arrive before the snapshot it
   * is supposed to keep alive; dropping the first tick makes the cadence what
   * it says it is.
   */
  const heartbeats: Stream.Stream<GatewaySchema.GatewayFrame> = Stream.tick(heartbeatMillis).pipe(
    Stream.drop(1),
    Stream.mapEffect(() =>
      Effect.map(Effect.clockWith((clock) => clock.currentTimeMillis), (atMs) => ({
        _tag: "heartbeat" as const,
        atMs
      }))
    )
  )

  const subscribe = (
    selector: GatewaySchema.ProjectionSelector
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.merge(
      Stream.unwrap(
        Effect.map(cursorValue(selector), (value) =>
          Stream.concat(snapshotFrames(selector), deltaFrames(selector, value)))
      ),
      heartbeats,
      { haltStrategy: "left" }
    )

  return { snapshot, subscribe }
}

/**
 * Provides the gateway read path over the ambient control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<Projections, never, Control> = Layer.effect(Projections)(
  Effect.map(Control, (control) => make(control))
)

/**
 * Provides the gateway read path under an explicit keepalive cadence.
 *
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category layers
 */
export const layerWith = (
  options: { readonly heartbeatMillis?: number | undefined }
): Layer.Layer<Projections, never, Control> =>
  Layer.effect(Projections)(Effect.map(Control, (control) => make(control, options)))
