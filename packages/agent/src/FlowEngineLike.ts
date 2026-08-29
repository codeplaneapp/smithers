/**
 * The production `EngineLike` binding: the harness engine port executed on the
 * durable flow engine from `@smthrs/engine`.
 *
 * `@smthrs/harness` declares the port (`sealStep` / `splice` / `suspend`) and
 * ships only `layer(implementation)` and `layerNoop`. This module supplies the
 * missing implementation, so a production consumer can run the harness on the
 * durable engine without reaching into `@smthrs/testing`.
 *
 * The binding is deliberately *not* `@smthrs/testing`'s `FlowEngineLike`:
 * that module adapts the engine to `EngineSubject`
 * (`run` / `result` / `interrupt` / `resume` / `journal`), the conformance
 * contract used by the testing library. The two ports share a backing engine
 * and nothing else, and `packages/testing/test/EngineSubject.test.ts` asserts
 * they stay distinct.
 *
 * How the port maps onto the engine:
 *
 * - `sealStep` resolves the route, runs `Route.prepare`, and digests the
 *   credential-free `PreparedRequest` — canonical body bytes included —
 *   together with the harness's declared key material into a `StepKey`
 *   (`docs/specs/Concepts/Step Keys.md`). That key is the *sealed* activity's
 *   idempotency key, so a provider wire change produces a new key and a
 *   replayed turn re-emits the recorded model events without calling the
 *   provider again. Credentials are signed on by the route after the digest
 *   and never enter it.
 * - `splice` runs each elaborated child as its own activity at the tier the
 *   child declares. Sealed children take a pure content key, so the same
 *   sealed call replays one recorded result; compensable and irreversible
 *   children fold the run scope *and* the model's `callId` into the key, which
 *   keeps two invocations of one declaration distinct, keeps two runs that both
 *   labelled a call `call_1` from aliasing onto one another, and satisfies the
 *   engine's requirement that an irreversible activity declare an idempotency
 *   key before it may be retried.
 * - `record` journals one nondeterministic controller read — the steering
 *   drain, and the workspace measurements below — as its own run-scoped
 *   boundary, so a resumed run replays the recorded value instead of reading
 *   the world a second time.
 * - `observe` measures the workspace through `WorkspaceObservation.Observer`
 *   when the composition provides one, and reports it unobserved when it does
 *   not. This is what lets the controller decide "did this frame change
 *   anything" from the tree rather than from what the frame's calls declared —
 *   a shell command declares nothing and writes wherever it likes.
 * - Every key folds in the resolved composition identity `Options.layers` — the
 *   host's layer stack and its resolved plugin list. A boundary resolved under a
 *   different composition is a different boundary.
 * - `suspend` is a real durable suspension (`Flow.suspend`), not a failure.
 *   The execution parks and can be resumed by the engine.
 *
 * Reference consulted: `reference/effect` `unstable/workflow` (Action /
 * Workflow / DurableDeferred) by way of the vendored fork in
 * `@smthrs/engine`, and `reference/temporal`'s activity-identity rules for
 * why a non-sealed invocation must carry a distinguishing key.
 *
 * @since 0.1.0
 */
