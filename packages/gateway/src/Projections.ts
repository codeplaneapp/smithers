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
 * A workspace subscription follows every journal partition without a cursor.
 * Control replays each partition's history before tailing it, so the follower
 * seeds one last sequence per snapshotted run and drops that replayed prefix.
 * It admits an unseen run with one read until the same run ceiling as the
 * snapshot, keeping a live view inside the snapshot's cost model.
 *
 * @since 1.0.0
 */
import type { Service as ControlService } from "@smthrs/control/Control"
import { Control } from "@smthrs/control/Control"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { GatewayError, settingRefusal } from "./GatewayError.ts"
import * as GatewayProjection from "./GatewayProjection.ts"
import * as GatewaySchema from "./GatewaySchema.ts"

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
 * The most journal events one run projection admits.
 *
 * @since 1.0.0
 * @category models
 */
export const maxEventsPerRun = 10_000

/**
 * The largest encoded event history or projected row set one run admits.
 *
 * @since 1.0.0
 * @category models
 */
export const maxProjectionBytes = 4 * 1024 * 1024

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

/** A projection exceeded the bounded read or wire budget. */
const resourceLimit = (message: string): GatewayError => new GatewayError({ code: "resource_limit", message })

/** The run a selector is scoped to, or undefined for a workspace selector. */
const scopeOf = (selector: GatewaySchema.ProjectionSelector): string | undefined =>
  "runId" in selector ? selector.runId : undefined

interface CursorPosition {
  readonly value: number
  readonly offset: number
}

interface EventBuffer {
  readonly events: Array<ControlSchema.ControlEvent>
  readonly encodedBytes: number
  readonly lastSequence: number
}

const emptyEventBuffer = (): EventBuffer => ({ events: [], encodedBytes: 2, lastSequence: 0 })

const textEncoder = new TextEncoder()

const decodeEvent = Schema.decodeUnknownSync(ControlSchema.ControlEvent)
const decodeFrame = Schema.decodeUnknownSync(GatewaySchema.GatewayFrame)
const decodeSnapshot = Schema.decodeUnknownSync(GatewaySchema.ProjectionSnapshot)

const decodedEvent = (
  candidate: unknown,
  message: string
): Effect.Effect<ControlSchema.ControlEvent, GatewayError> =>
  Effect.suspend(() => {
    try {
      const event = decodeEvent(candidate)
      return Number.isSafeInteger(event.sequence) && event.sequence >= 0
        ? Effect.succeed(event)
        : Effect.fail(unavailable(message, undefined))
    } catch (cause) {
      return Effect.fail(unavailable(message, cause))
    }
  })

const appendEvent = (
  state: EventBuffer,
  candidate: unknown,
  message: string
): Effect.Effect<EventBuffer, GatewayError> =>
  Effect.flatMap(decodedEvent(candidate, message), (event) => {
    if (state.events.length > 0 && event.sequence < state.lastSequence) {
      return Effect.fail(unavailable(message, undefined))
    }
    // `decodedEvent` has already rebuilt payload through `Schema.Json`, so it
    // contains neither accessors nor `toJSON` hooks and JSON encoding cannot
    // execute caller code here.
    const bytes = textEncoder.encode(JSON.stringify(event)).byteLength
    const count = state.events.length + 1
    const encodedBytes = state.encodedBytes + bytes + (state.events.length === 0 ? 0 : 1)
    if (count > maxEventsPerRun) {
      return Effect.fail(resourceLimit(`Run event history exceeds ${maxEventsPerRun} events`))
    }
    if (!Number.isSafeInteger(encodedBytes) || encodedBytes > maxProjectionBytes) {
      return Effect.fail(resourceLimit(`Run event history exceeds ${maxProjectionBytes} encoded bytes`))
    }
    state.events.push(event)
    return Effect.succeed({
      events: state.events,
      encodedBytes,
      lastSequence: event.sequence
    })
  })

const bufferOf = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  message: string
): Effect.Effect<EventBuffer, GatewayError> =>
  events.reduce(
    (state, event) => Effect.flatMap(state, (buffer) => appendEvent(buffer, event, message)),
    Effect.succeed(emptyEventBuffer()) as Effect.Effect<EventBuffer, GatewayError>
  )

const cursorOf = (
  selector: GatewaySchema.ProjectionSelector,
  position: CursorPosition
): GatewaySchema.ProjectionCursor => ({
  selector,
  projection: selector._tag,
  runId: scopeOf(selector) ?? null,
  value: position.value,
  offset: position.offset
})

