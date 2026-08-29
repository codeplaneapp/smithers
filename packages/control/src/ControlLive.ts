/**
 * In-process Control implementation over `ControlRuntime`, the flow
 * registry, and the append-only journal.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import * as SteerPayload from "@smthrs/notifications/SteerPayload"
import { Registry } from "@smthrs/registry"
import { Effect, Layer, Option, Semaphore, Stream } from "effect"
import * as Cancellation from "./Cancellation.ts"
import {
  type ApprovalInput,
  Control,
  type RunMutationInput,
  type Service,
  type SignalInput,
  type SteerInput
} from "./Control.ts"
import {
  ClaimLost,
  type ControlError,
  type EnvelopeMismatch,
  type LaunchFailed,
  NoMatchingWait,
  PersistenceError,
  type PlanDigestMismatch,
  type RunNotFound,
  Unavailable
} from "./ControlError.ts"
import type { CancelRecord } from "./ControlExecutor.ts"
import { ControlExecutor } from "./ControlExecutor.ts"
import { ControlRuntime } from "./ControlRuntime.ts"
import type {
  ControlEvent,
  IdempotencyKey,
  ListRequest,
  ListResponse,
  Receipt,
  RunId,
  RunSummary,
  WatchFilter
} from "./ControlSchema.ts"
import { steerItem } from "./ControlSchema.ts"
import * as Lineage from "./Lineage.ts"
import * as Steering from "./Steering.ts"

const sourceId = JournalEvent.SourceId.make("/control")

const watchDeduplicationWindow = 1024
const snapshotPageSize = 1024
const snapshotPartitionConcurrency = 8

const unavailable = (feature: string): Unavailable =>
  new Unavailable({ feature, ticket: "control-runtime-engine-integration" })

const accepted = (key: IdempotencyKey, runId?: RunId): Receipt =>
  runId === undefined
    ? { _tag: "Accepted", receiptId: key }
    : { _tag: "Accepted", receiptId: key, runId }

const terminal = (status: RunSummary["status"]): boolean =>
  status === "cancelled" || status === "completed" || status === "failed"

/**
 * Whether a status means a process is holding the run right now.
 *
 * `accepted` is what a claim writes, and nothing rewrites it until the run
 * settles: only `Control.run` promotes a run to `running`, and only when its
 * own executor took the launch. A run restarted by `Control.resume` or by an
 * approval therefore spends its whole second life `accepted`. Both statuses
 * project onto the store's `running` (`SqlControlRuntime`'s `storeStatus`), so
 * a lost claim against either one means a live peer owns the row — which
 * rc-contract 5.1 answers `ClaimLost`. Asking for the literal `running` alone
 * answered `Accepted` for a peer's accepted run and hid the peer.
 */
const live = (status: RunSummary["status"]): boolean => status === "running" || status === "accepted"

const terminalOrAccepted = (
  key: IdempotencyKey,
  run: RunSummary
): Receipt =>
  terminal(run.status)
    ? { _tag: "Terminal", runId: run.runId, status: run.status }
    : accepted(key, run.runId)

const fingerprint = (operation: string, input: unknown): string => `${operation}:${JSON.stringify(input)}`

const json = (value: unknown): ControlEvent["payload"] => JSON.parse(JSON.stringify(value)) as ControlEvent["payload"]

const page = <A>(
  values: ReadonlyArray<A>,
  cursor: string | undefined,
  limit: number | undefined
): { readonly items: ReadonlyArray<A>; readonly nextCursor?: string | undefined } => {
  const start = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0)
  const size = limit === undefined ? values.length : Math.max(0, Math.trunc(limit))
  const items = values.slice(start, start + size)
  const next = start + items.length
  return next < values.length ? { items, nextCursor: String(next) } : { items }
}

const eventFromEntry = (entry: JournalEvent.Entry): ControlEvent => ({
  sequence: entry.seq,
  kind: entry.eventType,
  runId: entry.runId,
  occurredAt: entry.emittedAtMs,
  payload: entry.payload as ControlEvent["payload"]
})