import * as Permission from "@smthrs/capability/Permission"
import * as Digest from "@smthrs/core/Digest"
import type * as KeyMaterial from "@smthrs/core/KeyMaterial"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as Cell from "@smthrs/harness/Cell"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as HarnessError from "@smthrs/harness/HarnessError"
import * as Plan from "@smthrs/harness/Plan"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Route from "@smthrs/model/Route"
import * as PersistedPlan from "@smthrs/plan/Plan"
import * as StepKey from "@smthrs/plan/StepKey"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import { Context, Crypto, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import * as WorkspaceObservation from "./WorkspaceObservation.ts"
import type * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * Route resolution for one sealed model request.
 *
 * The port needs `Route.prepare` and nothing else, so a consumer can supply a
 * configured route, a router, or a recorded resolver in tests.
 *
 * @category models
 * @since 0.1.0
 */
export interface RouteResolver {
  readonly prepare: (
    request: ModelRequest.ModelRequest
  ) => Effect.Effect<Route.PreparedRequest, ModelError.ModelError>
}

/**
 * Adapts one configured model route to {@link RouteResolver}.
 *
 * @category constructors
 * @since 0.1.0
 */
export const routeResolver = <Body, Frame, Event, State>(
  route: Route.Route<Body, Frame, Event, State>
): RouteResolver => ({
  prepare: (request) => Route.prepare(route, request)
})

/**
 * Executes one child call elaborated from a model tool call.
 *
 * The runner owns flow lookup, decoding, capability attenuation, and placement;
 * this module owns only durability — it wraps whatever the runner returns in an
 * activity so the call is recorded once and replayed thereafter.
 *
 * @category models
 * @since 0.1.0
 */
export interface ChildRunner {
  readonly run: (
    child: Plan.Child
  ) => Effect.Effect<Plan.ChildResult, HarnessError.HarnessError>
}

/**
 * Executes one flow call issued from inside a running cell.
 *
 * As with {@link ChildRunner}, the runner owns lookup, decoding, attenuation,
 * and placement; this module owns only durability.
 *
 * @category models
 * @since 0.1.0
 */
export interface CallRunner {
  /**
   * Decides whether the call may proceed, before the durable boundary opens.
   *
   * Authority is not a side effect, and the distinction matters for replay: an
   * activity's outcome is journaled, so a permission requirement raised from
   * inside one would be replayed forever and no later grant could unblock it.
   * Checked here, a park records nothing, and the resumed attempt asks again
   * against the grant store as it now stands.
   */
  readonly authorize?: (
    call: Cell.Call
  ) => Effect.Effect<void, HarnessError.HarnessError>
  readonly run: (
    call: Cell.Call
  ) => Effect.Effect<Cell.CallResult, HarnessError.HarnessError>
}

/**
 * A cell-call runner that may touch the workspace it runs inside.
 *
 * The only difference from {@link CallRunner} is the `Workspace` requirement,
 * which is what a flow uses to read and write transactionally. A plain
 * `CallRunner` satisfies this too — it simply never asks for the service — so
 * {@link sandboxed} accepts either.
 *
 * @category models
 * @since 0.1.0
 */
export interface WorkspaceCallRunner {
  readonly authorize?: (
    call: Cell.Call
  ) => Effect.Effect<void, HarnessError.HarnessError>
  readonly run: (
    call: Cell.Call
  ) => Effect.Effect<Cell.CallResult, HarnessError.HarnessError, WorkspaceSandbox.Workspace>
}

/**
 * Rewrites one declared effect path into the workspace-relative form the
 * engine's file boundary speaks.
 *
 * The two sides use different vocabularies for the same idea. A flow
 * declaration is written against `@smthrs/core`'s `Effects.covers`, whose
 * only wildcard form is an absolute prefix glob — which is why every
 * filesystem flow in `@smthrs/std` declares `/**` for "any path". The
 * engine's `StepBoundary` resolves boundary paths against the pinned
 * workspace root, and `AtomicFileSystem` refuses `/**` outright as "path is
 * outside the pinned root". Handing the declaration across untranslated made
 * every `read`, `write`, `edit`, `glob`, `grep`, and `ls` call from a cell
 * fail before its handler ran.
 *
 * The translation is exact rather than lenient: a flow cannot reach outside
 * the workspace at all — the kernel filesystem pins it — so the declaration's
 * "anywhere" and the boundary's "everything under the root" name the same
 * set, and a leading `/` is the only difference between how the two write it.
 *
 * @category conversions
 * @since 0.1.0
 */
export const workspaceRelative = (path: string): string => path.startsWith("/") ? path.slice(1) : path

/**
 * Converts the agent-side declaration into the file boundary understood by
 * the production engine and its workspace sandbox.
 *
 * The agent declaration knows paths but has not measured them; the engine's
 * `StepBoundary` performs that measurement before dispatch. The placeholder
 * digest is therefore identity-bearing metadata only for direct conformance
 * harnesses; production never uses it as evidence.
 *
 * @category conversions
 * @since 0.1.0
 */
export const callBoundary = (call: Cell.Call): FileBoundary => ({
  readSet: call.effects.reads.map((path) => ({ path: workspaceRelative(path), digest: call.identity.declaration })),
  writeSet: call.effects.writes.map(workspaceRelative),
  boundaryMode: call.effects.mode === "hermetic" ? "hard" : "expected"
})

/**
 * The key material one cell call declares about itself.
 *
 * This is the same material {@link callKey} hashes, exposed as a value so the
 * workspace sandbox is handed the planner's declaration rather than a second,
 * separately-maintained description of the same call. A sealed call is
 * content-addressed; anything else folds in the cell identity that keeps two
 * invocations of one declaration distinct.
 *
 * @category constructors
 * @since 0.1.0
 */
export const callMaterial = (
  call: Cell.Call,
  layers: ReadonlyArray<string> = []
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v1",
  kind: call.effects.tier,
  body: {
    _tag: "CellCall",
    flowName: call.flowName,
    declaration: call.identity.declaration,
    input: call.input,
    // The tree the call reads. A sealed call is content-addressed on what it
    // asked, and "the same command against the tree this run opened on" is a
    // different question from "the same command against the tree as it stands"
    // — so without this the second of the two would replay the first's answer,
    // which is precisely the reading the fails-before proof depends on. Absent
    // spreads to nothing, so every key that existed before checkpoints is
    // byte-identical.
    ...(call.at === undefined ? {} : { at: call.at }),
    ...(Option.isSome(call.placement) ? { placement: call.placement.value } : {}),
    ...(call.effects.tier === "sealed" ? {} : {
      session: call.identity.session,
      frame: call.identity.frame,
      cell: call.identity.cell,
      ordinal: call.identity.ordinal
    })
  },
  inputs: [],
  layers: [...new Set([...layers, ...call.identity.layers])].sort(),
  capabilities: [...call.capabilities].sort(),
  effects: call.effects,
  placement: undefined
})

/**
 * One node of an elaborated subgraph, keyed and ready to append to a plan.
 *
 * @category models
 * @since 0.1.0
 */
/** The key material one elaborated child declares about itself. */
const childMaterial = (
  child: Plan.Child,
  scope: { readonly layers: ReadonlyArray<string>; readonly run: string }
): KeyMaterial.KeyMaterial => ({
  version: "flows/key-material/v1",
  kind: child.effects.tier,
  body: {
    _tag: "FlowChild",
    flowName: child.flowName,
    args: child.args,
    ...(Option.isSome(child.placement) ? { placement: child.placement.value } : {}),
    ...(child.effects.tier === "sealed" ? {} : { run: scope.run, callId: child.callId })
  },
  inputs: [],
  layers: [...scope.layers].sort(),
  capabilities: [...child.capabilities].sort(),
  effects: child.effects,
  placement: undefined
})

/**
 * Appends one elaborated batch to the persisted plan value.
 *
 * This is deliberately the main tree's compiler and append operation, not a
 * second node projection: dependency substitution, conflict annotations,
 * generation, and the plan digest advance together or not at all.
 *
 * @category constructors
 * @since 0.1.0
 */
export const appendBatch = (
  plan: PersistedPlan.Plan,
  batch: Plan.Batch,
  scope: { readonly layers: ReadonlyArray<string>; readonly run: string }
): Effect.Effect<PersistedPlan.Plan, HarnessError.HarnessError> =>
  keyed(PersistedPlan.append(
    plan,
    batch.children.map((child): PersistedPlan.NodeDraft => ({
      id: child.callId,
      material: childMaterial(child, scope),
      effects: {
        reads: child.effects.reads,
        writes: child.effects.writes,
        boundaryMode: child.effects.mode === "hermetic" ? "hard" : "expected"
      },
      kind: "step",
      conflictStrategy: child.effects.onConflict
    }))
  )).pipe(
    Effect.mapError((cause) => engineFailed("The elaborated subgraph could not be appended to its plan", cause))
  )

