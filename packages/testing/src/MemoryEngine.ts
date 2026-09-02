/**
 * Reference in-memory flow engine with an externally owned replay store.
 *
 * @since 0.0.0
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import {
  type EngineSubject as EngineSubjectService,
  EngineSubject as EngineSubjectTag,
  type ExecutionResult,
  type FlowSpec,
  type JournalEntryLike,
  type StepSpec
} from "./EngineSubject.ts"
import { conflict, type ExecutionConflict } from "./internal/Execution.ts"
import { EngineUnavailableError, type ExecutionConflictError } from "./TestingError.ts"

type ExecutionStatus = ExecutionResult["status"] | "running"

interface StoredExecution {
  readonly executionId: string
  readonly flow: FlowSpec
  readonly payload: unknown
  readonly idempotencyKey: string | undefined
  readonly journal: ReadonlyArray<JournalEntryLike>
  readonly status: ExecutionStatus
  readonly value: unknown
}

interface StoreState {
  readonly executions: ReadonlyMap<string, StoredExecution>
  readonly idempotencyIndex: ReadonlyMap<string, string>
  readonly nextExecutionId: number
}

const EngineStoreTypeId: unique symbol = Symbol.for("/testing/MemoryEngine/EngineStore")

/**
 * Persistent state shared by one or more in-memory engine instances.
 *
 * The store owns flow specifications, journals, terminal results, and the
 * idempotency index. Live fibers are intentionally engine-local.
 *
 * @category models
 * @since 0.0.0
 */
export interface EngineStore {
  readonly [EngineStoreTypeId]: Ref.Ref<StoreState>
}

interface ActiveExecution {
  readonly deferred: Deferred.Deferred<ExecutionResult>
  /** An interrupt during startup waits for the worker instead of missing it. */
  readonly fiber: Deferred.Deferred<Fiber.Fiber<ExecutionResult>>
  activeStep: StepSpec | undefined
}

interface StepOutcome {
  readonly status: "completed" | "failed" | "suspended"
  readonly value: unknown
}

type Modification<A> =
  | { readonly found: false }
  | { readonly found: true; readonly value: A }

const makeResult = (
  executionId: string,
  status: ExecutionResult["status"],
  value: unknown
): ExecutionResult => value === undefined ? { executionId, status } : { executionId, status, value }

const storedResult = (execution: StoredExecution): ExecutionResult =>
  makeResult(
    execution.executionId,
    execution.status === "running" ? "suspended" : execution.status,
    execution.value
  )

const unavailable = (message: string): EngineUnavailableError => new EngineUnavailableError({ message })

const getExecution = (
  store: EngineStore,
  executionId: string
): Effect.Effect<StoredExecution, EngineUnavailableError> =>
  Ref.get(store[EngineStoreTypeId]).pipe(
    Effect.flatMap((state) => {
      const execution = state.executions.get(executionId)
      return execution === undefined
        ? Effect.fail(unavailable(`Execution ${executionId} is unavailable`))
        : Effect.succeed(execution)
    })
  )

const modifyExecution = <A>(
  store: EngineStore,
  executionId: string,
  f: (execution: StoredExecution) => readonly [A, StoredExecution]
): Effect.Effect<A, EngineUnavailableError> =>
  Ref.modify<StoreState, Modification<A>>(store[EngineStoreTypeId], (state) => {
    const execution = state.executions.get(executionId)
    if (execution === undefined) {
      return [
        { found: false as const },
        state
      ] as const
    }
    const [value, updated] = f(execution)
    const executions = new Map(state.executions)
    executions.set(executionId, updated)
    return [{ found: true as const, value }, { ...state, executions }] as const
  }).pipe(
    Effect.flatMap((result) =>
      result.found
        ? Effect.succeed(result.value)
        : Effect.fail(unavailable(`Execution ${executionId} is unavailable`))
    )
  )