/**
 * Live in-process Control layer.
 *
 * Writes delegate to `ControlRuntime`; journal events are observational
 * records. `watch` only replays and follows committed journal entries.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<
  Control,
  never,
  ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
> = Layer.effect(
  Control,
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    const journal = yield* Journal.Journal
    const notifications = yield* NotificationQueue.NotificationQueue
    const registry = yield* Registry.Registry
    const executor = yield* Effect.serviceOption(ControlExecutor)
    const mutationSemaphore = yield* Semaphore.make(1)

    const emit = (
      runId: string,
      eventType: string,
      payload: ControlEvent["payload"]
    ): Effect.Effect<void, PersistenceError> =>
      // Unfenced: the control plane mutates runs it does not own — that is
      // the point of a control plane — so its event records are
      // first-writer-wins admissions, not owner-fenced lifecycle writes.
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId,
          eventType,
          payload
        })
      ).pipe(
        Effect.mapError((cause) =>
          new PersistenceError({
            operation: eventType,
            message: `Failed to persist ${eventType}`,
            cause
          })
        )
      )

    const mutate = <E, R>(
      operation: string,
      key: IdempotencyKey,
      mutationFingerprint: string,
      effect: Effect.Effect<Receipt, E, R>
    ): Effect.Effect<Receipt, E | PersistenceError, R> =>
      mutationSemaphore.withPermits(1)(
        journal.transact(Effect.gen(function*() {
          const mutationKey = `${operation}:${key}`
          const prior = yield* runtime.lookupMutation(mutationKey, mutationFingerprint)
          if (prior !== undefined) {
            return prior._tag === "AlreadyApplied"
              ? { ...prior, receiptId: key }
              : prior
          }
          const receipt = yield* effect
          if (receipt._tag !== "Parked") {
            yield* runtime.recordMutation(mutationKey, mutationFingerprint, receipt)
          }
          return receipt
        })).pipe(
          Effect.mapError((cause) =>
            cause instanceof Journal.JournalError
              ? new PersistenceError({
                operation: `${operation}.idempotency`,
                message: `Failed to commit ${operation} and its idempotency receipt atomically`,
                cause
              })
              : cause
          )
        )
      )

    const decide = (
      decision: "approved" | "denied",
      input: ApprovalInput
    ) =>
      mutate(
        decision,
        input.idempotencyKey,
        fingerprint(decision, input),
        Effect.gen(function*() {
          const token = yield* runtime.lookupApproval(input.target)
          const principal = yield* runtime.stampPrincipal(input.principal)
          if (decision === "approved") {
            yield* runtime.installBulkGrant(token, input.target.envelope, input.scope)
          }
          yield* emit(
            input.target._tag === "Plan" ? `plan:${input.target.planId}` : input.target.runId,
            `control.approval.${decision}`,
            json({
              tokenId: token.tokenId,
              target: input.target._tag,
              scope: input.scope,
              envelope: input.target.envelope,
              principal
            })
          )
          yield* runtime.resolveApproval(token, decision, principal)
          if (input.target._tag === "Plan") return accepted(input.idempotencyKey)
          // A decision on a node target has to restart the run the ask parked,
          // in this call. The executor re-drives a parked execution only when
          // it sees a resume event, so answering without one left the run in
          // `waiting-approval` until a second call arrived — and a denial the
          // run never learns about is a denial that decided nothing.
          //
          // The claim is scoped to runs this plane launched, for the same
          // reason `Control.resume` scopes it: a run another driver owns keeps
          // its owner, and the journal entry is what reaches it.
          const runId = input.target.runId
          const resumed = yield* runtime.resume(runId, { scope: "launched" }).pipe(
            Effect.catchTag("/control/ClaimLost", () => Effect.succeed(undefined)),
            Effect.catchTag("/control/RunNotFound", () => Effect.succeed(undefined))
          )
          yield* emit(runId, "control.run.resumed", {
            runId,
            ...(resumed === undefined ? {} : { status: resumed.status })
          })
          return accepted(input.idempotencyKey, runId)
        })
      )

    /**
     * Restarts a parked run, by claiming it or by asking whoever owns it.
     *
     * A run this plane launched is this plane's to claim, and `scope:
     * "launched"` is how the runtime is told to check. A run the ENGINE created
     * — a child, a fork, a trampoline round — has its own driver, and claiming
     * it here overwrote the engine's `state_json` and owner columns with a
     * control-plane summary, after which that driver's `scheduleResume` no
     * longer recognized the row: the run stayed suspended with its waiting
     * reason set and its execution never returned (control-plane example 38).
     *
     * The journal entry is the delegation. It is written either way, and the
     * owning driver's resume bridge follows it, so the intent reaches the run
     * without this plane taking the row away from the process that can act on
     * it. A run a live peer is HOLDING — `running`, or the `accepted` a claim
     * writes and only a settlement rewrites — is still `ClaimLost`: there is
     * nothing to restart, and pretending otherwise would hide the peer.
     */
    const runMutation = (
      input: RunMutationInput
    ): Effect.Effect<Receipt, RunNotFound | ClaimLost | PersistenceError> =>
      mutate(
        "resume",
        input.idempotencyKey,
        fingerprint("resume", input),
        Effect.gen(function*() {
          const current = yield* runtime.getRun(input.runId)
          if (terminal(current.status)) {
            return { _tag: "Terminal", runId: current.runId, status: current.status }
          }
          const claimed = yield* runtime.resume(input.runId, { scope: "launched" }).pipe(
            Effect.catchTag("/control/ClaimLost", () =>
              live(current.status)
                ? Effect.fail(new ClaimLost({ runId: input.runId }))
                : Effect.succeed(undefined))
          )
          yield* emit(input.runId, "control.run.resume", {
            runId: input.runId,
            status: (claimed ?? current).status
          })
          return claimed === undefined
            ? accepted(input.idempotencyKey, input.runId)
            : terminalOrAccepted(input.idempotencyKey, claimed)
        })
      )

    /**
     * Resumes a parked run whose park a steer has just answered.
     *
     * Only two parks are the steer's to end. A run parked on `event` is
     * waiting for something to arrive, and a steer is something arriving. A
     * run parked on `released` lost its owner to a sweep
     * (`@smthrs/engine-store` `DisasterRecovery.fence`) and nothing is coming
     * to claim it, so the steer claims it.
     *
     * Every other park keeps waiting. An `approval`, `timer`, or `quota` park
     * is waiting for a decision, a clock, or a budget that a message does not
     * supply. A park with NO reason at all is an operator's own park, written
     * through `ControlRuntime.writeStatus`, and it is the one park a steer must
     * not end: an operator who stopped a run and then sent it a message is
     * queuing the message for when they restart it, not asking for the stop to
     * be undone. A park a control plane cannot explain is left alone for the
     * same reason.
     *
     * A lost claim is not a failure here. It means another process already
     * owns the run, or the run belongs to a driver this plane did not launch
     * — an engine-created child keeps its park, because claiming it would
     * strand it under this plane's fence where no engine re-drives it. The
     * steer itself is already durable in the notification queue, so the
     * owning driver delivers it at the run's next boundary.
     */
    /**
     * Makes a cancellation durable on the engine row through the executor.
     *
     * Absent executor, absent engine: the composition runs nothing, so there is
     * no row to write and the local interrupt is the whole cancel. An executor
     * that answers `unknown` has an engine that never heard of the run, which
     * is the same situation with a different messenger.
     */
    const executorRequestCancel = (
      runId: RunId
    ): Effect.Effect<CancelRecord, PersistenceError> =>
      Option.isNone(executor)
        ? Effect.succeed("unknown" as const)
        : executor.value.requestCancel({ runId })

    const wake = (
      run: RunSummary,
      messageId: string
    ): Effect.Effect<void, PersistenceError> => {
      if (run.status !== "parked") return Effect.void
      if (run.waitingReason !== "event" && run.waitingReason !== "released") return Effect.void
      return runtime.resume(run.runId, { scope: "launched" }).pipe(
        Effect.flatMap((resumed) =>
          emit(run.runId, "control.steer.woke", {
            runId: run.runId,
            messageId,
            status: resumed.status
          })
        ),
        Effect.catchTag("/control/ClaimLost", () => Effect.void),
        Effect.catchTag("/control/RunNotFound", () => Effect.void)
      )
    }

    /**
     * A page of run summaries with their pending steer counts filled in.
     *
     * The count comes from the notification queue rather than from a column,
     * because pending is admitted minus promoted and the queue owns both
     * halves. A queue that is unavailable leaves the field absent — "not
     * known" is representable, and it is the truth — while a journal that
     * fails is a failed listing.
     */
    const withSteering = (
      runs: ReadonlyArray<RunSummary>
    ): Effect.Effect<ReadonlyArray<RunSummary>, ControlError> =>
      Effect.forEach(runs, (run) =>
        notifications.pending(run.runId).pipe(
          Effect.map((pending): RunSummary => ({
            ...run,
            steering: {
              pending: pending.filter((notification) => notification.delivery === "steer").length
            }
          })),
          Effect.catchTag("/notifications/NotificationError", () => Effect.succeed(run)),
          Effect.mapError((cause) =>
            new PersistenceError({
              operation: "control.list.steering",
              message: `Failed to read pending steering for ${run.runId}`,
              cause
            })
          )
        ))

    const list = (request: ListRequest): Effect.Effect<ListResponse, ControlError> =>
      Effect.gen(function*() {
        if (request._tag === "flows") {
          const registered = yield* registry.list()
          const available = registered.length > 0
            ? registered.map((descriptor) => ({
              flowId: descriptor.name,
              description: descriptor.description
            }))
            : yield* runtime.listFlows
          const result = page(available, request.cursor, request.limit)
          return result.nextCursor === undefined
            ? { _tag: "flows", items: result.items }
            : { _tag: "flows", items: result.items, nextCursor: result.nextCursor }
        }

        let runs = Array.from(yield* runtime.listRuns)
        if (request.filters?.runId !== undefined) {
          runs = runs.filter((run) => run.runId === request.filters?.runId)
        }
        if (request.filters?.flowId !== undefined) {
          runs = runs.filter((run) => run.flowId === request.filters?.flowId)
        }
        if (request.filters?.status !== undefined) {
          runs = runs.filter((run) => run.status === request.filters?.status)
        }
        if (request.filters?.parentRunId !== undefined) {
          runs = runs.filter((run) => run.parentRunId === request.filters?.parentRunId)
        }
        if (request.filters?.lineageId !== undefined) {
          runs = runs.filter((run) => run.lineageId === request.filters?.lineageId)
        }
        const result = page(runs, request.cursor, request.limit)
        const items = yield* withSteering(result.items)
        return result.nextCursor === undefined
          ? { _tag: "runs", items }
          : { _tag: "runs", items, nextCursor: result.nextCursor }
      })

    const streamForRun = (
      runId: RunId,
      filter: WatchFilter
    ): Stream.Stream<ControlEvent, ControlError> =>
      journal.stream({
        runId: JournalEvent.RunId.make(runId),
        ...(filter.afterSequence === undefined
          ? {}
          : { afterSequence: JournalEvent.Seq.make(filter.afterSequence) })
      }).pipe(
        Stream.map(eventFromEntry),
        Stream.mapError(() => unavailable("watch"))
      )

    /**
     * Finds the last committed sequence without walking the history. The
     * journal's public cursor is forward-only, so exponential probes first
     * bracket the tail and binary probes then pin it exactly. Only these
     * indexed one-row reads run in the transaction that fixes the cutoff.
     */
    const snapshotHighWater = (
      runId: JournalEvent.RunId
    ): Effect.Effect<JournalEvent.Seq | undefined, ControlError> =>
      journal.transact(
        Effect.gen(function*() {
          const first = yield* journal.entries({ runId, limit: 1 })
          const initial = first.entries[0]
          if (initial === undefined) return undefined

          let lower = initial.seq as number
          let step = 1
          let upper = lower
          while (lower < Number.MAX_SAFE_INTEGER) {
            const probe = Math.min(Number.MAX_SAFE_INTEGER - 1, lower + step - 1)
            const next = yield* journal.entries({
              runId,
              after: JournalEvent.Seq.make(probe),
              limit: 1
            })
            const entry = next.entries[0]
            if (entry === undefined) {
              upper = probe
              break
            }
            lower = entry.seq
            if (lower === Number.MAX_SAFE_INTEGER) return entry.seq
            step = Math.min(Number.MAX_SAFE_INTEGER - lower, step * 2)
          }

          while (lower < upper) {
            const middle = lower + Math.ceil((upper - lower) / 2)
            const next = yield* journal.entries({
              runId,
              after: JournalEvent.Seq.make(middle - 1),
              limit: 1
            })
            const entry = next.entries[0]
            if (entry === undefined) {
              upper = middle - 1
            } else {
              lower = entry.seq
            }
          }
          return JournalEvent.Seq.make(lower)
        })
      ).pipe(Effect.mapError(() => unavailable("watch")))

    const snapshotForRun = (
      runId: RunId,
      filter: WatchFilter
    ): Stream.Stream<ControlEvent, ControlError> => {
      const journalRunId = JournalEvent.RunId.make(runId)
      const initialAfter = filter.afterSequence === undefined
        ? undefined
        : JournalEvent.Seq.make(filter.afterSequence)
      return Stream.unwrap(
        Effect.map(snapshotHighWater(journalRunId), (highWater) => {
          if (highWater === undefined || (initialAfter !== undefined && initialAfter >= highWater)) {
            return Stream.empty
          }
          return Stream.paginate(initialAfter, (after) =>
            journal.entries({
              runId: journalRunId,
              ...(after === undefined ? {} : { after }),
              limit: snapshotPageSize
            }).pipe(
              Effect.map((page) => {
                const entries = page.entries.filter((entry) => entry.seq <= highWater)
                const last = entries.at(-1)
                const next = last === undefined || last.seq >= highWater || !page.hasMore
                  ? Option.none<JournalEvent.Seq | undefined>()
                  : Option.some<JournalEvent.Seq | undefined>(last.seq)
                return [entries, next] as const
              }),
              Effect.mapError(() => unavailable("watch"))
            )).pipe(Stream.map(eventFromEntry))
        })
      )
    }

    const journalPartitions = Effect.gen(function*() {
      const [planIds, runs] = yield* Effect.all([runtime.listPlanIds, runtime.listRuns])
      return [
        ...planIds.map((planId) => `plan:${planId}`),
        ...runs.map((run) => run.runId)
      ]
    })

    const snapshot = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> =>
      filter.runId !== undefined
        ? snapshotForRun(filter.runId, filter)
        : Stream.unwrap(
          Effect.map(journalPartitions, (partitions) =>
            Stream.mergeAll(
              partitions.map((partition) => snapshotForRun(partition, filter)),
              { concurrency: snapshotPartitionConcurrency }
            ))
        )

    const entries = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> =>
      filter.follow === false
        ? snapshot(filter)
        : filter.runId !== undefined
        ? streamForRun(filter.runId, filter)
        : Stream.unwrap(
          Effect.gen(function*() {
            const subscription = yield* journal.changes
            const partitions = yield* journalPartitions
            const tail = Stream.fromSubscription(subscription).pipe(
              Stream.filter((entry) => filter.afterSequence === undefined || entry.seq > filter.afterSequence),
              Stream.map(eventFromEntry)
            )
            return Stream.mergeAll(
              [...partitions.map((partition) => streamForRun(partition, filter)), tail],
              { concurrency: "unbounded" }
            ).pipe(
              Stream.mapAccum(
                () => [] as ReadonlyArray<string>,
                (seen, event) => {
                  const key = `${event.runId ?? ""}:${event.sequence}`
                  if (seen.includes(key)) return [seen, []] as const
                  const next = [...seen, key]
                  return [
                    next.length > watchDeduplicationWindow
                      ? next.slice(next.length - watchDeduplicationWindow)
                      : next,
                    [event]
                  ] as const
                }
              )
            )
          })
        )

    /**
     * Journal entries plus the ancestry deltas they disclose.
     *
     * The expansion runs after the follow branch's deduplication, so a derived
     * event never competes for the `(runId, sequence)` key its own entry was
     * deduplicated on.
     */
    const watch = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> =>
      entries(filter).pipe(
        Stream.map((event): ReadonlyArray<ControlEvent> => {
          const lineage = Lineage.derive(event)
          return [
            event,
            ...(lineage === undefined ? [] : [lineage]),
            ...Steering.derive(event)
          ]
        }),
        Stream.flattenIterable
      )

    const service: Service = {
      plan: Effect.fn("Control.plan")((input) =>
        Effect.gen(function*() {
          const card = yield* runtime.plan(input)
          yield* emit(`plan:${card.planId}`, "control.plan.created", {
            planId: card.planId,
            flowId: card.flowId,
            digest: card.digest
          })
          return card
        })
      ),
      run: Effect.fn("Control.run")((input) =>
        mutate<
          RunNotFound | PlanDigestMismatch | EnvelopeMismatch | ClaimLost | LaunchFailed | PersistenceError,
          never
        >(
          "run",
          input.idempotencyKey,
          fingerprint("run", input),
          input._tag === "Resume"
            ? Effect.gen(function*() {
              const run = yield* runtime.resume(input.runId)
              yield* emit(input.runId, "control.run.resumed", {
                runId: input.runId,
                status: run.status
              })
              return terminalOrAccepted(input.idempotencyKey, run)
            })
            : Effect.gen(function*() {
              const launched = yield* runtime.launch(input.planId, input.digest, input.envelope)
              if (launched._tag === "Parked") {
                return { ...launched.receipt, receiptId: input.idempotencyKey }
              }
              yield* emit(launched.run.runId, "control.run.accepted", {
                runId: launched.run.runId,
                planId: input.planId,
                digest: input.digest,
                status: launched.run.status
              })
              const plan = yield* runtime.getPlan(input.planId)
              const acceptance = Option.isSome(executor)
                ? yield* executor.value.launch({ plan, run: launched.run })
                : "pending"
              if (acceptance === "accepted") {
                const fence = yield* runtime.claimFence(launched.run.runId)
                const running = yield* runtime.writeStatus(launched.run.runId, fence, "running")
                yield* emit(launched.run.runId, "control.run.running", {
                  runId: launched.run.runId,
                  status: running.status
                })
              } else {
                yield* emit(launched.run.runId, "control.run.pending", {
                  runId: launched.run.runId,
                  status: launched.run.status
                })
              }
              return {
                _tag: "Accepted",
                receiptId: input.idempotencyKey,
                runId: launched.run.runId
              }
            })
        )
      ),
      approve: Effect.fn("Control.approve")((input) => decide("approved", input)),
      deny: Effect.fn("Control.deny")((input) => decide("denied", input)),
      steer: Effect.fn("Control.steer")((input: SteerInput) =>
        mutate(
          "steer",
          input.idempotencyKey,
          fingerprint("steer", input),
          Effect.gen(function*() {
            const run = yield* runtime.getRun(input.runId)
            // A run that will never take another turn cannot be steered, and
            // storing the steer anyway would leave an operator watching a
            // message that has no boundary left to deliver it.
            if (terminal(run.status)) return { _tag: "Terminal", runId: run.runId, status: run.status }
            const item = steerItem(input.message)
            yield* notifications.admit(input.runId, {
              _tag: "human-steer",
              id: input.message.messageId,
              delivery: "steer",
              targetLineageId: input.runId,
              provenance: {
                sourceRunId: input.runId,
                sourceLineageId: input.runId,
                sourceTurn: 0,
                sourceActor: `${input.message.principal.kind}:${input.message.principal.id}`
              },
              payload: SteerPayload.encode(item) as ControlEvent["payload"]
            }).pipe(
              Effect.mapError((cause) =>
                new PersistenceError({
                  operation: "control.steer.notification",
                  message: "Failed to admit steering notification",
                  cause
                })
              )
            )
            yield* emit(input.runId, Steering.enqueuedEventType, {
              runId: input.runId,
              messageId: input.message.messageId,
              kind: item.kind
            })
            yield* wake(run, input.message.messageId)
            return accepted(input.idempotencyKey, input.runId)
          })
        )
      ),
      signal: Effect.fn("Control.signal")((input: SignalInput) =>
        Effect.gen(function*() {
          const key = fingerprint("signal", input)
          // The idempotency lookup runs first and outside the mutation, because
          // delivery has to happen before the record and a re-sent signal must
          // answer with its original receipt rather than be matched against a
          // wait point its own first delivery already closed.
          const prior = yield* runtime.lookupMutation(`signal:${input.idempotencyKey}`, key)
          if (prior !== undefined) {
            return prior._tag === "AlreadyApplied" ? { ...prior, receiptId: input.idempotencyKey } : prior
          }
          const current = yield* runtime.getRun(input.runId)
          if (terminal(current.status)) {
            return { _tag: "Terminal", runId: current.runId, status: current.status }
          }
          // Delivery decides the receipt, and it runs OUTSIDE the mutation's
          // write transaction: completing a wait point re-drives the run, and
          // the engine's own deferred completion flushes the journal on its way
          // out — a flush that waits on the writer this transaction would be
          // holding. A crash between delivery and record leaves the run awake
          // with no control record, which is the survivable half of the pair.
          const delivery = Option.isNone(executor)
            ? "unknown" as const
            : yield* executor.value.deliverSignal({ runId: input.runId, signal: input.signal })
          // The run is parked, and parked on something else. Recording a
          // delivery here would leave an operator watching a signal that never
          // lands, which is exactly the partial behavior rc.0 forbids.
          if (delivery === "no-match") {
            return yield* new NoMatchingWait({ runId: input.runId, name: input.signal.name })
          }
          return yield* mutate(
            "signal",
            input.idempotencyKey,
            key,
            Effect.gen(function*() {
              yield* runtime.deliverSignal(input.runId, input.signal)
              yield* emit(input.runId, "control.signal.delivered", {
                runId: input.runId,
                name: input.signal.name,
                payload: input.signal.payload
              })
              return accepted(input.idempotencyKey, input.runId)
            })
          )
        })
      ),
      cancel: Effect.fn("Control.cancel")((input) =>
        mutate(
          "cancel",
          input.idempotencyKey,
          fingerprint("cancel", input),
          Effect.gen(function*() {
            const current = yield* runtime.getRun(input.runId)
            // A run that has already settled cannot be cancelled, and a cancel
            // request journaled against it would be a request nothing can ever
            // act on. Answer with what actually happened to the run.
            if (terminal(current.status)) {
              return { _tag: "Terminal", runId: current.runId, status: current.status }
            }
            // The durable half, and the only half that reaches a run another
            // process owns: fibers are process-local, so an interrupt can only
            // stop a run this process is driving. The executor writes
            // `cancel_requested_at_ms` on the engine row instead, and the
            // owner's cancel poll acts on it within a heartbeat.
            //
            // It runs INSIDE the mutation's transaction on purpose. An engine
            // that refuses the request rolls the whole cancel back — no
            // attribution event, no terminal control status — because a
            // control row that says `cancelled` while the engine row is still
            // running is the one state an operator can never recover from.
            //
            // It runs BEFORE the attribution event for the mirror-image
            // reason. The control row this plane read may be stale — the two
            // `flows_runs` tables are two files in the shipped CLI — and an
            // engine row that has already settled makes the cancel a request
            // nobody can act on. Attributing and transitioning it anyway is
            // exactly the terminal disagreement B-11 forbids, so the engine's
            // own status becomes the receipt and nothing else happens.
            const record = yield* executorRequestCancel(input.runId)
            if (typeof record !== "string") {
              return { _tag: "Terminal", runId: input.runId, status: record.status }
            }
            const principal = yield* runtime.stampPrincipal(input.principal)
            // Attribution before the interrupt, and in the mutation's own
            // transaction. A cancellation that committed without it would be
            // durable and anonymous, and nothing afterwards could say who asked.
            yield* emit(
              input.runId,
              Cancellation.requestedEventType,
              json({
                runId: input.runId,
                source: "control",
                principal,
                ...(input.reason === undefined ? {} : { reason: input.reason })
              })
            )
            const run = yield* runtime.interrupt(input.runId).pipe(
              // Another live process owns the run. The request is durable and
              // that process will act on it, so the honest receipt is
              // `Accepted` — the cancel was taken — rather than `ClaimLost`,
              // which reads as a refusal.
              Effect.catchTag("/control/ClaimLost", () => Effect.succeed(undefined))
            )
            return run === undefined
              ? accepted(input.idempotencyKey, input.runId)
              : terminalOrAccepted(input.idempotencyKey, run)
          })
        )
      ),
      resume: Effect.fn("Control.resume")((input) => runMutation(input)),
      list,
      watch
    }
    return Control.of(service)
  })
)