/**
 * Runs every cell call inside an outer workspace transaction.
 *
 * This is the seam between the cell path and the scheduler the vault's
 * `Concepts/Reconciliation.md` describes: the call's *declared* effects and its
 * key material go in, the sandbox executes the runner against an isolated copy
 * of the workspace, and what comes back is a functional result — the files the
 * call would change, the provenance of what it actually read and wrote, and a
 * cache disposition keyed by `@smthrs/plan`'s compiler.
 *
 * Two properties are the point:
 *
 * - **A declaration is checked, not trusted.** A call that reads or writes
 *   outside what the cell chose comes back `Invalidated`, and this adapter
 *   turns that into a call failure the cell can catch rather than a silent
 *   host mutation. The speculative changes are discarded with it.
 * - **Materialization is explicit.** The sandbox admits a result before any
 *   host state moves, so a conflicting concurrent write is a typed refusal
 *   instead of a lost update.
 *
 * The adapter is a `CallRunner` decorator rather than an option on
 * {@link make}, so a host chooses the transaction boundary by composition and
 * a host that has no workspace to isolate composes nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const sandboxed = (
  sandbox: WorkspaceSandbox.Service,
  runner: WorkspaceCallRunner,
  options: { readonly layers?: ReadonlyArray<string> | undefined } = {}
): Effect.Effect<CallRunner, never, Crypto.Crypto> =>
  Effect.map(Crypto.Crypto, (crypto): CallRunner => ({
    ...(runner.authorize === undefined ? {} : { authorize: runner.authorize }),
    run: (call) =>
      Effect.gen(function*() {
        const cacheKey = call.effects.tier === "sealed"
          ? yield* StepKey.fromKeyMaterial(callMaterial(call, options.layers), {}).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((cause) => engineFailed(`Cell call ${call.flowName} could not be keyed`, cause))
          )
          : undefined
        const outcome = yield* sandbox.execute({
          descriptor: callBoundary(call),
          ...(cacheKey === undefined ? {} : { cacheKey }),
          workflow: runner.run(call)
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            cause instanceof HarnessError.HarnessError
              ? cause
              : engineFailed(`Cell call ${call.flowName} could not run in its workspace sandbox`, cause)
          )
        )
        if (outcome._tag === "Invalidated") {
          const violated = outcome.violations
            .map((violation) => `${violation.kind} ${violation.resource.id}`)
            .join(", ")
          return new Cell.CallResult({
            outcome: "failure",
            value: null,
            message: `Flow ${call.flowName} touched what it did not declare (${violated}); its changes were discarded.`
          })
        }
        yield* sandbox.materialize(outcome).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            engineFailed(`Cell call ${call.flowName} could not materialize its workspace changes`, cause)
          )
        )
        return outcome.result.output
      })
  }))

/**
 * The collaborators a durable harness engine needs.
 *
 * `calls` is required by the cell path and `children` by the superseded
 * tool-call path; a host that runs only one of the two supplies only that one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly model: Model.Model
  /** Bounded model-boundary retry policy; injectable so tests and hosts control time. */
  readonly modelRetryPolicy?: Schedule.Schedule<unknown, Model.ModelFailure> | undefined
  readonly route: RouteResolver
  readonly children?: ChildRunner | undefined
  readonly calls?: CallRunner | undefined
  /**
   * The already-recorded plan this run grows during elaboration.
   *
   * `current` reads the latest persisted generation and `append` records the
   * value returned by `@smthrs/plan/Plan.append`. Hosts without a dynamic plan
   * omit the port; hosts that supply one cannot accidentally keep elaboration
   * in an unpersisted side channel.
   */
  readonly plan?: {
    readonly current: Effect.Effect<PersistedPlan.Plan, HarnessError.HarnessError>
    readonly append: (plan: PersistedPlan.Plan) => Effect.Effect<void, HarnessError.HarnessError>
  } | undefined
  /**
   * The resolved composition identity every durable key folds in.
   *
   * This is the layer set the host actually built — model, permission, and host
   * layers, plus the resolved plugin list in resolution order. It belongs in the
   * key because it changes what a boundary *means*: the same declaration
   * resolved under a different plugin list is a different call, and serving it a
   * recorded result from the other composition is a stale-cache bug, not a
   * replay.
   */
  readonly layers?: ReadonlyArray<string> | undefined
  /**
   * The composition's COMPLETE effective authority, if the host knows it.
   *
   * A sealed boundary is cross-run cacheable, so the key has to distinguish
   * two compositions that grant different authority — the same sealed
   * `fs/read` resolved under `fs:read:/workspace/**` and under
   * `fs:read:/workspace/a/**` is not the same boundary, even when the call
   * declares identical capabilities, because the envelope is what attenuates
   * it (issue #75).
   *
   * The host must supply this only when the record really is complete. An
   * omitted value is the honest "my authority is unknown", and the engine
   * answers it by pinning every sealed key to the current execution — no
   * cross-run reuse, but never a stale result from a differently-authorized
   * composition. Declaring an empty record is a positive claim that the
   * composition grants nothing, and it is a lie if the host holds an
   * envelope; {@link module:Agent} declares the envelope it actually
   * built.
   */
  readonly capabilities?: Readonly<Record<string, ReadonlyArray<string>>> | undefined
}

/**
 * The durable outcome of one sealed model step.
 *
 * The array branch is the format written before model-boundary retries were
 * introduced. Keeping it decodable matters because a parked run may resume
 * against a newer agent package and replay that already-settled activity.
 * New records always use the object branch so a terminal typed model failure
 * can be replayed after its retry events.
 *
 * @category schemas
 * @since 0.1.0
 */
export const RecordedModelStep = Schema.Union([
  Schema.Array(ModelEvent.ModelEvent),
  Schema.Struct({
    events: Schema.Array(ModelEvent.ModelEvent),
    error: Schema.optional(ModelError.ModelError)
  })
])

/**
 * Reads either {@link RecordedModelStep} branch as the object form.
 *
 * @since 0.1.0
 * @private
 */
export const normalizeRecordedModelStep = (
  recorded: typeof RecordedModelStep.Type
): { readonly events: ReadonlyArray<ModelEvent.ModelEvent>; readonly error?: ModelError.ModelError | undefined } =>
  "events" in recorded ? recorded : { events: recorded, error: undefined }

