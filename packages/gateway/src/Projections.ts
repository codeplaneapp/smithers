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
 * One snapshot reads the control plane exactly once. The rows, the cursor the
 * snapshot advertises, and the sequence its deltas start after all come from
 * that single read, so a client that follows the same selector from the
 * advertised cursor sees each later change exactly once. Reading twice let an
 * event that landed between the reads arrive both as a snapshot row and as a
 * delta.
 *
 * A subscription is a snapshot followed by deltas. A delta recomputes the
 * selector's rows from the accumulated events rather than patching them: a
 * projection is a reproducible fold (`@smthrs/journal` `Projection`), and
 * recomputation is the only delta that cannot disagree with a fresh snapshot.
 * The events are accumulated in the stream rather than re-read, so following a
 * run costs one journal read no matter how many deltas arrive.
 *
 * @since 1.0.0
 */
import type { Service as ControlService } from "@smthrs/control/Control"
import { Control } from "@smthrs/control/Control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Context, Effect, Layer, Stream } from "effect"
import { GatewayError, settingRefusal } from "./GatewayError.ts"
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
 * The most runs one workspace projection folds.
 *
 * A workspace projection reads one full journal per run, so the number of
 * runs it folds is bounded on purpose. This is the gateway's own ceiling, not
 * the control plane's default page size. It is 500 because that equals
 * `ControlSchema.maxPageSize`, letting the control plane satisfy the whole
 * gateway allowance in one page when it can.
 *
 * @since 1.0.0
 * @category models
 */
export const maxWorkspaceRuns = 500

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
  /**
   * A snapshot followed by recomputed deltas and keepalive frames, or, when
   * `after` names a cursor this selector issued, the deltas after it alone.
   */
  readonly subscribe: (
    selector: GatewaySchema.ProjectionSelector,
    after?: GatewaySchema.ProjectionCursor | undefined
  ) => Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>
}

/**
 * The gateway read path.
 *
 * @since 1.0.0
 * @category services
 */
export class Projections extends Context.Service<Projections, Service>()("@smthrs/gateway/Projections") {}

/**
 * The part of a control-plane failure a client is allowed to see: the failure's
 * tag and its stable code, never its message, its nested cause, or the SQL and
 * file paths a `PersistenceError` carries.
 *
 * The whole cause is logged server-side instead. `GatewayError` is the RPC
 * error schema, so anything left on it is serialized to every bearer holder and
 * forwarded to the browser by the product relay, and a cause JSON cannot encode
 * would make the error frame itself fail to encode.
 */
const summarize = (cause: unknown): { readonly _tag: string; readonly code?: string } | undefined => {
  const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : undefined
  if (record === undefined || typeof record._tag !== "string") return undefined
  return typeof record.code === "string" ? { _tag: record._tag, code: record.code } : { _tag: record._tag }
}

/** The read failed. The client learns that much; the log learns the rest. */
const unavailable = (message: string, cause: unknown): GatewayError => {
  const summary = summarize(cause)
  return new GatewayError({
    code: "run_unavailable",
    message,
    ...(summary === undefined ? {} : { cause: summary })
  })
}

/** The request named something the control plane cannot serve. */
const malformed = (message: string): GatewayError => new GatewayError({ code: "malformed_request", message })

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

/** One run and the journal it has committed, read together and read once. */
interface RunSource {
  readonly run: ControlSchema.RunSummary
  readonly events: ReadonlyArray<ControlSchema.ControlEvent>
}

/** Everything a selector folds, read once per snapshot. */
type Source =
  | { readonly _tag: "run"; readonly run: RunSource }
  | { readonly _tag: "workspace"; readonly runs: ReadonlyArray<RunSource> }

/**
 * The rows one run contributes to a selector.
 *
 * Pure and total over facts already read: it never reads the control plane, so
 * a delta folded from accumulated events and a fresh snapshot compute the same
 * rows from the same events. `workspace-runs` appears here because a workspace
 * listing is one summary row per run, folded by this same function.
 */
