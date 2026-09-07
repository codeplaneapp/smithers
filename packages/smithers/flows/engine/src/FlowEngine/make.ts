// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Adapts a low-level `Encoded` implementation into the typed `FlowRuntime`
 * port `@smthrs/flow` declares.
 *
 * @since 0.1.0
 */
import {
  Action,
  type DurableClock,
  type DurableDeferred,
  Flow,
  FlowRuntime,
  RetryPolicy,
  StepIdentity
} from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { renderDiagnostic } from "../internal/Diagnostic.ts"
import { actionKey, ordinalScope, uncanonicalKey } from "./ActionKey.ts"
import type { ActionExecuteOptions, Encoded } from "./Encoded.ts"
import { FlowNotRegistered, SnapshotBoundaryRequired, SuspendedResumeGaveUp } from "./Errors.ts"
import * as Round from "./Round.ts"
import { SnapshotBoundary, type SnapshotBoundaryOptions } from "./SnapshotBoundary.ts"

const toJsonExit = Exit.map((value: any) => value ?? null)

/**
 * The allocation scope derived once by the dispatch wrapper and consumed by
 * the ordinal allocator inside it. Keeping one value in context makes the
 * concurrent guard and allocation path incapable of checking different
 * identities.
 *
 * @private
 */
const ActionOrdinalScope = Context.Service<never, string>(
  "@smthrs/engine/FlowEngine/ActionOrdinalScope"
)