/**
 * Every failure `Model.stream` may report, as one encodable schema. The engine
 * stores an activity's failure as well as its success, so the port's error
 * channel has to be expressible as a schema rather than an opaque value.
 */
/**
 * The model error codes worth trying again.
 *
 * A provider call is the one step in the loop that fails for reasons that have
 * nothing to do with the task: a dropped HTTP/2 session, a 5xx, a rate limit.
 * Without a retry the first of those ends the run — an agent working a real
 * repository lost twenty minutes of context to
 * `ERR_HTTP2_INVALID_SESSION: The session has been destroyed`, with the frame,
 * the run, and the workspace state all discarded.
 *
 * `call_timeout` joins them for a different reason. It is the caller's own
 * doing — the request was interrupted at the budget the controller armed — but
 * it is retryable for the same reason the other two are: nothing about the
 * task changed, and the next attempt can succeed. What separates it is that
 * waiting alone would not help, so the re-issue also carries
 * {@link overrunTeaching} — and that it does not get this set's whole retry
 * budget, because it is the one code whose every attempt costs a full wall
 * clock ceiling rather than a refused connection. {@link defaultModelOverruns}
 * bounds it separately.
 *
 * Everything absent from this set is terminal for the request as written — a
 * bad key, a malformed request, a context overflow, a refusal — and retrying
 * one is pure latency. `context_overflow` in particular must reach the caller
 * unchanged: it is the typed signal compaction reads.
 */
const retryableModelCodes: ReadonlySet<string> = new Set([
  "provider_internal",
  "transport",
  "call_timeout"
])

/**
 * The first delay the production transport policy waits, in milliseconds.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryBaseMillis = 1000

/**
 * The factor each successive production transport delay multiplies by.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryFactor = 2

/**
 * How many times the production transport policy retries one sealed step.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryTimes = 5

/**
 * The wall clock the production transport ladder may span, in milliseconds.
 *
 * The count alone is not a bound. Five rungs of jittered doubling from one
 * second sum to at most 37.2 s of *sleeping*, but a ladder also spends whatever
 * each failing attempt spends, and a dying HTTP/2 session does not fail
 * quickly: r92 of the SWE-bench full benchmark burned ten `transport` retries
 * and $0.85 across two instances against a socket that stayed dead for about
 * half a minute, and each of those attempts re-sent a whole prompt and streamed
 * a partial body before dying. A ladder whose only bound is a count charges for
 * that as many times as the count allows.
 *
 * 45,000 ms is the declared ladder's own jittered ceiling plus one rung's worth
 * of headroom for the attempts between the sleeps, so a ladder that fails as
 * fast as this policy assumes still runs all five rungs and nothing here
 * changes for it. What changes is the ladder whose attempts are slow: it stops
 * when the wall clock says the incident has outlasted the window this policy
 * was written to cover, rather than when the fifth rung happens to arrive. Past
 * that point waiting is not what is wrong, which is exactly what
 * `@smthrs/model` `RequestExecutor` `makeWith` and its `Transport` are for: a
 * client the host can replace, rather than a longer wait on the one that died.
 *
 * The elapsed time is the schedule's own, taken on the injected clock, so a
 * test that supplies one sees the window it declared and never a wall-clock
 * wait.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryWindowMillis = 45_000

/**
 * The production transport retry budget: five retries over a jittered
 * exponential backoff spanning roughly thirty seconds, inside a 45-second
 * wall-clock window.
 *
 * The shape is load-bearing, not decorative. A transport-class failure is
 * almost never local: a destroyed HTTP/2 session, a 5xx, an overloaded
 * provider. All three persist for seconds to tens of seconds, so a retry that
 * fires inside that window is a wasted attempt, and a budget that empties
 * inside it turns one provider incident into a dead run. Wave 4 of the
 * SWE-bench harness lost `pytest-dev__pytest-6197` exactly that way: both of
 * its `transport` retries were spent, and the run ended `failed`, while the
 * provider was still refusing.
 *
 * Doubling from one second across five retries spans about 31 s, which is
 * long enough for a connection pool to re-establish and for a short rate-limit
 * window to pass. Jitter is what keeps a fleet of runs that all hit the same
 * incident from re-converging on the provider in lockstep; {@link
 * Schedule.jittered} scales each delay by a random factor in `[0.8, 1.2]`
 * drawn from the injected `Random` service, and the sleep itself is taken on
 * the injected clock, so a test that supplies both sees the schedule it
 * declared and never a wall-clock wait.
 *
 * {@link defaultModelRetryWindowMillis} bounds the same ladder by elapsed time,
 * because five rungs is a bound on how many attempts are made and not on what
 * they cost. Whichever limit arrives first ends the ladder.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelRetryPolicy: Schedule.Schedule<unknown, Model.ModelFailure> = Schedule
  .exponential(defaultModelRetryBaseMillis, defaultModelRetryFactor)
  .pipe(
    Schedule.jittered,
    Schedule.upTo({ times: defaultModelRetryTimes, duration: Duration.millis(defaultModelRetryWindowMillis) })
  )

const seconds = (millis: number): number => Math.round(millis / 1000)

/**
 * How many times one sealed step re-issues a call its budget cut off.
 *
 * The retry budget the transport codes share cannot be shared with an overrun,
 * because the two cost different things. A dropped session fails in
 * milliseconds, so five retries of it cost five backoffs; an overrun fails
 * only after spending the whole armed ceiling, so five retries of it cost five
 * ceilings. On the wave 7 default of 300,000 ms that is a single sealed step
 * spending 1,800 s of wall clock — 150% of the 1,200 s process budget that
 * wave gave a whole run, and 2.7x the 667 s call the budget was written to
 * bound. A budget that multiplies the failure it names is not a budget.
 *
 * One re-issue is the number the mechanism supports. Waiting cannot shorten an
 * answer, so the only thing a re-issue adds is {@link overrunTeaching}, and a
 * model that overran again *after* being told to answer directly has already
 * shown the teaching did not land; a third ask costs another full ceiling and
 * buys nothing new. With one re-issue a step spends at most twice the armed
 * budget — 600 s at the default, under the 667 s single call that motivated
 * the ceiling — and then fails the frame with the typed error, which is a
 * bound a report can state.
 *
 * @category policies
 * @since 0.1.0
 */
