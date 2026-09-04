/**
 * Three gates between asking for work and the work finishing: a plan approval,
 * an in-run approval, and a signal that ends a durable wait.
 *
 * They are three different mechanisms and it is worth keeping them apart.
 *
 * **A plan approval gates the launch.** `Control.plan` produces a `PlanCard`:
 * the flow, the input, the capability envelope, the node list, and a digest
 * over all of it. The card starts `pending`, and `Control.run` on a pending
 * plan does not start anything: it answers a `Parked` receipt reading
 * `waiting-approval`. Approving the exact digest and envelope that were
 * reviewed is what makes the same call launch, and denying it makes the launch
 * refuse. The digest is why an approval cannot be re-aimed at a different plan
 * afterwards.
 *
 * **A node approval gates something inside a run that already started.** The
 * `Clearance` step below registers a durable token against its own run
 * and parks the run under `approval` while that token is undecided. Nothing
 * outside the run asks for it. `Control.approve` refuses a token that was never
 * registered, so an operator can only decide a request a step actually made.
 * Registration is idempotent and answers the token's current state, which is
 * what lets the drive after the decision read it and run through instead of
 * asking again.
 *
 * **A signal is a durable fact delivered to a run.** `Control.signal` records
 * it and deliberately resumes nothing: a signal says something happened, it
 * does not decide who runs next. Turning a recorded signal into a completed
 * wait point is the host's job, and `deliverSignals` below is that job at
 * its smallest: read the signals the control plane admitted, and complete the
 * `WaitFor` wait point they name.
 *
 * Both parks are real, and the run row says which is which. The clearance step
 * annotates its park as `approval` with the request id as the wake token, and
 * `WaitFor` annotates the later one as `event`. Either way the engine writes the
 * waiting reason on the run row and releases the run, and `execute` returns
 * while the run stays parked. The control plane and the engine share one SQLite
 * file, which is what lets the plane steer a run it did not start.
 */
import { Control, ControlLive, ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import { Registry } from "@smthrs/registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/** The empty capability envelope this flow is planned under. */
const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

/** The id the clearance step registers its approval token under. */
export const clearanceRequestId = "ship-clearance"

/**
 * What the clearance request is a decision ABOUT.
 *
 * A node approval carries a digest for the same reason a plan approval does: it
 * pins what was reviewed, so a decision cannot be re-aimed at a different
 * request afterwards. It is deliberately not the plan's digest. The two gates
 * are separate mechanisms and a run that was never planned still has steps
 * worth gating.
 */
export const clearanceDigest = "examples/Ship:clearance"

/** The exact approval request the step registers and an operator decides. */
export const clearanceRequest = (
  runId: string
): Extract<ControlSchema.ApprovalTarget, { readonly _tag: "Node" }> => ({
  _tag: "Node",
  runId: runId as ControlSchema.RunId,
  requestId: clearanceRequestId,
  digest: clearanceDigest,
  envelope
})

/**
 * The wait point the clearance park awaits.
 *
 * Nothing ever completes it, which is the point: an approval is not a value
 * arriving, it is a decision recorded somewhere else. The wake is the operator
 * re-driving the run, and the step reads the decision off the token rather than
 * off this deferred.
 */
const clearanceGate = DurableDeferred.make(`Approval/${clearanceRequestId}`, { success: Schema.Json })

/**
 * The in-run approval gate, as an ordinary step.
 *
 * It is the step that registers the token, not the caller, so the request
 * exists exactly when a run has reached the thing that needs deciding.
 */
export const Clearance = Action.make("examples/Clearance", {
  payload: { requestId: Schema.String },
  success: Schema.String
})

/** The flow both halves of the example are about. */
export const Ship = Flow.make("examples/Ship", {
  payload: { build: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () =>
    Node.andThen(
      Clearance.call({ requestId: clearanceRequestId }),
      () => WaitFor.action.call({ name: "ship" })
    )
})

/** The wait point the run parks on, and the resolver's half of it. */
export const gate = WaitFor.deferred("ship")

/** The engine run the node approval and the signal are aimed at. */
export const shipRunId = "examples-ship"

/**
 * The control-plane flow catalog.
 *
 * `Control.plan` answers `FlowNotFound` for a flow the runtime does not know,
 * so a plan gate needs the flow declared here as well as registered with the
 * engine. The two catalogs are separate on purpose: one is what may be planned,
 * the other is what may be executed.
 */
const flows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "examples/Ship" as ControlSchema.FlowId,
    description: "Ships a build once somebody says so",
    deployClass: false,
    envelope
  }
]

/**
 * Completes every `WaitFor` wait point named by a signal the control plane has
 * admitted for this run.
 *
 * This is the seam a deployment owns. `Control.signal` writes the fact; nothing
 * in the control plane decides that a given signal ends a given wait, because
 * only the flow author knows which wait points exist and what value they carry.
 * Naming the wait point after the signal is this example's convention, and a
 * host with several conventions writes several of these.
 */