const rowsOfRun = (
  selector: GatewaySchema.ProjectionSelector,
  source: RunSource
): ReadonlyArray<unknown> => {
  switch (selector._tag) {
    case "workspace-runs":
    case "run-summary":
      return [GatewayProjection.runSummary(source.run, source.events)]
    case "run-tree":
      return GatewayProjection.runTree(source.run, source.events)
    case "run-events":
      return source.events
    case "transcript":
      return GatewayProjection.transcript(source.events)
    case "approvals":
      return GatewayProjection.approvals(source.events)
    case "node-output":
      return GatewayProjection.nodeOutput(source.events).filter((row) => row.nodeId === selector.nodeId)
  }
}

/**
 * The rows a workspace selector projects across every run it read.
 *
 * The approvals inbox is the exception: a run card wants a run's decided gates
 * too, but an inbox wants only what a human still owes an answer to.
 */
const rowsOfWorkspace = (
  selector: GatewaySchema.ProjectionSelector,
  runs: ReadonlyArray<RunSource>
): ReadonlyArray<unknown> =>
  selector._tag === "approvals"
    ? runs.flatMap((source) => GatewayProjection.approvals(source.events).filter((row) => row.status === "pending"))
    : runs.flatMap((source) => rowsOfRun(selector, source))

/** The rows a selector projects from the facts one read produced. */
const rowsOf = (
  selector: GatewaySchema.ProjectionSelector,
  source: Source
): ReadonlyArray<unknown> =>
  source._tag === "run" ? rowsOfRun(selector, source.run) : rowsOfWorkspace(selector, source.runs)

/**
 * The cursor the read reached.
 *
 * A run's cursor is the last sequence its journal committed, taken from the
 * same array the rows were folded from. A workspace cursor is `0`: control
 * journal sequences belong to per-run partitions (`@smthrs/control`
 * `ControlLive.streamForRun` and `snapshotHighWater` are keyed by `runId`), so
 * there is no workspace-wide sequence to advertise and no workspace resume.
 */
const cursorValueOf = (source: Source): number => source._tag === "run" ? source.run.events.at(-1)?.sequence ?? 0 : 0