export const defaultModelOverruns = 1

/**
 * What a re-issued call tells the model about the attempt that was cut off.
 *
 * A transport failure is repaired by waiting; an overrun is not. The provider
 * would happily spend the budget again on the same answer, so the re-issue has
 * to say something the first attempt did not, and the only party that can
 * shorten the answer is the model. The note is deliberately terse and states
 * one instruction, because it is prepended to a system context that already
 * carries the cell contract, the task, and the run's state.
 *
 * It says nothing about how many attempts have been spent, because
 * {@link defaultModelOverruns} allows exactly one: a call carrying this note is
 * always the last one the step will make.
 *
 * @since 0.1.0
 * @private
 */
export const overrunTeaching = (budgetMillis: number): string =>
  `Time budget — your previous answer ran past this run's ${
    seconds(budgetMillis)
  }-second budget for one model call and was cut off before it finished, so none of it survives, and this is the last attempt this step will make. Answer directly this time: decide with the evidence you already have, keep the reasoning short, and emit the cell.`

/**
 * Re-issues one overrun call with the teaching prepended to its system context.
 *
 * The teaching goes at the front of `system` rather than at the end of the
 * transcript because the transcript is the cell's to shape — the controller
 * replaces it wholesale each frame from what the cell projected — while the
 * system context is the run's stable teaching, which is where an instruction
 * about how to answer belongs. The original request is never mutated; a later
 * attempt re-derives from it, so two overruns leave one note rather than two.
 *
 * @since 0.1.0
 * @private
 */
export const withOverrunTeaching = (
  request: ModelRequest.ModelRequest,
  budgetMillis: number
): ModelRequest.ModelRequest =>
  ModelRequest.ModelRequest.make({
    ...request,
    system: [
      ModelRequest.SystemPart.make({ text: overrunTeaching(budgetMillis) }),
      ...request.system
    ]
  })

/**
 * Retries transient provider failures inside the sealed step.
 *
 * The retry is deliberately here rather than on the action's `retryPolicy`.
 * The engine's policy classifies by error *tag*, and every provider failure
 * shares the one `flows/model/ModelError` tag, so a tag-level policy either
 * retries a bad API key four times or retries nothing. It also replaces an
 * exhausted failure with `RetryAttemptsExhausted`, which would hide the very
 * `code` the caller branches on. Retrying in place keeps the classification
 * precise and lets the original typed error surface unchanged when the
 * backoff gives up.
 *
 * Each retry states the delay the schedule chose for it. The delay cannot be
 * read back off the journal timestamps: every retry of one step is buffered
 * and written when the step settles, so a run that backed off for half a
 * minute and one that did not back off at all are indistinguishable there.
 *
 * The classification is a `Schedule.while` *inside* the schedule rather than
 * `Effect.retry`'s `while` option, and the tap sits outside it. Both placements
 * matter. `Effect.retry` applies its `while` after stepping the schedule, so a
 * tap under it fires once for a terminal failure too and records a retry that
 * never happened — a `quota_exceeded` run journaled a phantom `model-retried`
 * exactly that way. Stopping the schedule first means the tap only ever sees a
 * step that will really recur, and `duration` is then the delay actually
 * slept — jitter and bound already applied — not the nominal one the base
 * schedule would have produced.
 *
 * `budgetMillis` is the same retry, applied to the one failure the provider
 * never reports: a call that answers, slowly, forever. It is enforced here
 * rather than around the whole sealed step so an overrun is an attempt rather
 * than the end of the frame — it is interrupted, classified `call_timeout`,
 * and re-issued on this schedule with {@link overrunTeaching} in front of it.
 * Interruption is the only mechanism involved: `Effect.timeoutOrElse` closes
 * the attempt's scope, and the model layer's own request teardown follows from
 * that, so nothing threads an abort signal and nothing polls a flag.
 *
 * The overrun rides the schedule's delays but not its count. Every other
 * retryable code fails fast and costs a backoff; an overrun costs a whole
 * armed ceiling, so it stops after {@link defaultModelOverruns} re-issues and
 * the step's total model time stays bounded by twice the budget rather than by
 * six times it.
 *
 * @since 0.1.0
 * @private
 */