const comparePosition = (left: CursorPosition, right: CursorPosition): number =>
  left.value === right.value ? left.offset - right.offset : left.value - right.value

const positionedEvents = (
  events: ReadonlyArray<ControlSchema.ControlEvent>
): ReadonlyArray<{ readonly event: ControlSchema.ControlEvent; readonly position: CursorPosition }> => {
  let sequence = -1
  let offset = 0
  return events.map((event) => {
    offset = event.sequence === sequence ? offset + 1 : 0
    sequence = event.sequence
    return { event, position: { value: sequence, offset } }
  })
}

const lastPositionOf = (events: ReadonlyArray<ControlSchema.ControlEvent>): CursorPosition =>
  positionedEvents(events).at(-1)?.position ?? { value: 0, offset: 0 }

const sameSelector = (
  left: GatewaySchema.ProjectionSelector,
  right: GatewaySchema.ProjectionSelector
): boolean => {
  if (left._tag !== right._tag) return false
  switch (left._tag) {
    case "workspace-runs":
      return true
    case "approvals":
      return left.runId === (right as GatewaySchema.ApprovalsSelector).runId
    case "node-output": {
      const candidate = right as GatewaySchema.NodeOutputSelector
      return left.runId === candidate.runId && left.nodeId === candidate.nodeId
    }
    default:
      return left.runId === (right as GatewaySchema.RunSummarySelector).runId
  }
}

/** One run and the journal it has committed, read together and read once. */
interface RunSource {
  readonly run: ControlSchema.RunSummary
  readonly events: Array<ControlSchema.ControlEvent>
  readonly encodedBytes: number
  readonly lastSequence: number
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
  source: {
    readonly run: ControlSchema.RunSummary
    readonly events: ReadonlyArray<ControlSchema.ControlEvent>
  }
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

const boundedRows = (
  selector: GatewaySchema.ProjectionSelector,
  candidate: unknown
): Effect.Effect<ReadonlyArray<unknown>, GatewayError> =>
  Effect.suspend(() => {
    try {
      const schema = Schema.Array(GatewaySchema.rowSchemaFor(selector))
      const rows = Schema.decodeUnknownSync(schema)(candidate) as ReadonlyArray<unknown>
      const encoded = Schema.encodeUnknownSync(schema)(rows)
      const bytes = textEncoder.encode(JSON.stringify(encoded)).byteLength
      return bytes <= maxProjectionBytes
        ? Effect.succeed(rows)
        : Effect.fail(resourceLimit(`Projection rows exceed ${maxProjectionBytes} encoded bytes`))
    } catch (cause) {
      return Effect.fail(unavailable("Projection produced invalid rows", cause))
    }
  })

const frameOf = (candidate: unknown): Effect.Effect<GatewaySchema.GatewayFrame, GatewayError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decodeFrame(candidate))
      /* v8 ignore next -- rows, selectors, cursors, and tags were admitted before this internal assembly step. */
    } catch (cause) {
      /* v8 ignore next -- the assembled frame consists only of already-admitted fields. */
      return Effect.fail(unavailable("Projection produced an invalid frame", cause))
    }
  })

const snapshotOf = (candidate: unknown): Effect.Effect<GatewaySchema.ProjectionSnapshot, GatewayError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(decodeSnapshot(candidate))
      /* v8 ignore next -- boundedRows and cursorOf admit every field before this internal assembly step. */
    } catch (cause) {
      /* v8 ignore next -- the assembled snapshot consists only of already-admitted fields. */
      return Effect.fail(unavailable("Projection produced an invalid snapshot", cause))
    }
  })

/**
 * The cursor the read reached.
 *
 * A run's cursor is the last sequence its journal committed, taken from the
 * same array the rows were folded from. A workspace cursor is `0`: control
 * journal sequences belong to per-run partitions (`@smthrs/control`
 * `ControlLive.streamForRun` and `snapshotHighWater` are keyed by `runId`), so
 * there is no workspace-wide sequence to advertise and no workspace resume.
 */
const cursorPositionOf = (source: Source): CursorPosition =>
  source._tag === "run" ? lastPositionOf(source.run.events) : { value: 0, offset: 0 }