export const deliverSignals = (
  runId: string
): Effect.Effect<
  ReadonlyArray<string>,
  never,
  ControlRuntime.ControlRuntime | FlowRuntime.FlowRuntime
> =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime.ControlRuntime
    const signals = yield* runtime.deliveredSignals(runId as ControlSchema.RunId)
    const delivered: Array<string> = []
    for (const signal of signals) {
      const waitPoint = WaitFor.deferred(signal.name)
      yield* DurableDeferred.succeed(waitPoint, {
        token: DurableDeferred.tokenFromExecutionId(waitPoint, { flow: Ship, executionId: runId }),
        value: signal.payload
      })
      delivered.push(signal.name)
    }
    return delivered
  }).pipe(Effect.orDie)

/** What the plan gate did. */
export interface PlanGate {
  /** The receipt `run` answered before anybody approved the plan. */
  readonly beforeApproval: string
  /** The status that receipt reported. */
  readonly beforeApprovalStatus: string
  /** The receipt `run` answered once the plan was approved. */
  readonly afterApproval: string
  /** The decision the stored plan carries after approval. */
  readonly decision: string
  /** The decision the second, denied plan carries. */
  readonly deniedDecision: string
  /** The failure `run` answered for the denied plan. */
  readonly deniedLaunch: string
  /** How many launches the executor was handed. */
  readonly launches: number
}

/** What the in-run gates did. */
export interface RunGates {
  /** The status the run had after the drive that reached the clearance step. */
  readonly firstPark: string
  /** What the engine recorded that first park as waiting for. */
  readonly firstWaitingFor: string | undefined
  /** What the clearance step read off its token, once per time it ran. */
  readonly clearanceReads: ReadonlyArray<boolean>
  /** The status the control plane reported for the parked run. */
  readonly parked: string
  /** What the engine recorded the run as waiting for. */
  readonly waitingFor: string | undefined
  /** The receipt the node approval answered. */
  readonly approvalReceipt: string
  /** Whether the durable approval token is resolved. */
  readonly approvalResolved: boolean
  /** The approval decisions the run's journal carries, by target. */
  readonly approvals: ReadonlyArray<string>
  /** The signals the control plane admitted for the run. */
  readonly signals: ReadonlyArray<string>
  /** The wait points the host completed from those signals. */
  readonly delivered: ReadonlyArray<string>
  /** The value the run finished with, which is the signal's payload. */
  readonly result: unknown
}

/** Everything one pass observed. */
export interface Summary {
  readonly plan: PlanGate
  readonly run: RunGates
}

const receipt = (value: { readonly _tag: string }): string => value._tag

