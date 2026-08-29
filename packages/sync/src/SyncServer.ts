/**
 * The workspace-side implementation of the sync read path.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import { type BranchId, branchOfRunId, type ShareCapability } from "./BranchProtocol.ts"
import * as BranchShare from "./BranchShare.ts"
import * as RunCatalog from "./RunCatalog.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncPrincipal from "./SyncPrincipal.ts"
import * as SyncProtocol from "./SyncProtocol.ts"
import { SyncRpcs } from "./SyncRpcs.ts"

/**
 * Sync read-path operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly read: (request: SyncProtocol.ReadRequest) => Effect.Effect<SyncProtocol.ReadResponse, SyncError>
  readonly subscribe: (request: SyncProtocol.SubscribeRequest) => Stream.Stream<SyncProtocol.Frame, SyncError>
}

/**
 * The workspace sync server.
 *
 * @category services
 * @since 0.1.0
 */
export class SyncServer extends Context.Service<SyncServer, Service>()("@smthrs/sync/SyncServer") {}

/**
 * Constructs a sync server from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => SyncServer.of(implementation)

/**
 * Constructs a closed sync server stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    read: Effect.fn("SyncServer.read")(() => Effect.succeed({ entries: [], cursors: [], done: true })),
    subscribe: (): Stream.Stream<SyncProtocol.Frame, SyncError> =>
      Stream.succeed<SyncProtocol.Frame>({ _tag: "Closed", reason: "Sync server is unavailable" }),
    ...overrides
  })

/**
 * Provides a closed sync server stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<SyncServer> = Layer.succeed(SyncServer, makeNoop())

const journalFailure = (cause: unknown): SyncError =>
  new SyncError({
    code: "unknown",
    message: cause instanceof Error ? cause.message : "Journal read failed",
    cause
  })

const cursorOf = (
  cursors: SyncProtocol.WorkspaceCursor,
  runId: JournalEvent.RunId
): JournalEvent.Seq | undefined => cursors.find((cursor) => cursor.runId === runId)?.afterSeq

/**
 * Largest number of journal reads one workspace subscription keeps open at
 * once.
 *
 * A workspace subscription serves every run it covers, and every open read is
 * a cursor plus a page buffer. Without a bound the cost of one follower is the
 * size of the workspace: a thousand-run workspace opened a thousand journal
 * streams the moment a subscription started, whether or not the follower ever
 * read from them, and a follower that stalled held all of them. Sixty-four
 * bounds what one follower costs without bounding what it sees: the workspace
 * tail visits every covered run each round, so a run past the bound waits for
 * a slot for the length of one round rather than being starved.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultConcurrency = 64

/**
 * How long a workspace subscription waits before re-reading the runs it
 * covers, when nothing announces a change, in milliseconds.
 *
 * A workspace tail is a fan-in over many runs, and the runs another engine
 * process owns reach this process only through the database. rc.0 has no
 * cross-process wake, so the interval is the whole of the freshness policy for
 * them: a follower sees an entry within one interval of it being durable. A
 * second matches the rest of the rc.0 posture — the heartbeat sweep, the
 * cancel poll, and {@link RunCatalog.defaultPollIntervalMs} — and a run-scoped
 * subscription is unaffected, since it follows one journal stream directly and
 * is woken in process.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTailIntervalMs = 1000

/**
 * Entries one workspace tail read pulls per run per page. A round reads at
 * most `concurrency` pages at once, so this is the page half of the memory one
 * follower costs; a run with more unserved entries than this is served over
 * consecutive pages inside the same round.
 */
const tailBatchSize = 256

/**
 * Read-path policy.
 *
 * The default caps the encoded entries of one read page or one subscription
 * frame at 1 MiB, and the run streams one subscription holds open at
 * {@link defaultConcurrency}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Largest summed encoded-entry size one read page or subscription frame may
   * carry, in bytes. Defaults to {@link SyncProtocol.defaultMaxFrameBytes}.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Largest number of journal reads one workspace subscription keeps open at
   * once. Defaults to {@link defaultConcurrency}.
   */
  readonly concurrency?: number | undefined
  /**
   * How long a workspace subscription waits before re-reading the runs it
   * covers, when nothing announces a change, in milliseconds. Defaults to
   * {@link defaultTailIntervalMs}.
   */
  readonly tailIntervalMs?: number | undefined
}