/** Implements a read path after its construction settings have been admitted. */
const makeService = (control: ControlService, heartbeatMillis: number): Service => {
  /** Every committed event of one run, oldest first. */
  const eventsOf = (runId: string): Effect.Effect<EventBuffer, GatewayError> => {
    const message = `Reading the events of ${runId} failed`
    return Stream.runFoldEffect(
      control.watch({ runId, follow: false }).pipe(
        Stream.tapError((cause) => Effect.logWarning(message, cause)),
        Stream.mapError((cause) => unavailable(message, cause))
      ),
      emptyEventBuffer,
      (buffer, event) => appendEvent(buffer, event, `${message}: the control plane returned an invalid event`)
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
    Effect.map(Effect.all([runOf(runId), eventsOf(runId)]), ([run, buffer]) => ({ run, ...buffer }))

  /** Every run a workspace selector folds, and each one's journal. */
  const workspaceSourceOf = (
    selector: GatewaySchema.ProjectionSelector
  ): Effect.Effect<ReadonlyArray<RunSource>, GatewayError> =>
    Effect.flatMap(
      // The inbox asks the control plane which runs are parked rather than
      // reading every run's journal to find out.
      runsMatching(selector._tag === "approvals" ? { status: "waiting-approval" } : {}),
      (runs) =>
        Effect.map(
          Effect.forEach(runs, (run) => Effect.map(eventsOf(run.runId), (buffer) => ({ run, ...buffer }))),
          (sources) =>
            selector._tag === "approvals"
              ? sources.filter((source) => rowsOfWorkspace(selector, [source]).length > 0)
              : sources
        )
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
    Effect.flatMap(
      sourceOf(selector),
      (source) =>
        Effect.flatMap(boundedRows(selector, rowsOf(selector, source)), (rows) =>
          snapshotOf({
            selector,
            cursor: cursorOf(selector, cursorPositionOf(source)),
            rows
          }))
    )

  const snapshotFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    rows: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<GatewaySchema.GatewayFrame>, GatewayError> => {
    const cursor = cursorOf(selector, cursorPositionOf(source))
    return Effect.forEach([
      { _tag: "snapshot-start", selector, cursor },
      ...rows.map((row) => ({ _tag: "row", selector, cursor, row })),
      { _tag: "snapshot-end", selector, cursor }
    ], frameOf)
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

  interface RunFollowState {
    readonly buffer: EventBuffer
    readonly observed: CursorPosition | undefined
  }

  interface RunDelta {
    readonly event: ControlSchema.ControlEvent
    readonly events: ReadonlyArray<ControlSchema.ControlEvent>
    readonly position: CursorPosition
  }

  interface WorkspaceDelta {
    readonly event: ControlSchema.ControlEvent & { readonly runId: string }
    readonly position: CursorPosition
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
    from: CursorPosition
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> => {
    const runId = source.run.runId
    const message = `Following ${runId} failed`
    const seedEvents = positionedEvents(source.events)
      .filter(({ position }) => comparePosition(position, from) <= 0)
      .map(({ event }) => event)
    const seed = comparePosition(from, lastPositionOf(source.events)) === 0
      ? Effect.succeed<EventBuffer>({
        events: source.events,
        encodedBytes: source.encodedBytes,
        lastSequence: source.events.at(-1)?.sequence ?? 0
      })
      : bufferOf(seedEvents, `${message}: the cursor seed is invalid`)
    return Stream.unwrap(Effect.map(seed, (initial) =>
      control.watch({
        runId,
        afterSequence: from.value === 0 ? 0 : from.value - 1,
        follow: true
      }).pipe(
        Stream.tapError((cause) => Effect.logWarning(message, cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.mapAccumEffect(
          (): RunFollowState => ({ buffer: initial, observed: undefined }),
          (state, candidate): Effect.Effect<
            readonly [RunFollowState, ReadonlyArray<RunDelta>],
            GatewayError
          > =>
            Effect.flatMap(
              decodedEvent(candidate, `${message}: the control plane returned an invalid event`),
              (event) => {
                if (state.observed !== undefined && event.sequence < state.observed.value) {
                  return Effect.fail(unavailable(`${message}: event sequences moved backward`, undefined))
                }
                const position: CursorPosition = {
                  value: event.sequence,
                  offset: state.observed?.value === event.sequence ? state.observed.offset + 1 : 0
                }
                const nextState: RunFollowState = { ...state, observed: position }
                if (comparePosition(position, from) <= 0) {
                  return Effect.succeed([nextState, [] as ReadonlyArray<RunDelta>] as const)
                }
                return Effect.map(
                  appendEvent(state.buffer, event, `${message}: event history is invalid`),
                  (buffer) =>
                    [
                      { buffer, observed: position } satisfies RunFollowState,
                      [{ event, events: buffer.events, position }] satisfies ReadonlyArray<RunDelta>
                    ] as const
                )
              }
            )
        ),
        Stream.mapEffect(({ event, events, position }) =>
          Effect.flatMap(deltaRows(selector, source.run, event, events), (rows) =>
            Effect.flatMap(boundedRows(selector, rows), (delta) =>
              frameOf({
                _tag: "delta",
                selector,
                cursor: cursorOf(selector, position),
                delta
              })))
        )
      )))
  }

  /**
   * Workspace deltas from the unscoped control follow.
   *
   * Control sequences belong to run partitions, so this stream cannot start
   * after one workspace cursor. It follows without a cursor instead. That
   * replays each partition from its beginning, and the map seeded from the
   * snapshot drops events at or below each run's last folded sequence. An
   * unseen run costs one read to admit, and the map never exceeds the snapshot
   * ceiling.
   */
  const workspaceDeltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    runs: ReadonlyArray<RunSource>
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    Stream.unwrap(Effect.sync(() => {
      const sources = new Map<string, RunSource>(runs.map((source) => [source.run.runId, source]))
      const noFrames: ReadonlyArray<GatewaySchema.GatewayFrame> = []
      const delta = (): Effect.Effect<ReadonlyArray<GatewaySchema.GatewayFrame>, GatewayError> =>
        Effect.flatMap(boundedRows(selector, rowsOfWorkspace(selector, [...sources.values()])), (rows) =>
          Effect.map(
            frameOf({
              _tag: "delta",
              selector,
              cursor: cursorOf(selector, { value: 0, offset: 0 }),
              delta: rows
            }),
            (frame) => [frame]
          ))
      const message = "Following the workspace failed"
      return control.watch({ follow: true }).pipe(
        Stream.tapError((cause) => Effect.logWarning(message, cause)),
        Stream.mapError((cause) => unavailable(message, cause)),
        Stream.mapAccumEffect(
          () => new Map<string, CursorPosition>(),
          (positions, candidate): Effect.Effect<
            readonly [Map<string, CursorPosition>, ReadonlyArray<WorkspaceDelta>],
            GatewayError
          > =>
            Effect.flatMap(
              decodedEvent(candidate, `${message}: the control plane returned an invalid event`),
              (event) => {
                const runId = event.runId
                if (runId === undefined) {
                  return Effect.succeed([positions, [] as ReadonlyArray<WorkspaceDelta>] as const)
                }
                const previous = positions.get(runId)
                if (previous !== undefined && event.sequence < previous.value) {
                  return Effect.fail(unavailable(`${message}: event sequences moved backward`, undefined))
                }
                const position: CursorPosition = {
                  value: event.sequence,
                  offset: previous?.value === event.sequence ? previous.offset + 1 : 0
                }
                const next = new Map(positions)
                next.set(runId, position)
                return Effect.succeed(
                  [
                    next,
                    [{ event: { ...event, runId }, position }] satisfies ReadonlyArray<WorkspaceDelta>
                  ] as const
                )
              }
            )
        ),
        Stream.mapEffect(({ event, position }) => {
          const runId = event.runId
          const current = sources.get(runId)
          if (current !== undefined) {
            if (comparePosition(position, lastPositionOf(current.events)) <= 0) return Effect.succeed(noFrames)
            return Effect.flatMap(
              appendEvent(current, event, `${message}: event history is invalid`),
              (buffer) =>
                Effect.flatMap(runOf(runId), (fresh) => {
                  const source = { run: fresh, ...buffer }
                  if (selector._tag === "approvals" && rowsOfWorkspace(selector, [source]).length === 0) {
                    sources.delete(runId)
                  } else {
                    sources.set(runId, source)
                  }
                  return delta()
                })
            )
          }

          if (selector._tag !== "approvals" && sources.size >= maxWorkspaceRuns) {
            return Effect.succeed(noFrames)
          }
          return runSourceOf(runId).pipe(
            Effect.flatMap((source) => {
              const admitted = comparePosition(position, lastPositionOf(source.events)) <= 0
                ? Effect.succeed(source)
                : Effect.map(
                  appendEvent(source, event, `${message}: event history is invalid`),
                  (buffer): RunSource => ({ run: source.run, ...buffer })
                )
              return Effect.flatMap(admitted, (complete) => {
                if (selector._tag === "approvals" && rowsOfWorkspace(selector, [complete]).length === 0) {
                  return Effect.succeed(noFrames)
                }
                if (sources.size >= maxWorkspaceRuns) return Effect.succeed(noFrames)
                sources.set(runId, complete)
                return delta()
              })
            }),
            Effect.catchIf(
              (failure) => failure.code === "run_not_found",
              () => Effect.succeed(noFrames)
            )
          )
        }),
        Stream.flattenIterable
      )
    }))

  /**
   * Deltas for a selector.
   *
   * A run selector follows after its sequence cursor. A workspace selector has
   * no resume cursor because control journal sequences belong to per-run
   * partitions, but it can follow every partition without one.
   */
  const deltaFrames = (
    selector: GatewaySchema.ProjectionSelector,
    source: Source,
    from: CursorPosition
  ): Stream.Stream<GatewaySchema.GatewayFrame, GatewayError> =>
    source._tag === "workspace"
      ? workspaceDeltaFrames(selector, source.runs)
      : runDeltaFrames(selector, source.run, from)

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
    const candidate = after as unknown as Record<string, unknown>
    if (!Number.isSafeInteger(candidate.value) || (candidate.value as number) < 0) {
      return malformed(
        `Cursor value ${String(candidate.value)} must be a non-negative safe integer`
      )
    }
    if (!Number.isSafeInteger(candidate.offset) || (candidate.offset as number) < 0) {
      return malformed(
        `Cursor offset ${String(candidate.offset)} must be a non-negative safe integer`
      )
    }
    if (!Schema.is(GatewaySchema.ProjectionCursor)(after)) {
      return malformed("The projection cursor is not a valid gateway cursor")
    }
    const runId = scopeOf(selector)
    if (after.projection !== selector._tag) {
      return malformed(
        `A cursor for the ${after.projection} projection cannot resume a ${selector._tag} subscription`
      )
    }
    if (!sameSelector(after.selector, selector)) {
      return malformed("A cursor can resume only the exact selector that issued it")
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
    Effect.flatMap(
      sourceOf(selector),
      (source) =>
        Effect.flatMap(boundedRows(selector, rowsOf(selector, source)), (rows) =>
          Effect.map(snapshotFrames(selector, source, rows), (frames) =>
            Stream.concat(
              Stream.fromIterable(frames),
              deltaFrames(selector, source, cursorPositionOf(source))
            )))
    )

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
      ? Effect.flatMap(runSourceOf(scope), (source) => {
        const position = { value: after.value, offset: after.offset }
        const last = lastPositionOf(source.events)
        if (comparePosition(position, last) > 0) {
          return Effect.fail(malformed(
            `Cursor ${after.value}:${after.offset} cannot resume run ${scope} past its last position ${last.value}:${last.offset}`
          ))
        }
        const issued = position.value === 0 && position.offset === 0 ||
          positionedEvents(source.events).some((candidate) => comparePosition(candidate.position, position) === 0)
        return !issued
          ? Effect.fail(malformed(
            `Cursor ${after.value}:${after.offset} was not issued by run ${scope}`
          ))
          : Effect.succeed(runDeltaFrames(selector, source, position))
      })
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
 * Builds the read path over a control plane.
 *
 * Invalid keepalive settings are returned as typed `bind_failed` failures;
 * construction never throws synchronously.
 *
 * @param control the control service to read through
 * @param options the keepalive cadence to use
 * @since 1.0.0
 * @category constructors
 */
export const make = (
  control: ControlService,
  options: { readonly heartbeatMillis?: number | undefined } = {}
): Effect.Effect<Service, GatewayError> =>
  Effect.suspend(() => {
    const refusal = settingRefusal("The gateway keepalive cadence", options.heartbeatMillis)
    return refusal === undefined
      ? Effect.succeed(makeService(control, options.heartbeatMillis ?? heartbeatIntervalMillis))
      : Effect.fail(refusal)
  })

/**
 * Provides the gateway read path over the ambient control plane.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer: Layer.Layer<Projections, GatewayError, Control> = Layer.effect(Projections)(
  Effect.flatMap(Control, (control) => make(control))
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
): Layer.Layer<Projections, GatewayError, Control> =>
  Layer.effect(Projections)(Effect.flatMap(Control, (control) => make(control, options)))