const appendEntry = (
  store: EngineStore,
  executionId: string,
  stepKey: string,
  kind: string,
  outcome: JournalEntryLike["outcome"],
  value: unknown
): Effect.Effect<JournalEntryLike, EngineUnavailableError> =>
  modifyExecution(store, executionId, (execution) => {
    const entry: JournalEntryLike = value === undefined
      ? {
        index: execution.journal.length,
        stepKey,
        kind,
        outcome
      }
      : {
        index: execution.journal.length,
        stepKey,
        kind,
        outcome,
        value
      }
    return [entry, { ...execution, journal: [...execution.journal, entry] }] as const
  })

const findRecorded = (
  journal: ReadonlyArray<JournalEntryLike>,
  stepKey: string,
  outcome: JournalEntryLike["outcome"]
): JournalEntryLike | undefined => {
  for (let index = journal.length - 1; index >= 0; index--) {
    const entry = journal[index]
    if (entry !== undefined && entry.stepKey === stepKey && entry.outcome === outcome) {
      return entry
    }
  }
  return undefined
}

const firstFrontier = (
  flow: FlowSpec,
  journal: ReadonlyArray<JournalEntryLike>
): StepSpec | undefined => {
  const occurrences = new Map<string, number>()
  for (const step of flow.steps) {
    if (step.kind === "step") {
      const occurrence = occurrences.get(step.key) ?? 0
      occurrences.set(step.key, occurrence + 1)
      const completed = journal.filter(
        (entry) => entry.stepKey === step.key && entry.outcome === "completed"
      )
      if (completed[step.sealed ? 0 : occurrence] === undefined) return step
      continue
    }
    const winner = step.branches.find(
      (branch) => findRecorded(journal, branch.key, "completed") !== undefined
    )
    if (winner === undefined) return step
  }
  return undefined
}

const setStatus = (
  store: EngineStore,
  executionId: string,
  status: ExecutionStatus,
  value: unknown
): Effect.Effect<ExecutionResult, EngineUnavailableError> =>
  modifyExecution(store, executionId, (execution) => {
    const updated: StoredExecution = { ...execution, status, value }
    return [storedResult(updated), updated] as const
  })

const suspendIfRunning = (
  store: EngineStore,
  executionId: string,
  activeStep: StepSpec | undefined
): Effect.Effect<ExecutionResult, EngineUnavailableError> =>
  modifyExecution(store, executionId, (execution) => {
    if (execution.status !== "running") {
      return [storedResult(execution), execution] as const
    }
    const frontier = activeStep ?? firstFrontier(execution.flow, execution.journal)
    const journal = frontier === undefined
      ? execution.journal
      : [
        ...execution.journal,
        {
          index: execution.journal.length,
          stepKey: frontier.key,
          kind: frontier.kind,
          outcome: "suspended" as const
        }
      ]
    const updated: StoredExecution = {
      ...execution,
      journal,
      status: "suspended"
    }
    return [storedResult(updated), updated] as const
  })

const abort = (
  store: EngineStore,
  executionId: string,
  activeStep: StepSpec | undefined
): Effect.Effect<ExecutionResult, EngineUnavailableError> =>
  modifyExecution(store, executionId, (execution) => {
    if (execution.status === "completed" || execution.status === "failed" || execution.status === "aborted") {
      return [storedResult(execution), execution] as const
    }
    const frontier = activeStep ?? firstFrontier(execution.flow, execution.journal)
    const journal = frontier === undefined
      ? execution.journal
      : [
        ...execution.journal,
        {
          index: execution.journal.length,
          stepKey: frontier.key,
          kind: frontier.kind,
          outcome: "aborted" as const
        }
      ]
    const updated: StoredExecution = {
      ...execution,
      journal,
      status: "aborted",
      value: undefined
    }
    return [storedResult(updated), updated] as const
  })