export const recordModelStep = (
  model: Model.Model,
  request: ModelRequest.ModelRequest,
  policy: Schedule.Schedule<unknown, Model.ModelFailure>,
  budgetMillis?: number | undefined
): Effect.Effect<typeof RecordedModelStep.Type, Exclude<Model.ModelFailure, ModelError.ModelError>> => {
  const retries: Array<ModelEvent.ModelEvent> = []
  let attempt = 0
  /** How many attempts this step has already had cut off at the budget. */
  let overruns = 0
  const schedule = policy.pipe(
    Schedule.while(({ input }) =>
      input instanceof ModelError.ModelError && retryableModelCodes.has(input.code) &&
      // The overrun's own bound. `overruns` was incremented by the attempt
      // this failure came from, so the first cut-off call reads 1 and is
      // re-issued, and the re-issue's own cut-off reads 2 and is not.
      (input.code !== "call_timeout" || overruns <= defaultModelOverruns)
    ),
    Schedule.tap(({ duration, input }) =>
      Effect.sync(() => {
        attempt++
        // Only a retryable `ModelError` reaches the tap: the classification
        // above stops the schedule before it on anything else.
        const error = input as ModelError.ModelError
        retries.push(
          ModelEvent.ModelEvent.Retry({
            type: "retry",
            attempt,
            code: error.code,
            // Jitter produces a fractional millisecond. The whole millisecond
            // is the honest resolution for a report to read.
            delayMillis: Math.round(Duration.toMillis(duration))
          })
        )
      })
    )
  )
  const budget = budgetMillis === undefined || budgetMillis <= 0 ? undefined : budgetMillis
  const collected = budget === undefined
    // Disarmed. The call is bounded by nothing but the caller's own process,
    // which is what every model call was before this budget existed.
    ? Stream.runCollect(model.stream(request))
    // Suspended so each attempt reads the overrun count the attempt before it
    // left. That is what puts the teaching on a re-issue and never on the
    // first call, and what keeps the original request the one thing every
    // attempt derives from.
    : Effect.suspend(() =>
      Stream.runCollect(
        model.stream(overruns === 0 ? request : withOverrunTeaching(request, budget))
      ).pipe(
        Effect.timeoutOrElse({
          duration: budget,
          orElse: () =>
            Effect.sync(() => {
              overruns++
            }).pipe(
              Effect.andThen(Effect.fail(
                new ModelError.ModelError({
                  code: "call_timeout",
                  message: `The model call ran past its ${seconds(budget)}-second budget and was interrupted`
                })
              ))
            )
        })
      )
    )
  // A response body that ends without a settlement is a dead socket, and until
  // now it was the one way a socket could end a run outright. `Stream.runCollect`
  // *succeeds* on a truncated body — the events it did receive are returned,
  // `settledMessage` folds them into an `aborted` assistant message, and the
  // controller then raises `model_failed` because no `settle` is among them.
  // That failure is a `HarnessError`, not a `ModelError`, so no retry
  // classification ever saw it: one dropped HTTP/2 session, no backoff, run
  // over. Two r91 instances were lost to that class and re-run as
  // infrastructure crashes.
  //
  // Classifying it as `transport` puts it on the ladder every other socket
  // failure already rides. It cannot be confused with an interruption: an
  // interrupted fiber never reaches here with a value at all, and a settled
  // stream always carries its settlement.
  const attemptOnce = Effect.flatMap(collected, (events) =>
    Array.from(events).some((event) => event.type === "settle")
      ? Effect.succeed(events)
      : Effect.fail(
        new ModelError.ModelError({
          code: "transport",
          message: "The model response stream ended without a settlement"
        })
      ))
  return attemptOnce.pipe(
    Effect.retry(schedule),
    Effect.map((events) => ({ events: [...retries, ...events] })),
    Effect.catchIf(
      (error): error is ModelError.ModelError => error instanceof ModelError.ModelError,
      (error) => Effect.succeed({ events: retries, error })
    )
  )
}

const ModelFailure = Schema.Union([
  ModelError.ModelError,
  Permission.PermissionRequired,
  Permission.PermissionDenied,
  Permission.GrantStoreError
])

const sealStepActivityName = "harness/sealStep"

const childActivityName = (flowName: string): string => `harness/child/${flowName}`

const cellCallActivityName = (flowName: string): string => `harness/cell-call/${flowName}`

const boundaryActivityName = (name: string): string => `harness/boundary/${name}`

const engineFailed = (message: string, cause: unknown): HarnessError.HarnessError =>
  new HarnessError.HarnessError({ code: "engine_failed", message, cause })

/**
 * Supplies the hashing service `@smthrs/plan`'s step-key compiler runs under.
 *
 * The compiler is the main tree's, so the material it hashes and the `key1_`
 * format it emits are the main tree's too. Only the hash *provider* is local:
 * `Digest.crypto` is a synchronous SHA-256 proven byte-identical to the
 * platform service (`@smthrs/core` `Digest.test.ts`), which keeps `EngineLike`
 * free of a `Crypto` requirement it would otherwise have to thread through
 * every stream and activity signature.
 */
const keyed = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Effect.Effect<A, E> =>
  Effect.provideService(effect, Crypto.Crypto, Digest.crypto)

/**
 * Drops `undefined`-valued properties from an already-encoded JSON value.
 *
 * Canonical serialization rejects `undefined` outright, and `Schema.encodeSync`
 * keeps optional fields as explicit `undefined`. Applied only to encoded
 * request JSON, never to arbitrary values, so Canonical still rejects class
 * instances and `Redacted` material on its own.
 */
const stripUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (typeof value !== "object" || value === null) return value
  const stripped: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) stripped[key] = stripUndefined(item)
  }
  return stripped
}

interface ModelCallDeclaration {
  readonly _tag: "ModelCall"
  readonly request: ModelRequest.ModelRequest
}

const isModelCall = (value: unknown): value is ModelCallDeclaration =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "ModelCall" && "request" in value

/**
 * Digests the harness key material together with the prepared wire request.
 *
 * The harness declaration embeds the live `ModelRequest` (class instances that
 * Canonical refuses), so it is re-encoded to plain JSON before hashing.
 */
const seal = Effect.fn("FlowEngineLike.seal")(function*(
  step: EngineLike.SealedModelStep,
  route: RouteResolver
) {
  const prepared = yield* route.prepare(step.request)
  const declaration = step.keyMaterial.body
  const material: KeyMaterial.KeyMaterial = {
    ...step.keyMaterial,
    body: {
      _tag: "PreparedModelCall",
      declaration: isModelCall(declaration)
        ? {
          _tag: "ModelCall",
          request: stripUndefined(Schema.encodeSync(ModelRequest.ModelRequest)(declaration.request))
        }
        : declaration,
      request: {
        routeId: prepared.routeId,
        protocolId: prepared.protocolId,
        method: prepared.method,
        url: prepared.url,
        publicHeaders: prepared.publicHeaders,
        body: Array.from(prepared.body)
      }
    }
  }
  return yield* keyed(StepKey.fromKeyMaterial(material, {})).pipe(
    Effect.mapError((cause) => engineFailed("The prepared model request could not be sealed", cause))
  )
})

/**
 * The composition and run scope every durable key in this port folds in.
 *
 * `layers` is the resolved composition identity; `run` names the one flow
 * execution the port was built for.
 */
interface Scope {
  readonly layers: ReadonlyArray<string>
  readonly run: string
}

/**
 * Derives one child's activity identity.
 *
 * A sealed child is content-addressed: the same declaration and arguments
 * replay one recorded result wherever they appear, under the resolved layer set
 * they were resolved with.
 *
 * Anything else folds in the run scope as well as the model's `callId`. The
 * `callId` alone was not enough: it is a provider-assigned label that restarts
 * at `call_1` in every run, so two semantically distinct executions — different
 * flow, different execution id, different resolved composition — collided on one
 * content key, and the second one replayed the first one's recorded result
 * instead of running. Run-scoping a non-sealed child is the same rule the cell
 * path already applies in {@link callKey}: an effect that is not shareable on
 * content is never shared across executions.
 */