/**
 * Builds a typed `FlowRuntime` service from a low-level encoded
 * implementation.
 *
 * **When to use**
 *
 * Use when wiring a trusted low-level flow engine implementation into the
 * typed `FlowRuntime` port.
 *
 * **Gotchas**
 *
 * The implementation must correctly persist, resume, and encode flow state.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeUnsafe = (options: Encoded): FlowRuntime.FlowRuntime["Service"] => {
  /**
   * The declarations this engine has been told about, by tag. A handoff names
   * its target by tag — it is serializable data that crossed a journal — so
   * following the lineage needs the declaration back to decode the next
   * round's payload and to read its round budget.
   */
  const declarations = new Map<string, Array<{ readonly flow: Flow.Any }>>()
  return FlowRuntime.FlowRuntime.of({
    // Untraced because registering a flow recursively re-enters the engine.
    register: Effect.fnUntraced(function*(flow, execute) {
      const services = yield* Effect.context<FlowRuntime.FlowRuntime>()
      const registration = { flow }
      const existing = declarations.get(flow._tag)
      const entries = existing ?? []
      if (existing === undefined) declarations.set(flow._tag, entries)
      entries.push(registration)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          entries.splice(entries.indexOf(registration), 1)
          if (entries.length === 0) declarations.delete(flow._tag)
        })
      )
      yield* options.register(
        flow,
        (payload, executionId) =>
          Effect.matchEffect(Effect.suspend(() => execute(payload, executionId)), {
            onFailure: (error) =>
              Effect.matchEffect(flow.errorSchema.makeEffect(error), {
                // A body failure outside the flow's declared error schema is a
                // defect, and the defect is the ERROR, not the schema issue
                // about it. `orDie` on the validation reported only the
                // mismatch: for a flow declaring no error the whole report was
                // `InvalidType(<Never>)`, which erased the one message the
                // operator needed — the interpreter's refusal naming the
                // action it could not resolve. Dying with the error itself
                // keeps that message, and keeps it durably: the driver encodes
                // a settled exit through `Flow.Result({ success, error:
                // flow.errorSchema })`, whose defect channel is
                // `Schema.Defect`, so an undeclared failure delivered as a
                // FAILURE could not be encoded at all and left the run row
                // `running` and owned forever.
                //
                // The raw error stays IN THIS PROCESS. `FlowProxyServer` is
                // the boundary that must not republish it: a defect crossing
                // that boundary is rewritten to a redacted refusal there.
                onFailure: () =>
                  Effect.andThen(
                    Effect.annotateLogs(
                      Effect.logError("A flow body failed with an error outside its declared error schema"),
                      { flow: flow._tag, error: renderDiagnostic(error) }
                    ),
                    Effect.die(error)
                  ),
                onSuccess: () => Effect.fail(error)
              }),
            onSuccess: (value) =>
              Effect.flatMap(FlowRuntime.FlowInstance, (instance) =>
                // A handoff has no success value for this round. Its handler
                // returns `undefined` only to leave through `Flow.intoResult`,
                // which replaces that value with the recorded handoff.
                instance.handoff === undefined
                  ? Effect.as(Effect.orDie(flow.successSchema.makeEffect(value)), value)
                  : Effect.succeed(value))
          }).pipe(
            Effect.updateContext(
              (input) => Context.merge(services, input) as Context.Context<any>
            )
          )
      )
    }),
    // Untraced because flow execution recursively invokes child flows.
    execute: Effect.fnUntraced(function*<
      Name extends string,
      Payload extends Flow.AnyStructSchema,
      Success extends Schema.Top,
      Error extends Schema.Top,
      const Discard extends boolean = false
    >(
      self: Flow.Flow<Name, Payload, Success, Error, any>,
      opts: {
        readonly executionId: string
        readonly payload: Payload["Type"]
        readonly discard?: Discard | undefined
        readonly suspendedRetryPolicy?:
          | RetryPolicy.RetryPolicy
          | undefined
      }
    ) {
      const payload = opts.payload
      const executionId = opts.executionId
      const lineageBudget = self.maxRounds
      const suspendedRetryPolicy = opts.suspendedRetryPolicy ?? RetryPolicy.defaultRetryPolicy
      yield* Effect.annotateCurrentSpan({ executionId })
      let result = Option.none<Flow.Result<Success["Type"], Error["Type"]>>()
      let round = Round.initial(executionId)
      let roundFlow = self as Flow.Any
      let roundExecutionId = executionId
      let roundPayload = payload as object

      // link interruption with parent flow
      const parentInstance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
      if (Option.isSome(parentInstance)) {
        const instance = parentInstance.value
        yield* Effect.addFinalizer(() => {
          if (!instance.interrupted || (Option.isSome(result) && result.value._tag === "Complete")) {
            return Effect.void
          }
          // A finalizer cannot report, so a durable engine's
          // `CancelRequestFailed` is logged rather than swallowed silently.
          // The child is not orphaned by it: the parent's own cancellation is
          // already durable, and a durable engine cascades cancellation over
          // the persisted parent-edge table independently of this in-process
          // link (`RunDriver.cancelOwned`), so this path is the prompt
          // delivery and not the guarantee.
          return options.interrupt(roundFlow, roundExecutionId).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `engine: could not record the linked cancellation of child execution ${roundExecutionId}`,
                error
              )
            )
          )
        })
      }
      const runRound = (
        roundFlow: Flow.Any,
        roundExecutionId: string,
        roundPayload: object,
        round: Round.Round & { readonly previousExecutionId?: string | undefined },
        parent: FlowRuntime.FlowInstance["Service"] | undefined
      ): Effect.Effect<Flow.Result<Success["Type"], Error["Type"]>> =>
        options.execute(roundFlow, {
          executionId: roundExecutionId,
          payload: roundPayload,
          discard: opts.discard ?? false,
          parent,
          round
        }) as Effect.Effect<Flow.Result<Success["Type"], Error["Type"]>>
      let current = runRound(
        roundFlow,
        roundExecutionId,
        roundPayload,
        round,
        Option.getOrUndefined(parentInstance)
      )

      if (opts.discard) {
        yield* current
        return executionId
      }

      // The lineage this caller is following. Round 0 is the execution it
      // asked for; every later round is a separate execution with its own
      // journal, derived from the lineage and the ordinal so a restart lands
      // on the same one (`docs/specs/Concepts/Trampoline Loops.md`).
      let resumeAttempt = 0
      // The expiration origin for the resume loop is in-process by design:
      // the loop itself only lives as long as this caller, and a restart
      // re-enters `execute` with a fresh budget. What must not happen is the
      // bound being silently inert (issue #45): `expirationMs` on the
      // suspended retry policy caps the wall-clock time this caller keeps
      // polling a suspended execution.
      const resumeStartMs = yield* Clock.currentTimeMillis
      while (true) {
        const wrapped = Option.isSome(parentInstance)
          ? yield* Flow.wrapActionResult(
            current,
            (result) => result._tag === "Suspended"
          )
          : yield* current
        result = Option.some(wrapped)
        if (wrapped._tag === "Complete") {
          return yield* wrapped.exit as Exit.Exit<any>
        }
        if (wrapped._tag === "Handoff") {
          // The round settled by naming the next one. Following it here is
          // what makes the trampoline transparent to the caller: one
          // `execute` answers with the LINEAGE's value, and each round keeps
          // its own execution id and journal underneath.
          // DECIDED (2026-08-11, pending review): `maxRounds` belongs to the
          // lineage originator. A multi-flow handoff cannot reset or replace
          // the budget by naming a target with a different declaration.
          const advanced = yield* Round.next(round, {
            flowName: self._tag,
            maxRounds: lineageBudget
          }).pipe(Effect.catch((error) => Effect.die(error)))
          // DECIDED (2026-08-11, pending review): a caller that cannot
          // resolve the target dies rather than answering with the raw
          // handoff. The round is durable either way, so the lineage is not
          // lost — what is wrong is this caller's wiring, and saying so is
          // the same posture `execute` takes for an unregistered flow.
          const target = declarations.get(wrapped.flow)?.at(-1)?.flow
          if (target === undefined) {
            return yield* Effect.die(
              new FlowNotRegistered({
                flowName: wrapped.flow,
                message:
                  `${roundFlow._tag} handed off to flow ${wrapped.flow}, which is not registered with this engine`
              })
            )
          }
          // A handoff payload travels encoded, so the next round's own schema
          // is what turns it back into the payload that round is planned with.
          const decoded = yield* Effect.orDie(
            Schema.decodeUnknownEffect(Schema.toCodecJson(target.payloadSchema))(wrapped.payload)
          ) as Effect.Effect<object>
          const previousExecutionId = roundExecutionId
          round = advanced.round
          roundFlow = target
          roundExecutionId = advanced.executionId
          roundPayload = decoded
          current = runRound(
            roundFlow,
            roundExecutionId,
            roundPayload,
            { ...round, previousExecutionId },
            undefined
          )
          continue
        }
        if (Option.isSome(parentInstance)) {
          return yield* Flow.suspend(parentInstance.value)
        }
        // The resume delay is derived from the attempt count (data policy) so
        // backoff survives a restart.
        resumeAttempt = resumeAttempt + 1
        const elapsedMs = (yield* Clock.currentTimeMillis) - resumeStartMs
        const delay = yield* RetryPolicy.nextDelayEffect(
          suspendedRetryPolicy,
          resumeAttempt,
          { elapsedMs }
        )
        if (Option.isNone(delay)) {
          // Distinguish the wall-clock give-up from attempt exhaustion: the
          // delay is only elapsed-dependent when dropping `elapsedMs` would
          // have allowed another attempt.
          const expired = Option.isSome(
            RetryPolicy.nextDelay(suspendedRetryPolicy, resumeAttempt)
          )
          const reason = expired ? "expired" : "exhausted"
          return yield* Effect.die(
            new SuspendedResumeGaveUp({
              flowName: self._tag,
              executionId,
              attempt: resumeAttempt,
              elapsedMs,
              reason,
              message: `${self._tag}.execute: suspendedRetryPolicy ${reason}`
            })
          )
        }
        const sleep = Effect.sleep(delay.value)
        yield* (options.resumeSignal === undefined
          ? sleep
          : Effect.raceFirst(sleep, options.resumeSignal(roundFlow, roundExecutionId)))
        yield* options.resume(roundFlow, roundExecutionId)
        current = runRound(
          roundFlow,
          roundExecutionId,
          roundPayload,
          round,
          undefined
        )
      }
    }),
    poll: options.poll,
    interrupt: options.interrupt,
    interruptUnsafe: options.interruptUnsafe,
    resume: options.resume,
    // Untraced because action retries are a hot path within a flow run.
    actionExecute: Effect.fnUntraced(function*<
      Success extends Schema.Constraint,
      Error extends Schema.Constraint,
      R
    >(action: Action.Action<Success, Error, R>, attempt: number) {
      const instance = yield* FlowRuntime.FlowInstance
      const scope = yield* ActionOrdinalScope
      // `Action.retry` hands down an empty slot map rather than a number:
      // the ordinal can only be allocated here, where the action — and so
      // its allocation scope — is known (issue #73). The slot is keyed by
      // scope so a retry block dispatching several distinct actions pins
      // each to its own ordinal (issue #84), reused across every attempt of
      // the sequence. Within one attempt the n-th dispatch of a scope takes
      // the n-th pinned ordinal (issue #100): a retry block may dispatch one
      // declaration several times, and each dispatch owns its own identity —
      // allocated on the attempt that first reaches it, replayed by position
      // on every later attempt.
      const slot = yield* Action.CurrentOrdinal
      let ordinal: number
      if (slot === undefined) {
        ordinal = instance.actionState.nextOrdinal(scope)
      } else {
        const index = slot.cursors.get(scope) ?? 0
        slot.cursors.set(scope, index + 1)
        const pinned = slot.values.get(scope) ?? []
        if (index < pinned.length) {
          ordinal = pinned[index]!
        } else {
          ordinal = instance.actionState.nextOrdinal(scope)
          pinned.push(ordinal)
          slot.values.set(scope, pinned)
        }
      }
      // Invocation keys are run-local, so the environment is not their key
      // material; `actionKey` folds it into cache keys only (issue #75).
      const environment = yield* Action.CurrentCacheEnvironment
      // `AnyWithProps` widening: `actionKey` needs the declared schemas so
      // the string-form sealed identity folds the compiled declaration
      // (issue #120); every action built by `Action.make` carries them,
      // only the `Schema.Constraint` type parameters resist the assignment.
      const keyResult = yield* Effect.result(actionKey(
        action as unknown as Action.AnyWithProps,
        instance.executionId,
        ordinal,
        environment,
        scope
      ))
      /* v8 ignore next 3 -- defensive typed guard (issue #151): rejected
         caller identity material always fails the ordinal-scope derivation
         above first, so this branch is unreachable until the environment or
         hermetic folding gains fallible material of its own. */
      if (Result.isFailure(keyResult)) {
        return uncanonicalKey(action.name, keyResult.failure)
      }
      const key = keyResult.success
      const policy = action.retryPolicy
      // Elapsed retry time for the policy's expiration bound. Durable
      // drivers persist the first attempt's start time alongside the attempt
      // row and expose it through `actionRetryOrigin`, so the
      // schedule-to-close budget survives park/resume and process death
      // (issue #45, mirroring Temporal's persisted expiration interval). The
      // in-process clock is the fallback for engines without durable
      // attempts.
      const durableOrigin = policy?.expirationMs !== undefined &&
          options.actionRetryOrigin !== undefined
        ? yield* options.actionRetryOrigin({ key })
        : Option.none<number>()
      if (
        policy?.expirationMs !== undefined &&
        options.actionRetryOrigin !== undefined &&
        Option.isNone(durableOrigin)
      ) {
        // A durable driver that finds no surviving attempt row cannot bound
        // the schedule-to-close budget to the true first attempt. The engine
        // keeps the in-process fallback — failing the run outright would
        // turn benign attempt-row retention pruning into spurious failures —
        // but the restarted budget is worth a trace (issue #69).
        yield* Effect.logWarning(
          `FlowEngine.actionExecute: no durable retry origin for "${action.name}"; the expirationMs budget restarts from the current clock`
        )
      }
      const now = yield* Clock.currentTimeMillis
      const origin = Option.getOrUndefined(durableOrigin)
      const unusableOrigin = origin !== undefined && (!Number.isFinite(origin) || origin > now)
      if (unusableOrigin) {
        yield* Effect.logWarning(
          `FlowEngine.actionExecute: unusable durable retry origin for "${action.name}": ` +
            `reported ${String(origin)} while the current clock is ${now}; the expirationMs budget starts now`
        )
      }
      const usableOrigin = origin !== undefined && Number.isFinite(origin)
        ? Math.min(origin, now)
        : undefined
      const retryStartMs = usableOrigin ?? now
      // Resume the durable attempt counter (issue #59): a persisted attempt
      // sequence keeps its numbering across process death, so replayed
      // failed attempts do not re-sleep the backoff ladder from attempt 1
      // and the retry decision below sees the true attempt count.
      const latestAttempt = options.actionLatestAttempt !== undefined
        ? yield* options.actionLatestAttempt({ key })
        : Option.none<number>()
      const durableAttempt = Option.getOrUndefined(latestAttempt)
      const usableAttempt = durableAttempt !== undefined && Number.isSafeInteger(durableAttempt)
      if (durableAttempt !== undefined && !usableAttempt) {
        yield* Effect.logWarning(
          `FlowEngine.actionExecute: rejected unusable durable latest attempt for "${action.name}": ` +
            `${String(durableAttempt)} is not a safe integer; using caller attempt ${attempt}`
        )
      }
      let currentAttempt = usableAttempt && durableAttempt > attempt
        ? durableAttempt
        : attempt
      while (true) {
        if (
          action.tier === "irreversible" &&
          currentAttempt > 1 &&
          action.idempotencyKey === undefined
        ) {
          return yield* Effect.die(
            new Action.IrreversibleRetryRequiresIdempotencyKey({
              actionName: action.name,
              attempt: currentAttempt
            })
          )
        }
        const input: ActionExecuteOptions = {
          action,
          attempt: currentAttempt,
          key,
          tier: action.tier,
          ...(action.nondeterministic === undefined ? {} : { nondeterministic: action.nondeterministic }),
          metadata: action.metadata
        }
        let result: Flow.Result<unknown, unknown>
        if (action.tier === "compensable") {
          const boundaryOption = yield* Effect.serviceOption(SnapshotBoundary)
          if (Option.isNone(boundaryOption)) {
            return yield* Effect.die(
              new SnapshotBoundaryRequired({
                actionName: action.name,
                message: `Compensable action "${action.name}" requires SnapshotBoundary`
              })
            )
          }
          const boundary = boundaryOption.value
          const boundaryOptions: SnapshotBoundaryOptions = {
            flow: instance.flow,
            executionId: instance.executionId,
            key,
            attempt: currentAttempt,
            metadata: action.metadata
          }
          if (currentAttempt > 1 && instance.actionState.snapshots.has(key)) {
            yield* boundary.restore(
              instance.actionState.snapshots.get(key),
              boundaryOptions
            )
          }
          const snapshot = yield* boundary.snapshot(boundaryOptions)
          instance.actionState.snapshots.set(key, snapshot)
          result = yield* options.actionExecute(input).pipe(
            Effect.ensuring(Effect.asVoid(boundary.diff(snapshot, boundaryOptions))),
            Effect.provideService(Action.CurrentAttempt, currentAttempt),
            Effect.provideService(Action.CurrentInvocationKey, key)
          )
        } else {
          result = yield* options.actionExecute(input).pipe(
            Effect.provideService(Action.CurrentAttempt, currentAttempt),
            // DECIDED (2026-08-11, pending review): the dispatch's own key is
            // handed to the implementation rather than left engine-private. An
            // implementation that names durable state of its own — `Sleep`
            // names a `DurableClock` — needs identity that is stable across
            // replays of one node and distinct between two identical calls,
            // and this key already is both: it is allocated here on EVERY
            // dispatch, including a replayed one, because the driver reached
            // through `options.actionExecute` addresses the recorded outcome
            // by it. Deriving a second identity in the implementation would
            // duplicate the allocation and drift from it; the attempt is
            // deliberately not folded in, so a retried wait rejoins the timer
            // it already armed.
            Effect.provideService(Action.CurrentInvocationKey, key)
          )
        }
        // Suspension is the action path's only non-exit settlement; the
        // narrowing is written as "not complete" so the flow-only handoff
        // variant needs no unreachable arm of its own.
        if (result._tag !== "Complete") {
          return result
        }
        // The engine's single retry decision point. The delay is derived from
        // the attempt count — persisted by durable engines and passed back in
        // on resume — so a backoff sequence survives process death.
        // nonRetryable classification is evaluated here and nowhere else.
        if (policy !== undefined && result.exit._tag === "Failure") {
          const failure = result.exit.cause.reasons.find(Cause.isFailReason)
          if (failure !== undefined) {
            const decision = yield* RetryPolicy.decideEffect(policy, {
              attempt: currentAttempt,
              error: failure.error,
              elapsedMs: (yield* Clock.currentTimeMillis) - retryStartMs
            })
            if (decision._tag === "RetryAfter") {
              if (action.tier === "irreversible" && action.idempotencyKey === undefined) {
                return yield* Effect.die(
                  new Action.IrreversibleRetryRequiresIdempotencyKey({
                    actionName: action.name,
                    attempt: currentAttempt + 1
                  })
                )
              }
              yield* Effect.sleep(decision.delayMs)
              currentAttempt = currentAttempt + 1
              continue
            }
            // Exhaustion is a retry decision, not a change to the action's
            // declared error channel. Preserve the final business failure so
            // ordinary typed recovery (including a graph Catch) still runs.
            yield* Effect.annotateCurrentSpan({
              "retry.stopReason": decision.reason,
              "retry.attempt": currentAttempt
            })
            // nonRetryable: fall through and propagate the original failure.
          }
        }
        const exit = yield* Effect.orDie(
          Schema.decodeEffect(action.exitSchemaPartial)(toJsonExit(result.exit)).pipe(
            // An action whose recorded outcome does not match its declared
            // schemas is a defect either way, but `orDie` alone reports only
            // the schema mismatch — "Expected /harness/HarnessError at
            // [cause][failures][0][error][_tag]" — and never the error that
            // actually occurred, which can leave a real failure (a refused
            // step boundary, say) undiagnosable. Naming the action and its
            // recorded exit turns that into one legible log line.
            Effect.tapError(() =>
              Effect.annotateLogs(
                Effect.logError("A recorded action outcome does not match the action's declared schemas"),
                { action: action.name, exit: renderDiagnostic(toJsonExit(result.exit)) }
              )
            )
          )
        )
        return new Flow.Complete({ exit })
      }
    }, (body, action) =>
      // Ordinal-keyed invocations of one allocation scope are
      // allocation-ordered: with two in flight at once the ordinals — and so
      // the step keys, attempt rows, and recorded outcomes — would be
      // assigned by fiber arrival order, and a crash-resume replaying the
      // fibers in the opposite order would silently hand one invocation the
      // other's recorded outcome (issue #111). Interpreter graph nodes carry
      // replay-stable structural sites, so distinct nodes refine the scope
      // and may overlap. Indistinguishable dispatches — the same site, or
      // handler-driven calls with no site — still have no engine-visible
      // material to order them by (inputs live in the execute closure), so
      // the hazard is refused up front. A declared idempotencyKey also
      // distinguishes invocations when its values differ.
      // Only a sealed action with a key escapes the refusal: it takes a
      // pure cache key with no ordinal at all. A keyed action at any
      // other tier still resolves to an invocation key whose scope folds the
      // key, so two concurrent SAME-key dispatches share one scope and have
      // exactly the arrival-order hazard — and, nested in sibling retry
      // blocks under a shared outer block, the #116 private cursor views
      // would even hand both dispatches the same pinned ordinal (issue
      // #130). Distinct keys are distinct scopes and overlap freely.
      Effect.gen(function*() {
        const dispatchSite = yield* Effect.serviceOption(StepIdentity.DispatchSite)
        const site = Option.getOrUndefined(dispatchSite)
        const scopeResult = yield* Effect.result(ordinalScope(action, site))
        if (Result.isFailure(scopeResult)) {
          return uncanonicalKey(action.name, scopeResult.failure)
        }
        const scope = scopeResult.success
        const scopedBody = body.pipe(Effect.provideService(ActionOrdinalScope, scope))
        if (action.tier === "sealed" && action.idempotencyKey !== undefined) return yield* scopedBody
        const instance = yield* FlowRuntime.FlowInstance
        const inFlight = instance.actionState.keylessInFlight
        // The acquire and its release live in one uninterruptible region
        // (issue #139): a bare `add` followed by `Effect.ensuring` left a
        // one-op window — after the add, before the finalizer registered —
        // where an interruption (a lost race, a timeout) leaked the scope
        // into the Set forever, so every later fully sequential dispatch of
        // the same scope falsely died `ConcurrentKeylessDispatch`.
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            if (inFlight.has(scope)) return false
            inFlight.add(scope)
            return true
          }),
          (acquired) =>
            acquired
              ? scopedBody
              : Effect.die(
                new Action.ConcurrentKeylessDispatch({ actionName: action.name })
              ),
          (acquired) => acquired ? Effect.sync(() => inFlight.delete(scope)) : Effect.void
        )
      })),
    // Untraced because the explicit span below carries deferred attributes.
    deferredResult: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>
      ) {
        const instance = yield* FlowRuntime.FlowInstance
        yield* Effect.annotateCurrentSpan({
          executionId: instance.executionId
        })
        const exit = yield* options.deferredResult(deferred)
        if (Option.isNone(exit)) {
          return Option.none()
        }
        // A persisted result means the annotated wait (if any) resolved: the
        // waiting annotation is consumed here so a replayed
        // `annotateWaiting` cannot classify a later, unrelated suspension
        // (issue #42).
        instance.waiting = undefined
        return Option.some(
          yield* Effect.orDie(
            Schema.decodeEffect(deferred.exitSchema)(toJsonExit(exit.value))
          ) as Effect.Effect<Exit.Exit<Success["Type"], Error["Type"]>>
        )
      },
      Effect.withSpan(
        "FlowEngine.deferredResult",
        (deferred) => ({
          attributes: { name: deferred.name }
        }),
        { captureStackTrace: false }
      )
    ),
    // Untraced because the explicit span below carries completion attributes.
    deferredDone: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>,
        opts: {
          readonly flowName: string
          readonly executionId: string
          readonly deferredName: string
          readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
        }
      ) {
        return yield* options.deferredDone({
          flowName: opts.flowName,
          executionId: opts.executionId,
          deferredName: opts.deferredName,
          exit: yield* Schema.encodeEffect(deferred.exitSchema)(
            opts.exit
          ) as Effect.Effect<Exit.Exit<unknown, unknown>>
        })
      },
      Effect.withSpan(
        "FlowEngine.deferredDone",
        (_, { deferredName, executionId }) => ({
          attributes: { name: deferredName, executionId }
        }),
        { captureStackTrace: false }
      )
    ),
    deferredDoneIfWaiting: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>,
        opts: {
          readonly flowName: string
          readonly executionId: string
          readonly deferredName: string
          readonly reason: string
          readonly token: string
          readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
        }
      ) {
        if (options.deferredDoneIfWaiting === undefined) return "NotWaiting" as const
        return yield* options.deferredDoneIfWaiting({
          flowName: opts.flowName,
          executionId: opts.executionId,
          deferredName: opts.deferredName,
          reason: opts.reason,
          token: opts.token,
          exit: yield* Schema.encodeEffect(deferred.exitSchema)(opts.exit) as Effect.Effect<
            Exit.Exit<unknown, unknown>
          >
        })
      },
      Effect.withSpan(
        "FlowEngine.deferredDoneIfWaiting",
        (_, { deferredName, executionId, reason }) => ({
          attributes: { name: deferredName, executionId, reason }
        }),
        { captureStackTrace: false }
      )
    ),
    // Untraced because the explicit span below carries clock attributes.
    scheduleClock: Effect.fnUntraced(
      function*(
        flow: Flow.Any,
        opts: { readonly executionId: string; readonly clock: DurableClock.DurableClock }
      ) {
        return yield* options.scheduleClock(flow, opts)
      },
      Effect.withSpan(
        "FlowEngine.scheduleClock",
        (_, opts) => ({
          attributes: { executionId: opts.executionId, name: opts.clock.name }
        }),
        { captureStackTrace: false }
      )
    )
  })
}
