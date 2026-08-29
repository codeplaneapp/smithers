/**
 * Three gates between asking for work and the work finishing: a plan approval,
 * an in-run approval, and a signal that ends a durable wait.
 *
 * They are three different mechanisms and it is worth keeping them apart.
 *
 * **A plan approval gates the launch.** `Control.plan` produces a `PlanCard` —
 * the flow, the input, the capability envelope, the node list, and a digest
 * over all of it — and the card starts `pending`. `Control.run` on a pending
 * plan does not start anything: it answers a `Parked` receipt reading
 * `waiting-approval`. Approving the exact digest and envelope that were
 * reviewed is what makes the same call launch, and denying it makes the launch
 * refuse. The digest is why an approval cannot be re-aimed at a different plan
 * afterwards.
 *
 * **A node approval gates something inside a run that already started.** It is
 * a durable token registered against the run and resolved exactly once, so a
 * resumed attempt reads the decision instead of asking again.
 *
 * **A signal is a durable fact delivered to a run.** `Control.signal` records
 * it and deliberately resumes nothing: a signal says something happened, it
 * does not decide who runs next. Turning a recorded signal into a completed
 * wait point is the host's job, and {@link deliverSignals} below is that job at
 * its smallest — read the signals the control plane admitted, and complete the
 * `WaitFor` wait point they name.
 *
 * The run itself parks for real: `WaitFor` annotates the park as `event` with a
 * wake token, the engine writes the waiting reason on the run row and releases
 * the run, and `execute` returns while the run stays parked. The control plane
 * and the engine share one SQLite file, which is what lets the plane steer a
 * run it did not start.
 */
import { Control, ControlLive, ControlRuntime, SqlControlRuntime } from "@smthrs/control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { durableEngine } from "./durable-layer.ts"

/** The flow both halves of the example are about. */
export const Ship = Flow.make("examples/Ship", {
  payload: { build: Schema.String },
  success: Schema.Json,
  error: WaitFor.WaitForRequestInvalid,
  body: () => WaitFor.action.call({ name: "ship" })
})

/** The wait point the run parks on, and the resolver's half of it. */
export const gate = WaitFor.deferred("ship")

/** The engine run the node approval and the signal are aimed at. */
export const shipRunId = "examples-ship"

/** The empty capability envelope this flow is planned under. */
const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

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

    /**
     * The acceptance port. It records the launch and answers `pending`, which
     * is the honest answer for a plane whose executor is a queue somebody else
     * drains. An executor that started the run would answer `accepted`.
     */
    const executor = ControlExecutor.layer(
      ControlExecutor.make({
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

    const registrations = Layer.mergeAll(WaitFor.layer, Interpreter.layer(Ship)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    )

    // One database beneath both, so the plane steers the runs the engine owns.
    const stack = Layer.merge(controlPlane, registrations).pipe(
      Layer.provideMerge(durableEngine(filename, "examples-approval"))
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
        // A real durable run that parks. `execute` returns the moment the wait
        // point is durable; nothing is driving the run after that.
        yield* Ship.execute({ build: "v1.4.0" }, { executionId: shipRunId, discard: true })
        const listed = yield* control.list({ _tag: "runs", filters: { runId: shipRunId } })
        const row = listed._tag === "runs" ? listed.items[0] : undefined

        // The in-run approval. Registration is idempotent — an executor calls it
        // on every parked attempt — and answers the token's current state, so a
        // resumed attempt reads the decision instead of asking again.
        const request = {
          _tag: "Node" as const,
          runId: shipRunId as ControlSchema.RunId,
          requestId: "ship-approval",
          digest: card.digest,
          envelope: card.envelope
        }
        yield* runtime.registerApproval(request)
        const approvalReceipt = yield* control.approve({
          target: request,
          scope: "once",
          idempotencyKey: "approve:node" as ControlSchema.IdempotencyKey
        })
        const token = yield* runtime.lookupApproval(request).pipe(
          Effect.map((found) => found.resolved),
          Effect.orElseSucceed(() => true)
        )

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
