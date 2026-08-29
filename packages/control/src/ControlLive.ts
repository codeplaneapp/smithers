/**
 * In-process Control implementation over `ControlRuntime`, the flow
 * registry, and the append-only journal.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Effect, Layer, Option, Semaphore, Stream } from "effect"
import {
  type ApprovalInput,
  Control,
  type RunMutationInput,
  type Service,
  type SignalInput,
  type SteerInput
} from "./Control.ts"
import {
  type ClaimLost,
  type ControlError,
  type EnvelopeMismatch,
  type LaunchFailed,
  PersistenceError,
  type PlanDigestMismatch,
  type RunNotFound,
  Unavailable
} from "./ControlError.ts"
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

const terminalOrAccepted = (
  key: IdempotencyKey,
  run: RunSummary
): Receipt =>
  run.status === "cancelled" || run.status === "completed" || run.status === "failed"
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
          return accepted(input.idempotencyKey, input.target._tag === "Node" ? input.target.runId : undefined)
        })
      )

    const runMutation = (
      operation: "pause" | "resume",
      input: RunMutationInput
    ): Effect.Effect<Receipt, RunNotFound | ClaimLost | PersistenceError> => {
      const transition = operation === "pause"
        ? runtime.pause(input.runId)
        : runtime.resume(input.runId)
      return mutate(
        operation,
        input.idempotencyKey,
        fingerprint(operation, input),
        Effect.gen(function*() {
          const run = yield* transition
          yield* emit(input.runId, `control.run.${operation}`, {
            runId: input.runId,
            status: run.status
          })
          return terminalOrAccepted(input.idempotencyKey, run)
        })
      )
    }

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
        const result = page(runs, request.cursor, request.limit)
        return result.nextCursor === undefined
          ? { _tag: "runs", items: result.items }
          : { _tag: "runs", items: result.items, nextCursor: result.nextCursor }
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

    const watch = (filter: WatchFilter): Stream.Stream<ControlEvent, ControlError> =>
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
            yield* runtime.getRun(input.runId)
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
              payload: { body: input.message.body }
            }).pipe(
              Effect.mapError((cause) =>
                new PersistenceError({
                  operation: "control.steer.notification",
                  message: "Failed to admit steering notification",
                  cause
                })
              )
            )
            yield* emit(input.runId, "control.steer.enqueued", {
              runId: input.runId,
              messageId: input.message.messageId
            })
            return accepted(input.idempotencyKey, input.runId)
          })
        )
      ),
      signal: Effect.fn("Control.signal")((input: SignalInput) =>
        mutate(
          "signal",
          input.idempotencyKey,
          fingerprint("signal", input),
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
      ),
      cancel: Effect.fn("Control.cancel")((input) =>
        mutate(
          "cancel",
          input.idempotencyKey,
          fingerprint("cancel", input),
          Effect.gen(function*() {
            yield* runtime.getRun(input.runId)
            yield* emit(input.runId, "control.run.cancel-requested", {
              runId: input.runId
            })
            const run = yield* runtime.interrupt(input.runId)
            return terminalOrAccepted(input.idempotencyKey, run)
          })
        )
      ),
      pause: Effect.fn("Control.pause")((input) => runMutation("pause", input)),
      resume: Effect.fn("Control.resume")((input) => runMutation("resume", input)),
      list,
      watch
    }
    return Control.of(service)
  })
)