const executeRaceBranch = (
  store: EngineStore,
  executionId: string,
  branch: StepSpec,
  input: unknown,
  index: number,
  winnerIndex: { value: number | undefined }
): Effect.Effect<unknown, unknown> => {
  const effect = branch.kind === "step"
    ? branch.run(input)
    : executeRace(store, executionId, branch, input)
  return effect.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) {
        return appendEntry(
          store,
          executionId,
          branch.key,
          branch.kind,
          "completed",
          exit.value
        ).pipe(Effect.asVoid, Effect.orDie)
      }
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return winnerIndex.value !== undefined && winnerIndex.value !== index
          ? appendEntry(
            store,
            executionId,
            branch.key,
            branch.kind,
            "aborted",
            undefined
          ).pipe(Effect.asVoid, Effect.orDie)
          : Effect.void
      }
      return appendEntry(
        store,
        executionId,
        branch.key,
        branch.kind,
        "failed",
        Cause.squash(exit.cause)
      ).pipe(Effect.asVoid, Effect.orDie)
    })
  )
}

const executeRace = (
  store: EngineStore,
  executionId: string,
  race: Extract<StepSpec, { readonly kind: "race" }>,
  input: unknown
): Effect.Effect<unknown, unknown> =>
  getExecution(store, executionId).pipe(
    Effect.orDie,
    Effect.flatMap((execution) => {
      for (const branch of race.branches) {
        const completed = findRecorded(execution.journal, branch.key, "completed")
        if (completed !== undefined) return Effect.succeed(completed.value)
      }
      if (race.branches.length === 0) {
        return Effect.fail(unavailable(`Race ${race.key} has no branches`))
      }
      const winnerIndex: { value: number | undefined } = { value: undefined }
      return Effect.raceAll(
        race.branches.map((branch, index) => executeRaceBranch(store, executionId, branch, input, index, winnerIndex)),
        {
          onWinner: ({ index }) => {
            winnerIndex.value = index
          }
        }
      ).pipe(
        Effect.tap(() =>
          Effect.gen(function*() {
            const settled = yield* getExecution(store, executionId)
            const winner = race.branches.find(
              (branch) =>
                findRecorded(settled.journal, branch.key, "completed") !==
                  undefined
            )
            for (const branch of race.branches) {
              if (branch === winner) continue
              const hasOutcome = settled.journal.some(
                (entry) =>
                  entry.stepKey === branch.key &&
                  (
                    entry.outcome === "aborted" ||
                    entry.outcome === "failed"
                  )
              )
              if (!hasOutcome) {
                yield* appendEntry(
                  store,
                  executionId,
                  branch.key,
                  branch.kind,
                  "aborted",
                  undefined
                )
              }
            }
          }).pipe(Effect.orDie)
        )
      )
    })
  )

const executeStep = (
  store: EngineStore,
  executionId: string,
  step: StepSpec,
  input: unknown,
  active: ActiveExecution,
  occurrence: number
): Effect.Effect<StepOutcome, EngineUnavailableError> =>
  getExecution(store, executionId).pipe(
    Effect.flatMap((execution) => {
      if (step.kind === "step") {
        const completed = execution.journal.filter(
          (entry) => entry.stepKey === step.key && entry.outcome === "completed"
        )
        const recorded = completed[step.sealed ? 0 : occurrence]
        if (recorded !== undefined) {
          return Effect.succeed({ status: "completed" as const, value: recorded.value })
        }
      } else {
        for (const branch of step.branches) {
          const recorded = findRecorded(execution.journal, branch.key, "completed")
          if (recorded !== undefined) {
            return Effect.succeed({ status: "completed" as const, value: recorded.value })
          }
        }
      }

      active.activeStep = step
      const effect = step.kind === "step"
        ? step.run(input)
        : executeRace(store, executionId, step, input)

      return Effect.exit(effect).pipe(
        Effect.flatMap((exit): Effect.Effect<StepOutcome, EngineUnavailableError> => {
          if (Exit.isSuccess(exit)) {
            const record = step.kind === "step"
              ? appendEntry(
                store,
                executionId,
                step.key,
                step.kind,
                "completed",
                exit.value
              ).pipe(Effect.asVoid)
              : Effect.void
            return record.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  active.activeStep = undefined
                })
              ),
              Effect.as({ status: "completed" as const, value: exit.value })
            )
          }
          if (Cause.hasInterruptsOnly(exit.cause)) {
            return suspendIfRunning(
              store,
              executionId,
              active.activeStep
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  active.activeStep = undefined
                })
              ),
              Effect.map((result) => ({
                status: "suspended" as const,
                value: result.value
              }))
            )
          }
          const value = Cause.squash(exit.cause)
          return appendEntry(
            store,
            executionId,
            step.key,
            step.kind,
            "failed",
            value
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                active.activeStep = undefined
              })
            ),
            Effect.as({ status: "failed" as const, value })
          )
        })
      )
    })
  )