/** Runs both gates over one SQLite file. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    let launches = 0
    const clearanceReads: Array<boolean> = []

    /**
     * The clearance step's implementation: register, read, park or proceed.
     *
     * `registerApproval` is the whole gate. It creates the token the first time
     * and answers the existing one afterwards, so this handler asks the same
     * question on every attempt and gets a different answer once somebody has
     * decided. Parking rather than failing is the honest shape: the run has
     * done nothing wrong, it is waiting for a person.
     */
    const clearance = Clearance.toLayer(({ requestId }) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        const runtime = yield* ControlRuntime.ControlRuntime
        const token = yield* Effect.orDie(runtime.registerApproval(clearanceRequest(instance.executionId)))
        clearanceReads.push(token.resolved)
        if (token.resolved) return token.tokenId
        // The request id is the wake token an operator's tooling matches on.
        yield* FlowRuntime.annotateWaiting({ reason: "approval", token: requestId })
        yield* DurableDeferred.await(clearanceGate)
        return token.tokenId
      })
    )

    /**
     * The acceptance port. It records the launch and answers `pending`, which
     * is the honest answer for a plane whose executor is a queue somebody else
     * drains. An executor that started the run would answer `accepted`.
     */
    const executor = ControlExecutor.layer(
      ControlExecutor.makeNoop({
        launch: () =>
          Effect.sync(() => {
            launches += 1
            return "pending" as const
          })
      })
    )

    const controlPlane = ControlLive.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          SqlControlRuntime.layer({
            flows,
            owner: { hostId: "examples-approval", pid: 1, nonce: "approval" }
          }).pipe(Layer.orDie),
          NotificationQueue.layer,
          executor,
          Registry.layerNoop()
        )
      )
    )

    // One database beneath both, so the plane steers the runs the engine owns.
    const plane = controlPlane.pipe(Layer.provideMerge(durableEngine(filename, "examples-approval")))

    // The clearance step reads the control plane, so the registrations are
    // built OVER the plane rather than beside it. That is the dependency the
    // gate is: a step that consults a decision needs the service that holds it.
    const stack = Layer.mergeAll(clearance, WaitFor.layer, Interpreter.layer(Ship)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(plane)
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime

        // ------------------------------------------------------- the plan gate
        const card = yield* control.plan({
          flowId: "examples/Ship" as ControlSchema.FlowId,
          input: { build: "v1.4.0" }
        })
        const launch = {
          _tag: "Plan" as const,
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope
        }
        // A pending plan does not launch. The receipt says why.
        const beforeApproval = yield* control.run({
          ...launch,
          idempotencyKey: "run:before" as ControlSchema.IdempotencyKey
        })
        yield* control.approve({
          target: { _tag: "Plan", planId: card.planId, digest: card.digest, envelope: card.envelope },
          scope: card.approval.scope,
          idempotencyKey: "approve:plan" as ControlSchema.IdempotencyKey
        })
        const afterApproval = yield* control.run({
          ...launch,
          idempotencyKey: "run:after" as ControlSchema.IdempotencyKey
        })
        const approved = yield* runtime.getPlan(card.planId)

        // A second plan, denied. The launch refuses rather than parking.
        const rejected = yield* control.plan({
          flowId: "examples/Ship" as ControlSchema.FlowId,
          input: { build: "v1.4.1" }
        })
        yield* control.deny({
          target: {
            _tag: "Plan",
            planId: rejected.planId,
            digest: rejected.digest,
            envelope: rejected.envelope
          },
          scope: rejected.approval.scope,
          idempotencyKey: "deny:plan" as ControlSchema.IdempotencyKey
        })
        const deniedPlan = yield* runtime.getPlan(rejected.planId)
        const deniedLaunch = yield* Effect.match(
          control.run({
            _tag: "Plan",
            planId: rejected.planId,
            digest: rejected.digest,
            envelope: rejected.envelope,
            idempotencyKey: "run:denied" as ControlSchema.IdempotencyKey
          }),
          { onFailure: (error) => String(error._tag), onSuccess: () => "launched" }
        )

        // -------------------------------------------------------- the run gates
        // A real durable run that parks. `execute` returns the moment the park
        // is durable; nothing is driving the run after that.
        //
        // Drive one reaches the clearance step, which registers its own token,
        // finds it undecided, and parks the run under `approval`.
        yield* Ship.execute({ build: "v1.4.0" }, { executionId: shipRunId, discard: true })
        const first = yield* control.list({ _tag: "runs", filters: { runId: shipRunId } })
        const firstRow = first._tag === "runs" ? first.items[0] : undefined

        // The decision, taken from outside the run against the token the STEP
        // registered. `approve` looks the token up rather than creating one, so
        // this call could not have run before the step parked.
        const request = clearanceRequest(shipRunId)
        const approvalReceipt = yield* control.approve({
          target: request,
          scope: "once",
          idempotencyKey: "approve:node" as ControlSchema.IdempotencyKey
        })
        // Resolved exactly once: `lookupApproval` refuses a resolved token, so
        // the refusal IS the durable evidence that the decision stuck.
        const token = yield* runtime.lookupApproval(request).pipe(
          Effect.map((found) => found.resolved),
          Effect.orElseSucceed(() => true)
        )

        // Drive two: the same step runs again, reads the resolved token, and
        // lets the run through to its next wait instead of asking a second
        // time.
        yield* Ship.execute({ build: "v1.4.0" }, { executionId: shipRunId, discard: true })
        const listed = yield* control.list({ _tag: "runs", filters: { runId: shipRunId } })
        const row = listed._tag === "runs" ? listed.items[0] : undefined

        // The signal. It records a fact and resumes nothing.
        yield* control.signal({
          runId: shipRunId as ControlSchema.RunId,
          signal: { name: "ship", payload: { approved: true, by: "release-manager" } },
          idempotencyKey: "signal:ship" as ControlSchema.IdempotencyKey
        })
        const signals = yield* runtime.deliveredSignals(shipRunId as ControlSchema.RunId)
        // The host turns the recorded fact into a completed wait point.
        const delivered = yield* deliverSignals(shipRunId)
        const result = yield* Ship.execute({ build: "v1.4.0" }, { executionId: shipRunId })

        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: shipRunId as JournalEvent.RunId, limit: 500 })
        const approvals = page.entries
          .filter((entry) => entry.eventType === "control.approval.approved")
          .map((entry) => (entry.payload as { readonly target: string }).target)

        return {
          plan: {
            beforeApproval: receipt(beforeApproval),
            beforeApprovalStatus: "status" in beforeApproval ? String(beforeApproval.status) : "none",
            afterApproval: receipt(afterApproval),
            decision: approved.decision,
            deniedDecision: deniedPlan.decision,
            deniedLaunch,
            launches
          },
          run: {
            firstPark: firstRow?.status ?? "unknown",
            firstWaitingFor: firstRow?.waitingReason,
            clearanceReads: [...clearanceReads],
            parked: row?.status ?? "unknown",
            waitingFor: row?.waitingReason,
            approvalReceipt: receipt(approvalReceipt),
            approvalResolved: token,
            approvals,
            signals: signals.map((signal) => signal.name),
            delivered,
            result
          }
        } satisfies Summary
      }).pipe(Effect.provide(stack))
    )
  }).pipe(Effect.orDie)