/**
 * Constructs the workspace sync server over a journal and a run catalog,
 * under an explicit policy.
 *
 * Reads page one run at a time so a single large run cannot starve the rest of
 * the workspace, and `done` is reported only when every covered run has been
 * paged to its durable tail. A page or frame whose encoded entries exceed the
 * frame ceiling is refused with `frame_too_large` instead of served, so one
 * oversized journal payload cannot take down every follower that pulls it.
 *
 * A workspace subscription's fan-out is bounded without bounding what it
 * serves. It reads every run it covers — the runs the request covers plus the
 * runs the catalog announces while it is live — in rounds, at most
 * `Options.concurrency` journal reads open at once, repeating each round on an
 * announcement or after `Options.tailIntervalMs`. The memory one follower
 * costs is a function of the bound, not of the workspace's size, and no run is
 * starved by the runs ahead of it. A run-scoped subscription follows that one
 * run's journal stream directly and keeps its in-process wake.
 *
 * Authorization is fail-closed along two boundaries, both consulted per
 * request:
 *
 * - Branch runs: a run whose id maps to a shared branch is visible only when
 *   the request's share capability verifies for that branch. An explicitly
 *   scoped branch read without one fails; a workspace listing excludes branch
 *   runs the caller's capability does not cover, so one share link never
 *   leaks another branch's log. Without a {@link BranchShare} in scope every
 *   branch run is closed.
 * - Non-branch runs: visible only to the workspace principal
 *   (`SyncPrincipal`), whose default is anonymous. A workspace-scoped
 *   request and a run-scoped request for a non-branch run are both refused
 *   for anonymous callers, so a connection with no credential — or with only
 *   a branch share link — can never read engine runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLiveWith = (
  options: Options = {}
): Effect.Effect<Service, never, Journal.Journal | RunCatalog.RunCatalog> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const catalog = yield* RunCatalog.RunCatalog
    const share = yield* Effect.serviceOption(BranchShare.BranchShare)
    const maxFrameBytes = options.maxFrameBytes ?? SyncProtocol.defaultMaxFrameBytes
    const concurrency = options.concurrency ?? defaultConcurrency
    const tailIntervalMs = options.tailIntervalMs ?? defaultTailIntervalMs

    /** Refuses any page or frame whose encoded entries outgrow the ceiling. */
    const guardFrameBytes = (bytes: number): Effect.Effect<void, SyncError> =>
      bytes <= maxFrameBytes
        ? Effect.void
        : Effect.fail(
          new SyncError({
            code: "frame_too_large",
            message: `Encoded entries of ${bytes} bytes exceed the ${maxFrameBytes}-byte frame ceiling`
          })
        )

    /**
     * Chunk-level admission for the live path. Each subscription frame
     * carries one entry, so the per-frame ceiling is a per-entry ceiling —
     * but the check runs once per journal chunk, not once per entry, because
     * a per-element effect hop de-chunks the stream and multiplies the cost
     * of every downstream combinator on the hot follow path.
     */
    const guardEntryChunk = (chunk: ReadonlyArray<JournalEvent.Entry>): Effect.Effect<void, SyncError> => {
      for (const entry of chunk) {
        const bytes = SyncProtocol.encodedByteLength(entry)
        if (bytes > maxFrameBytes) return guardFrameBytes(bytes)
      }
      return Effect.void
    }

    const covered = Effect.map(catalog.list, (ids) => [...ids].sort())

    /** Whether the current request is authenticated as the workspace. */
    const workspacePrincipal: Effect.Effect<boolean> = Effect.map(
      Effect.service(SyncPrincipal.SyncPrincipal),
      SyncPrincipal.isWorkspace
    )

    const requireWorkspace = Effect.flatMap(workspacePrincipal, (granted) =>
      granted ? Effect.void : Effect.fail(
        new SyncError({
          code: "unauthorized",
          message: "Reading workspace runs requires an authenticated workspace principal"
        })
      ))

    /**
     * A branch read is granted only by a capability that verifies for it. Only
     * an `unauthorized` refusal folds to `false`; an infrastructure fault (Web
     * Crypto rejecting the HMAC) propagates, so "the signer is broken" is never
     * reported as "not authorized".
     */
    const canReadBranch = (
      branchId: BranchId,
      capability: ShareCapability | undefined
    ): Effect.Effect<boolean, SyncError> =>
      Option.isNone(share) || capability === undefined
        ? Effect.succeed(false)
        : share.value.verify(capability, { branchId, access: "read" }).pipe(
          Effect.as(true),
          Effect.catch((error) => error.code === "unauthorized" ? Effect.succeed(false) : Effect.fail(error))
        )

    /** Whether one catalog-advertised run may be followed by this request. */
    const canFollow = (
      runId: JournalEvent.RunId,
      capability: ShareCapability | undefined
    ): Effect.Effect<boolean, SyncError> => {
      const branchId = branchOfRunId(runId)
      return branchId === null ? workspacePrincipal : canReadBranch(branchId, capability)
    }

    /**
     * The runs a request may observe. A run-scoped request the caller is not
     * authorized for fails outright — a scoped read must never silently answer
     * with an empty or partial view — and a workspace-scoped request is only
     * answered for the workspace principal at all.
     */
    const runIdsFor = (
      scope: SyncProtocol.Scope,
      capability: ShareCapability | undefined
    ): Effect.Effect<ReadonlyArray<JournalEvent.RunId>, SyncError> =>
      scope._tag === "Run"
        ? Effect.gen(function*() {
          const branchId = branchOfRunId(scope.runId)
          if (branchId === null) {
            yield* requireWorkspace
          } else if (!(yield* canReadBranch(branchId, capability))) {
            return yield* Effect.fail(
              new SyncError({
                code: "unauthorized",
                message: "Reading a shared branch requires a valid share capability"
              })
            )
          }
          return [scope.runId]
        })
        : Effect.gen(function*() {
          yield* requireWorkspace
          const runIds = yield* covered
          const visible: Array<JournalEvent.RunId> = []
          for (const runId of runIds) {
            if (yield* canFollow(runId, capability)) visible.push(runId)
          }
          return visible
        })

    const read = (request: SyncProtocol.ReadRequest): Effect.Effect<SyncProtocol.ReadResponse, SyncError> =>
      Effect.gen(function*() {
        const runIds = yield* runIdsFor(request.scope, request.capability)
        const entries: Array<JournalEvent.Entry> = []
        const cursors = new Map(request.cursors.map((cursor) => [cursor.runId, cursor.afterSeq]))
        let done = true
        let frameBytes = 0
        for (const runId of runIds) {
          if (entries.length >= request.limit) {
            done = false
            break
          }
          const after = cursorOf(request.cursors, runId)
          const page = yield* journal.entries({
            runId,
            ...(after === undefined ? {} : { after }),
            limit: request.limit - entries.length
          }).pipe(Effect.mapError(journalFailure))
          for (const accepted of page.entries) {
            frameBytes += SyncProtocol.encodedByteLength(accepted)
            yield* guardFrameBytes(frameBytes)
            entries.push(accepted)
          }
          const last = page.entries.at(-1)
          if (last !== undefined) cursors.set(runId, last.seq)
          if (page.hasMore) done = false
        }
        return {
          entries,
          cursors: Array.from(cursors, ([runId, afterSeq]) => ({ runId, afterSeq })),
          done
        }
      })

    const runStream = (
      runId: JournalEvent.RunId,
      cursors: SyncProtocol.WorkspaceCursor
    ): Stream.Stream<SyncProtocol.Frame, SyncError> => {
      const after = cursorOf(cursors, runId)
      return journal.stream({ runId, ...(after === undefined ? {} : { afterSequence: after }) }).pipe(
        Stream.mapError(journalFailure),
        Stream.chunks,
        Stream.tap(guardEntryChunk),
        Stream.flattenArray,
        Stream.mapAccum(
          () => after === undefined ? -1 : after,
          (previous, entry) => [
            entry.seq,
            [
              {
                _tag: "Entries",
                runId,
                fromSeq: (previous + 1) as JournalEvent.Seq,
                toSeq: entry.seq,
                entries: [entry]
              } satisfies SyncProtocol.Frame
            ]
          ]
        )
      )
    }

    /**
     * The live tail of a whole workspace.
     *
     * A journal run stream is replay-then-follow: it never ends. One such
     * stream per run is therefore not something a bound can be put on and
     * still serve the workspace — a bounded `Stream.flatMap` over streams that
     * never end fills its slots with the first `concurrency` runs and no run
     * behind them is ever attached. The workspace tail inverts that. It reads
     * each covered run's unserved entries as a finite page walk, so the bound
     * limits how many reads are open at once and every round still visits
     * every run, and it repeats the round on a wake or on
     * {@link defaultTailIntervalMs}. Memory is a function of the bound;
     * freshness is a function of the interval; neither is a function of how
     * many runs the workspace holds.
     *
     * A run-scoped subscription does not go through here: it follows one
     * journal stream directly (see {@link runStream}) and keeps that stream's
     * in-process wake.
     */
    const workspaceStream = (
      covering: ReadonlyArray<JournalEvent.RunId>,
      request: SyncProtocol.SubscribeRequest
    ): Stream.Stream<SyncProtocol.Frame, SyncError> =>
      Stream.unwrap(Effect.gen(function*() {
        // The runs this subscription serves, and how far each has been served.
        // Both grow while it is live: the catalog announces the runs the
        // workspace gains after the subscription attached.
        const served = new Map<JournalEvent.RunId, JournalEvent.Seq | undefined>()
        const cover = (runId: JournalEvent.RunId): void => {
          if (!served.has(runId)) served.set(runId, cursorOf(request.cursors, runId))
        }
        for (const runId of covering) cover(runId)

        // Sliding by one: a wake published while a round is running is
        // remembered, and never more than one round's worth of them.
        const wake = yield* PubSub.sliding<void>(1)
        const woken = yield* PubSub.subscribe(wake)

        /** One run's unserved entries, as frames. Finite by construction. */
        const tail = (runId: JournalEvent.RunId): Stream.Stream<SyncProtocol.Frame, SyncError> =>
          Stream.unwrap(Effect.gen(function*() {
            const after = served.get(runId)
            const page = yield* journal.entries({
              runId,
              ...(after === undefined ? {} : { after }),
              limit: tailBatchSize
            }).pipe(Effect.mapError(journalFailure))
            yield* guardEntryChunk(page.entries)
            const frames: Array<SyncProtocol.Frame> = []
            let previous = after === undefined ? -1 : after
            for (const accepted of page.entries) {
              frames.push({
                _tag: "Entries",
                runId,
                fromSeq: (previous + 1) as JournalEvent.Seq,
                toSeq: accepted.seq,
                entries: [accepted]
              })
              previous = accepted.seq
            }
            const last = page.entries.at(-1)
            // An empty page ends the walk whatever the page claims, so a
            // journal that reports more without returning any cannot spin.
            if (last === undefined) return Stream.empty
            served.set(runId, last.seq)
            return page.hasMore
              ? Stream.concat(Stream.fromIterable(frames), Stream.suspend(() => tail(runId)))
              : Stream.fromIterable(frames)
          }))

        /** One pass over every covered run, `concurrency` reads open at most. */
        const round = Stream.suspend(() =>
          Stream.flatMap(Stream.fromIterable(Array.from(served.keys())), tail, { concurrency })
        )

        // Announcements cover the run and wake the tail. Draining keeps this a
        // control path that emits nothing, while a refusal to authorize an
        // announced run still fails the subscription rather than being lost in
        // a forked fiber.
        const announcements = Stream.filterEffect(
          catalog.changes,
          (runId) => canFollow(runId, request.capability)
        ).pipe(
          Stream.tap((runId) => Effect.andThen(Effect.sync(() => cover(runId)), PubSub.publish(wake, undefined))),
          Stream.drain
        )

        const ticks = Stream.fromEffectRepeat(
          Effect.raceFirst(PubSub.take(woken), Effect.sleep(tailIntervalMs))
        )

        return Stream.merge(
          Stream.concat(round, Stream.flatMap(ticks, () => round)),
          announcements
        )
      }))

    const subscribe = (request: SyncProtocol.SubscribeRequest): Stream.Stream<SyncProtocol.Frame, SyncError> =>
      Stream.unwrap(
        Effect.map(runIdsFor(request.scope, request.capability), (runIds) =>
          request.scope._tag === "Run"
            ? runStream(request.scope.runId, request.cursors)
            : workspaceStream(runIds, request))
      ).pipe(Stream.take(request.credit))

    return make({ read, subscribe })
  })