const execute = (
  store: EngineStore,
  executionId: string,
  active: ActiveExecution
): Effect.Effect<ExecutionResult, EngineUnavailableError> =>
  Effect.gen(function*() {
    const execution = yield* getExecution(store, executionId)
    const occurrences = new Map<string, number>()
    let input = execution.payload
    for (const step of execution.flow.steps) {
      const occurrence = occurrences.get(step.key) ?? 0
      occurrences.set(step.key, occurrence + 1)
      const outcome = yield* executeStep(
        store,
        executionId,
        step,
        input,
        active,
        occurrence
      )
      if (outcome.status === "failed") {
        return yield* setStatus(store, executionId, "failed", outcome.value)
      }
      if (outcome.status === "suspended") {
        const suspended = yield* getExecution(store, executionId)
        return storedResult(suspended)
      }
      input = outcome.value
    }
    active.activeStep = undefined
    return yield* setStatus(store, executionId, "completed", input)
  })

const claimExecution = (
  store: EngineStore,
  options: {
    readonly flow: FlowSpec
    readonly payload: unknown
    readonly executionId?: string | undefined
    readonly idempotencyKey?: string | undefined
  }
): Effect.Effect<StoredExecution, ExecutionConflictError> =>
  Ref.modify<StoreState, Effect.Effect<StoredExecution, ExecutionConflictError>>(
    store[EngineStoreTypeId],
    (state) => {
      const joinedId = options.idempotencyKey === undefined
        ? undefined
        : state.idempotencyIndex.get(options.idempotencyKey)
      let nextExecutionId = state.nextExecutionId
      if (joinedId === undefined && options.executionId === undefined) {
        while (state.executions.has(`memory-${nextExecutionId}`)) {
          nextExecutionId += 1
        }
      }
      const executionId = joinedId ?? options.executionId ?? `memory-${nextExecutionId}`
      const existing = state.executions.get(executionId)
      if (existing !== undefined) {
        // A re-submission that matches joins the existing execution; one that
        // disagrees about the flow or the payload is refused rather than
        // silently running the original.
        const difference = conflict(
          executionId,
          { flowName: existing.flow.name, payload: existing.payload } satisfies ExecutionConflict,
          { flowName: options.flow.name, payload: options.payload } satisfies ExecutionConflict
        )
        return [
          Option.match(difference, {
            onNone: () => Effect.succeed(existing),
            onSome: (error) => Effect.fail(error)
          }),
          state
        ] as const
      }

      const execution: StoredExecution = {
        executionId,
        flow: options.flow,
        payload: options.payload,
        idempotencyKey: options.idempotencyKey,
        journal: [],
        status: "suspended",
        value: undefined
      }
      const executions = new Map(state.executions)
      executions.set(executionId, execution)
      const idempotencyIndex = new Map(state.idempotencyIndex)
      if (options.idempotencyKey !== undefined) {
        idempotencyIndex.set(options.idempotencyKey, executionId)
      }
      return [
        Effect.succeed(execution),
        {
          executions,
          idempotencyIndex,
          nextExecutionId: options.executionId === undefined
            ? nextExecutionId + 1
            : state.nextExecutionId
        }
      ] as const
    }
  ).pipe(Effect.flatten)