const childKey = (
  child: Plan.Child,
  scope: Scope
): Effect.Effect<StepKey.StepKey, HarnessError.HarnessError> =>
  keyed(
    child.effects.tier === "sealed"
      ? StepKey.fromKeyMaterial(childMaterial(child, scope), {})
      : StepKey.content({
        body: {
          _tag: "FlowChild",
          flowName: child.flowName,
          args: child.args,
          effects: child.effects,
          placement: Option.getOrUndefined(child.placement),
          run: scope.run,
          callId: child.callId
        },
        inputs: {},
        layers: scope.layers,
        capabilities: { declared: [...child.capabilities].sort() }
      })
  ).pipe(
    Effect.mapError((cause) => engineFailed(`Child call ${child.callId} could not be keyed`, cause))
  )

/**
 * Derives one cell call's activity identity.
 *
 * A sealed call is content-addressed on the declaration digest, the resolved
 * layer set, the declared capabilities, and the arguments, so the same sealed
 * call replays one recorded result wherever it appears — that is exactly the
 * semantics "sealed" declares.
 *
 * Anything else folds in the whole cell identity: session, frame, cell digest,
 * and the call's execution ordinal. That keeps two invocations of one
 * declaration distinct, scopes an irreversible effect so it can never be
 * shared across sessions, and — because re-executing a cell reaches the same
 * ordinal with the same declaration — makes a crash mid-cell replay the
 * boundaries that already settled instead of re-running them. Cross-execution
 * isolation itself is the engine's: every non-sealed activity is keyed by
 * ordinal under the execution id, so two runs can never alias one another's
 * journaled boundaries regardless of what this port declares.
 *
 * The layer set is part of both keys, and it is the union of what the cell
 * frame declared and what the host actually composed — the resolved plugin list
 * included. Two otherwise identical calls resolved under different layers are
 * different calls.
 */
const callKey = (
  call: Cell.Call,
  scope: Scope
): Effect.Effect<StepKey.StepKey, HarnessError.HarnessError> =>
  keyed(
    StepKey.content({
      body: {
        _tag: "CellCall",
        flowName: call.flowName,
        declaration: call.identity.declaration,
        input: call.input,
        effects: call.effects,
        // See `callMaterial`: the tree a call reads is part of what it asked.
        ...(call.at === undefined ? {} : { at: call.at }),
        ...(Option.isSome(call.placement) ? { placement: call.placement.value } : {}),
        ...(call.effects.tier === "sealed" ? {} : {
          session: call.identity.session,
          frame: call.identity.frame,
          cell: call.identity.cell,
          ordinal: call.identity.ordinal
        })
      },
      inputs: {},
      layers: [...new Set([...scope.layers, ...call.identity.layers])],
      capabilities: { declared: [...call.capabilities].sort() }
    })
  ).pipe(
    Effect.mapError((cause) =>
      engineFailed(`Cell call ${call.flowName} #${call.identity.ordinal} could not be keyed`, cause)
    )
  )

/**
 * Derives one journaled controller boundary's activity identity.
 *
 * A recorded boundary is never content-addressed — the whole point is that
 * the read is not a pure function — so the key folds in the boundary name,
 * the controller-supplied identity, and the run scope: one recording per
 * boundary per execution, replayed verbatim by any re-execution of the frame.
 */
const boundaryKey = (
  name: string,
  identity: EngineLike.BoundaryIdentity,
  scope: Scope
): Effect.Effect<StepKey.StepKey, HarnessError.HarnessError> =>
  keyed(
    StepKey.content({
      body: {
        _tag: "HarnessBoundary",
        name,
        frame: identity.frame,
        boundary: identity.boundary,
        ...(identity.session === undefined ? {} : { session: identity.session }),
        run: scope.run
      },
      inputs: {},
      layers: scope.layers,
      capabilities: { declared: [] }
    })
  ).pipe(
    Effect.mapError((cause) => engineFailed(`Boundary ${name} could not be keyed`, cause))
  )