/**
 * Constructs the workspace sync server with default policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive: Effect.Effect<Service, never, Journal.Journal | RunCatalog.RunCatalog> = makeLiveWith()

/**
 * Provides the workspace sync server.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<SyncServer, never, Journal.Journal | RunCatalog.RunCatalog> = Layer.effect(
  SyncServer,
  makeLive
)

/**
 * Provides the workspace sync server under an explicit policy.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWith = (
  options: Options
): Layer.Layer<SyncServer, never, Journal.Journal | RunCatalog.RunCatalog> =>
  Layer.effect(SyncServer, makeLiveWith(options))

/**
 * Provides the sync RPC handlers over the sync server: a thin, honest
 * projection of {@link Service} onto the wire, mirroring
 * `BranchServer.layerHandlers`. Serving these handlers requires an
 * implementation of the group's `SyncAuth` middleware — `SyncAuth.layer` is
 * the production one — and without a middleware-installed principal every
 * request runs as anonymous and non-branch reads are refused.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHandlers: Layer.Layer<
  Rpc.ToHandler<RpcGroup.Rpcs<typeof SyncRpcs>>,
  never,
  SyncServer
> = SyncRpcs.toLayer(
  Effect.gen(function*() {
    const sync = yield* SyncServer
    return SyncRpcs.of({
      "Sync.Read": (request) => sync.read(request),
      "Sync.Subscribe": (request) => sync.subscribe(request)
    })
  })
)