/**
 * Creates an empty persistent store for memory-engine executions.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeStore = (): Effect.Effect<EngineStore> =>
  Ref.make<StoreState>({
    executions: new Map(),
    idempotencyIndex: new Map(),
    nextExecutionId: 0
  }).pipe(
    Effect.map((state): EngineStore => ({ [EngineStoreTypeId]: state }))
  )

/**
 * Constructs an in-memory engine whose durable state is held by `store`.
 *
 * Closing the construction scope interrupts only this engine instance's live
 * fibers. A fresh engine built with the same store replays completed journal
 * entries and continues at the first unfinished step.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (
  store: EngineStore
): Effect.Effect<EngineSubjectService, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const active = new Map<string, ActiveExecution>()

    const start = Effect.fnUntraced(function*(
      executionId: string
    ): Effect.fn.Return<ExecutionResult, EngineUnavailableError> {
      const running = active.get(executionId)
      if (running !== undefined) return yield* Deferred.await(running.deferred)

      const execution = yield* getExecution(store, executionId)
      if (
        execution.status === "completed" ||
        execution.status === "failed" ||
        execution.status === "aborted"
      ) {
        return storedResult(execution)
      }

      const deferred = Deferred.makeUnsafe<ExecutionResult>()
      const activeExecution: ActiveExecution = {
        deferred,
        fiber: Deferred.makeUnsafe(),
        activeStep: undefined
      }
      const worker = execute(store, executionId, activeExecution).pipe(
        Effect.onInterrupt(() =>
          suspendIfRunning(
            store,
            executionId,
            activeExecution.activeStep
          ).pipe(
            Effect.tap((result) => Deferred.succeed(deferred, result)),
            Effect.asVoid,
            Effect.orDie
          )
        ),
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(executionId)
          })
        ),
        Effect.tap((result) => Deferred.succeed(deferred, result)),
        Effect.orDie
      )

      // Publishing an active entry and the fiber that owns it is one
      // interruption boundary. If cancellation could land between those two
      // writes, interrupt and resume would wait forever on deferreds no worker
      // can complete. A typed store failure still rolls the provisional entry
      // back, because no worker was successfully published to own its cleanup.
      yield* Effect.gen(function*() {
        active.set(executionId, activeExecution)
        yield* setStatus(store, executionId, "running", execution.value)
        const fiber = yield* Effect.forkIn(worker, scope)
        yield* Deferred.succeed(activeExecution.fiber, fiber)
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            active.delete(executionId)
          })
        ),
        Effect.uninterruptible
      )

      // Only arming is protected. A caller may stop waiting without stopping
      // the independently scoped execution, which is the engine's join
      // contract for run and resume.
      return yield* Deferred.await(deferred)
    })

    const engine: EngineSubjectService = EngineSubjectTag.of({
      name: "MemoryEngine",
      run: (options) =>
        Effect.gen(function*() {
          const execution = yield* claimExecution(store, options)
          return yield* start(execution.executionId)
        }),
      result: (executionId) => getExecution(store, executionId).pipe(Effect.map(storedResult)),
      interrupt: (executionId) =>
        Effect.gen(function*() {
          const running = active.get(executionId)
          const result = yield* abort(store, executionId, running?.activeStep)
          if (running !== undefined) {
            yield* Deferred.succeed(running.deferred, result)
            yield* Deferred.await(running.fiber).pipe(Effect.flatMap(Fiber.interrupt))
          }
        }).pipe(
          Effect.catchTag("EngineUnavailableError", () => Effect.void)
        ),
      resume: start,
      journal: (executionId) =>
        getExecution(store, executionId).pipe(
          Effect.map((execution) => execution.journal)
        )
    })
    return engine
  })

/**
 * Provides a scoped in-memory engine backed by `store`.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (store: EngineStore): Layer.Layer<EngineSubjectService> =>
  Layer.effect(EngineSubjectTag)(make(store))