/**
 * Constructs the durable harness engine port.
 *
 * `FlowInstance` is per-execution, so this must be built inside a running flow
 * body — the harness layer stack is provided from the flow the harness is the
 * body of. The captured services are supplied back to every activity, which is
 * what keeps the port's streams requirement-free the way `EngineLike` declares
 * them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<
  EngineLike.EngineLike,
  never,
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
> =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    const services: Context.Context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance> = yield* Effect
      .context<
        Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
      >()
    // The run scope is read from the execution the port is built inside, not
    // declared by a caller, so it cannot be forgotten or spoofed by one.
    const scope: Scope = {
      layers: [
        ...(options.layers ?? []),
        `flows/agent/composition/v1:${Digest.digest(CanonicalJson.stringify(options.layers ?? []))}`
      ],
      run: `${instance.flow._tag}/${instance.executionId}`
    }
    // The engine pins a sealed content key to its execution unless the
    // composition declares a COMPLETE content environment (issue #75): a key
    // whose authority is unknown is treated as unproven-pure and can never be
    // reused by another run. This port is the composition for layers — it
    // already folds the resolved layer set into every key — so it declares
    // that set unconditionally.
    //
    // Capabilities are the host's to declare, and the port must not invent
    // them: an unconditional `capabilities: {}` here would assert "this
    // composition grants nothing", which is false for every host that holds a
    // capability envelope, and would make a sealed boundary computed under a
    // broad envelope cross-run reusable by a run with an attenuated one — the
    // exact stale-cache class issue #75 exists to close. Omitting the field
    // instead leaves keys run-local until a host supplies `Options.capabilities`,
    // and the environment is now complete-or-absent, so an undeclared envelope
    // means no environment reference at all rather than a partial one.
    const context = options.capabilities === undefined
      ? services
      : Context.merge(
        services,
        Context.make(Action.CurrentCacheEnvironment, {
          layers: scope.layers,
          capabilities: options.capabilities
        })
      )

    const sealStep = (
      step: EngineLike.SealedModelStep
    ): Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure | HarnessError.HarnessError> =>
      Stream.unwrap(
        Effect.gen(function*() {
          const key = yield* seal(step, options.route)
          const recorded = yield* Action.make({
            name: sealStepActivityName,
            success: RecordedModelStep,
            error: ModelFailure,
            tier: "sealed",
            idempotencyKey: key,
            execute: recordModelStep(
              options.model,
              step.request,
              options.modelRetryPolicy ?? defaultModelRetryPolicy,
              // The controller's armed budget, carried on the step, so the
              // number a run journals as armed is the number it ran under.
              step.modelCallMs
            )
          })
          const normalized = normalizeRecordedModelStep(recorded)
          const replay = Stream.fromIterable(normalized.events)
          return normalized.error === undefined
            ? replay
            : Stream.concat(replay, Stream.fail(normalized.error))
        }).pipe(Effect.provide(context))
      )

    const splice = (
      batch: Plan.Batch
    ): Stream.Stream<Plan.SpliceEvent, HarnessError.HarnessError> =>
      Stream.unwrap(
        Effect.gen(function*() {
          if (options.plan !== undefined) {
            const current = yield* options.plan.current
            const appended = yield* appendBatch(current, batch, scope)
            yield* options.plan.append(appended)
          }
          return Stream.fromIterable(batch.children).pipe(
            Stream.mapEffect((child) =>
              Effect.gen(function*() {
                const children = options.children
                if (children === undefined) {
                  return yield* Effect.fail(engineFailed("No child runner is configured", child.flowName))
                }
                const key = yield* childKey(child, scope)
                return yield* Action.make({
                  name: childActivityName(child.flowName),
                  success: Plan.ChildResult,
                  error: HarnessError.HarnessError,
                  tier: child.effects.tier,
                  idempotencyKey: key,
                  execute: children.run(child)
                })
              }).pipe(Effect.provide(context))
            ),
            Stream.map((result) => new Plan.ChildSettled({ result }))
          )
        }).pipe(Effect.provide(context))
      )

    const call = (
      request: Cell.Call
    ): Effect.Effect<Cell.CallResult, HarnessError.HarnessError> =>
      Effect.gen(function*() {
        const decoded = yield* Effect.fromResult(Schema.decodeUnknownResult(Cell.Call)(request)).pipe(
          Effect.mapError((cause) =>
            engineFailed(
              `Cell call ${request.flowName} #${request.identity.ordinal} is not serializable`,
              cause
            )
          )
        )
        const calls = options.calls
        if (calls === undefined) {
          return yield* Effect.fail(engineFailed("No cell-call runner is configured", decoded.flowName))
        }
        if (calls.authorize !== undefined) yield* calls.authorize(decoded)
        const key = yield* callKey(decoded, scope)
        return yield* Action.make({
          name: cellCallActivityName(decoded.flowName),
          success: Cell.CallResult,
          error: HarnessError.HarnessError,
          tier: decoded.effects.tier,
          idempotencyKey: key,
          metadata: callBoundary(decoded),
          execute: calls.run(decoded)
        })
      }).pipe(Effect.provide(context))

    const record = <A>(
      boundary: EngineLike.RecordBoundary<A>
    ): Effect.Effect<A, HarnessError.HarnessError> =>
      Effect.gen(function*() {
        const key = yield* boundaryKey(boundary.name, boundary.identity, scope)
        // `irreversible` is the honest tier: the read is not
        // content-addressable and cannot be undone, only recorded — so the
        // boundary is journaled under its run-scoped key and a replayed frame
        // is served the recorded value instead of reading the world again.
        return yield* Action.make({
          name: boundaryActivityName(boundary.name),
          success: boundary.success,
          error: HarnessError.HarnessError,
          tier: "irreversible",
          idempotencyKey: key,
          execute: boundary.execute
        })
      }).pipe(Effect.provide(context))

    // Resolved once, at construction, and asked nothing further. A composition
    // either equips its runs with a way to measure their workspace or it does
    // not, and the controller reads the absence as "unobserved" and says so in
    // the journal rather than presenting declared writes as measurements.
    const observer = yield* Effect.serviceOption(WorkspaceObservation.Observer)
    const observe = Option.match(observer, {
      onNone: (): Effect.Effect<Option.Option<EngineLike.Observation>, HarnessError.HarnessError> =>
        Effect.succeed(Option.none()),
      onSome: (service) => Effect.asSome(service.observe)
    })

    // Resolved once for the same reason the observer is: a composition either
    // equips its runs with somewhere to pin a tree or it does not, and the
    // controller reads the absence as a catchable refusal the cell can route
    // around rather than as a failed run.
    const store = yield* Effect.serviceOption(Checkpoints.Checkpoints)
    const capture = Option.match(store, {
      onNone: () =>
      (
        _request: EngineLike.CaptureRequest
      ): Effect.Effect<Option.Option<EngineLike.Snapshot>, HarnessError.HarnessError> => Effect.succeed(Option.none()),
      onSome: (checkpoints) => (request: EngineLike.CaptureRequest) =>
        checkpoints.capture(request.id).pipe(
          Effect.map((snapshot) => Option.some(new EngineLike.Snapshot({ id: snapshot.id, ref: snapshot.ref }))),
          // A store that failed is reported to the cell as "nothing was
          // pinned", because that is what happened and the cell can act on it.
          // The reason the store gave is not thrown away: it is logged, so a
          // run whose checkpoints never work says why in its own log rather
          // than only in the shape of what it stopped doing.
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.annotateLogs(Effect.logWarning("A checkpoint could not be pinned", cause), {
                checkpoint: request.id
              }),
              Option.none<EngineLike.Snapshot>()
            )
          )
        )
    })

    return EngineLike.make({
      sealStep,
      splice,
      call,
      record,
      observe,
      capture,
      suspend: (reason) =>
        Effect.andThen(
          Effect.annotateLogs(Effect.logDebug("Harness parked the engine frame"), {
            code: reason.code,
            reason: reason.message
          }),
          Flow.suspend(instance)
        )
    })
  })

/**
 * Provides the durable harness engine port.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  EngineLike.EngineLike,
  never,
  FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto
> => Layer.effect(EngineLike.EngineLike)(make(options))