/**
 * Builds the read path over a control plane.
 *
 * A keepalive cadence that is not a positive safe integer is refused here, by
 * raising the `bind_failed` `GatewayError` {@link GatewayError.settingRefusal}
 * builds: zero or a negative cadence turns the keepalive into a tight loop that
 * floods every subscriber.
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
  const refusal = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis)
  if (refusal !== undefined) throw refusal
  const heartbeatMillis = options.heartbeatMillis ?? heartbeatIntervalMillis

  /** Every committed event of one run, oldest first. */
  const eventsOf = (runId: string): Effect.Effect<ReadonlyArray<ControlSchema.ControlEvent>, GatewayError> => {
    const message = `Reading the events of ${runId} failed`
    return Stream.runCollect(control.watch({ runId, follow: false })).pipe(
      Effect.tapError((cause) => Effect.logWarning(message, cause)),
      Effect.mapError((cause) => unavailable(message, cause))
    )
  }

  const runsMatching = (
    filters: { readonly runId?: string; readonly status?: ControlSchema.RunStatus }
  ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> => {
    const singleRun = filters.runId !== undefined
    const ceiling = singleRun ? 1 : maxWorkspaceRuns
    const page = (
      accumulated: ReadonlyArray<ControlSchema.RunSummary>,
      cursor?: string | undefined
    ): Effect.Effect<ReadonlyArray<ControlSchema.RunSummary>, GatewayError> => {
      const remaining = ceiling - accumulated.length
      return control.list({
        _tag: "runs",
        filters,
        limit: remaining,
        ...(cursor === undefined ? {} : { cursor })
      }).pipe(
        Effect.tapError((cause) => Effect.logWarning("Listing runs failed", cause)),
        Effect.mapError((cause) => unavailable("Listing runs failed", cause)),
        Effect.flatMap((response) => {
          if (response._tag !== "runs") return Effect.succeed(accumulated)
          const runs = [...accumulated, ...response.items.slice(0, remaining)]
          return singleRun || response.nextCursor === undefined || runs.length >= ceiling
            ? Effect.succeed(runs)
            : page(runs, response.nextCursor)
        })
      )
    }
    return Effect.suspend(() => page([]))
  }

  /**
   * The one run a run-scoped selector names, or a typed refusal.
   *
   * Every run-scoped selector goes through here, so an unknown run id is
   * refused the same way for all of them. Reading a run's events alone cannot
   * tell an unknown run from a run with no events: `@smthrs/control`
   * `ControlLive.snapshotForRun` answers an empty stream for both.
   */
  const runOf = (runId: string): Effect.Effect<ControlSchema.RunSummary, GatewayError> =>
    runsMatching({ runId }).pipe(
      Effect.flatMap((runs) => {
        const run = runs.find((candidate) => candidate.runId === runId)
        return run === undefined
          ? Effect.fail(new GatewayError({ code: "run_not_found", message: `No run ${runId}` }))
          : Effect.succeed(run)
      })
    )

  /** One run and its journal. */
  const runSourceOf = (runId: string): Effect.Effect<RunSource, GatewayError> =>
    Effect.map(Effect.all([runOf(runId), eventsOf(runId)]), ([run, events]) => ({ run, events }))

  /** Every run a workspace selector folds, and each one's journal. */
  const workspaceSourceOf = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<ReadonlyArray<RunSource>, GatewayError> =>
    Effect.flatMap(
      // The inbox asks the control plane which runs are parked rather than
      // reading every run's journal to find out.
      runsMatching(selector._tag === "approvals" ? { status: "waiting-approval" } : {}),
      (runs) => Effect.forEach(runs, (run) => Effect.map(eventsOf(run.runId), (events) => ({ run, events })))
    )

  /** The one read a snapshot performs. */
  const sourceOf = (selector: GatewaySchema.ProjectionSelector): Effect.Effect<Source, GatewayError> => {
    const runId = scopeOf(selector)
    return runId === undefined
      ? Effect.map(workspaceSourceOf(selector), (runs) => ({ _tag: "workspace" as const, runs }))
      : Effect.map(runSourceOf(runId), (run) => ({ _tag: "run" as const, run }))
  }

  const snapshot = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
    Effect.map(sourceOf(selector), (source) => ({
      cursor: cursorOf(selector, cursorValueOf(source)),
      rows: rowsOf(selector, source)
    }))

  const snapshotFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    const cursor = cursorOf(selector, cursorValueOf(source))
    return Stream.fromIterable<GatewaySchema.GatewayFrame>([
      { _tag: "snapshot-start", selector, cursor },
      ...rowsOf(selector, source).map((row): GatewaySchema.GatewayFrame => ({ _tag: "row", selector, cursor, row })),
      { _tag: "snapshot-end", selector, cursor }
    ])
  }

  /**
   * The rows one delta carries.
   *
   * `run-events`' rows are the ordered events themselves, so its delta is the
   * one event that arrived. Every other selector answers a full replacement
   * folded from the accumulated events, because recomputation is the only
   * delta that cannot disagree with a fresh snapshot. Only the two selectors
   * whose rows read the run row re-read it: a fenced status write does not
   * always journal an event, so their status would otherwise lag.
   */
  const deltaRows = (
    selector: GatewaySchema.ProjectionSelector,
    run: ControlSchema.RunSummary,
    event: ControlSchema.ControlEvent,
    events: ReadonlyArray<ControlSchema.ControlEvent>
  ): Effect.Effect<ReadonlyArray<unknown>, GatewayError> => {
    if (selector._tag === "run-events") return Effect.succeed([event])
    if (selector._tag === "run-summary" || selector._tag === "run-tree") {
      return Effect.map(runOf(run.runId), (fresh) => rowsOfRun(selector, { run: fresh, events }))
    }
    return Effect.succeed(rowsOfRun(selector, { run, events }))
  }

  /**
   * Deltas for one run, following from `from` and folding over the events the
   * caller already read plus each event that arrives.
   *
   * Nothing here re-reads the journal. Re-reading the history for every event
   * made a subscription quadratic in run length and re-sent the whole log on
   * each frame, which is the opposite of what a follower asked for.
   */
  const runDeltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: RunSource,
    from: number
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    const runId = source.run.runId
    const message = `Following ${runId} failed`
    // A resume starts behind the read, so the fold is seeded with the events up
    // to the cursor and the stream replays the rest as deltas.
    const seed = source.events.filter((event) => event.sequence <= from)
    return control.watch({ runId, afterSequence: from, follow: true }).pipe(
      Stream.tapError((cause) => Effect.logWarning(message, cause)),
      Stream.mapError((cause) => unavailable(message, cause)),
      Stream.mapAccum(
        () => seed,
        (accumulated: ReadonlyArray<ControlSchema.ControlEvent>, event: ControlSchema.ControlEvent) => {
          const events = [...accumulated, event]
          return [events, [{ event, events }]] as const
        }
      ),
      Stream.mapEffect(({ event, events }) =>
        Effect.map(
          deltaRows(selector, source.run, event, events),
          (rows): GatewaySchema.GatewayFrame => ({
            _tag: "delta",
            selector,
            cursor: cursorOf(selector, event.sequence),
            delta: rows
          })
        )
      )
    )
  }

  /**
   * Deltas for a selector.
   *
   * A workspace selector has no cursor to follow from, because control journal
   * sequences belong to per-run partitions, so its subscription is the snapshot
   * plus keepalives and a client refreshes it by re-subscribing.
   */
  const deltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    from: number
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    source._tag === "workspace" ? Stream.never : runDeltaFrames(selector, source.run, from)

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

  /** The run a cursor resumes, or the refusal explaining why it resumes none. */
  const resumeScope = (
    selector: GatewaySchema.ProjectionSelector,
    after: GatewaySchema.ProjectionCursor
  ): string | GatewayError => {
    const runId = scopeOf(selector)
    if (after.projection !== selector._tag) {
      return malformed(
        `A cursor for the ${after.projection} projection cannot resume a ${selector._tag} subscription`
      )
    }
    if (runId === undefined) {
      return malformed(
        `A ${selector._tag} subscription has no resumable cursor, because control journal sequences belong to per-run partitions`
      )
    }
    if (after.runId !== runId) {
      return malformed(`A cursor for run ${after.runId ?? "none"} cannot resume a subscription to run ${runId}`)
    }
    return runId
  }

  /** The snapshot and the deltas that follow it, off one read. */
  const fromSnapshot = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>, GatewayError> =>
    Effect.map(sourceOf(selector), (source) =>
      Stream.concat(
        snapshotFrames(selector, source),
        deltaFrames(selector, source, cursorValueOf(source))
      ))

  /**
   * The deltas after a cursor the client already holds, with no snapshot.
   *
   * The read still happens: a folded projection cannot be recomputed from the
   * events after the cursor alone. What the client skips is receiving rows it
   * already has.
   */
  const fromCursor = (
    selector: GatewaySchema.ProjectionSelector,
    after: GatewaySchema.ProjectionCursor
  ): Effect.Effect<Stream.Stream<GatewaySchema.GatewayFrame, GatewayError>, GatewayError> => {
    const scope = resumeScope(selector, after)
    return typeof scope === "string"
      ? Effect.map(runSourceOf(scope), (source) => runDeltaFrames(selector, source, after.value))
      : Effect.fail(scope)
  }

  const subscribe = (
    selector: GatewaySchema.ProjectionSelector,
    after?: GatewaySchema.ProjectionCursor | undefined
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.merge(
      Stream.unwrap(after === undefined ? fromSnapshot(selector) : fromCursor(selector, after)),
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
