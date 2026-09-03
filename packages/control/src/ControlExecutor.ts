/**
 * Acceptance port from the control plane into a real run executor.
 *
 * Governing contract: `docs/pages/control/index.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import type { LaunchFailed, PersistenceError } from "./ControlError.ts"
import type { StoredPlan } from "./ControlRuntime.ts"
import type { RunId, RunSummary, SignalPayload } from "./ControlSchema.ts"

/**
 * One stored plan and the run summary it is being started as.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Launch {
  readonly plan: StoredPlan
  readonly run: RunSummary
}

/**
 * Whether the executor took the launch now or queued it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Acceptance = "accepted" | "pending"

/**
 * One run whose cancellation has to become durable on the engine row.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CancelRequest {
  readonly runId: RunId
}

/**
 * The engine row a cancel request arrived too late for.
 *
 * It carries the ENGINE's status rather than a bare marker because the control
 * plane cannot read that row: in the shipped CLI the two `flows_runs` tables
 * live in two files (`.flows/control.db` and `.flows/engine.db`), so the port
 * is the only place the plane learns what actually became of the run.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CancelTerminal {
  readonly _tag: "Terminal"
  readonly status: "completed" | "failed" | "cancelled"
}

/**
 * What the executor did with a cancel request.
 *
 * `recorded` means THIS call set `cancel_requested_at_ms` on the engine row, so
 * the owning process stops the run at its next cancel poll whichever process
 * asked. `already-requested` means the column was already set when this call
 * arrived: the request is just as durable, and the cancellation it belongs to
 * was somebody else's. `Control.cancel` keys its attribution event on that
 * difference — the write is first-writer-wins and every repeat re-runs the
 * whole mutation, so answering `recorded` to all of them left one journaled
 * `control.run.cancel-requested` per ask for a single cancellation (release validation
 * smoke: three `cancel` calls and one `down` against one parked run left four).
 * `unknown` means this executor's engine has no row for the run at all, which
 * is the honest answer for a run another composition launched into a database
 * this one does not share. A {@link CancelTerminal} means the engine row has
 * already settled, so there is nothing left to stop: recording intent on it
 * would be a request no process can ever act on, and answering `recorded` let
 * `Control.cancel` write a terminal control status the engine row does not have
 * (triage B-11).
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CancelRecord = "recorded" | "already-requested" | "unknown" | CancelTerminal

/**
 * One parked run that has been told to resume.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ResumeRequest {
  readonly runId: RunId
}

/**
 * What the executor did with a resume request.
 *
 * `resuming` means this executor hosts the run's execution, has taken the
 * control row's fence, and is re-driving it: the caller can stop, and the run
 * moves on its own. `unknown` means this executor drives no execution for the
 * run, which is the answer an operator's CLI, a gateway, or any second process
 * gives, and it is why the control plane records the delegation durably
 * instead of treating its own journal entry as the delivery (triage B-15).
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ResumeUptake = "resuming" | "unknown"

/**
 * One signal to deliver to a run's open wait point.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Signal {
  readonly runId: RunId
  readonly signal: SignalPayload
}

/**
 * What the executor did with a signal.
 *
 * `delivered` means the `WaitFor` deferred the run is parked on was completed
 * with the signal's payload and the run was woken. `no-match` means the run IS
 * parked and is waiting for something else, which `Control.signal` refuses
 * rather than recording a delivery nothing consumes. `unknown` means this
 * executor is driving no execution for the run at all — another process may
 * be, or none is yet — so the recorded message is the whole delivery and the
 * executor that eventually drives the run replays it at its next start.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SignalDelivery = "delivered" | "no-match" | "unknown"

/**
 * The executor port: the control plane hands work over to a real run executor
 * and learns only what the executor did with it.
 *
 * `launch` is acceptance. `requestCancel`, `deliverSignal`, and `resumeRun`
 * are the three requests that have to reach the engine to mean anything: a
 * cancel is durable on the engine row so that whichever process owns the run
 * stops it, a signal completes the wait point a parked run is actually waiting
 * on, and a resume re-drives the execution an approval decision unblocked.
 * Without them the control plane records facts nobody reads — a cancel that
 * answers `ClaimLost` to every process but the owner, a signal a parked run
 * never sees, and a resume event published into an in-process hub no other
 * process subscribes to (the release policy; triage B-10, B-13, B-15).
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly launch: (input: Launch) => Effect.Effect<Acceptance, LaunchFailed>
  /**
   * Records a cancellation on the engine row, durably, regardless of which
   * process owns the run.
   */
  readonly requestCancel: (input: CancelRequest) => Effect.Effect<CancelRecord, PersistenceError>
  /**
   * Completes the run's open `WaitFor` wait point with the signal's payload.
   */
  readonly deliverSignal: (input: Signal) => Effect.Effect<SignalDelivery, PersistenceError>
  /**
   * Takes up a resume: claims the control row and re-drives the execution,
   * when this executor is the one hosting it.
   */
  readonly resumeRun: (input: ResumeRequest) => Effect.Effect<ResumeUptake, PersistenceError>
  /**
   * Finishes a PARKED execution whose cancellation is already durable.
   *
   * A park has no owner — that is what makes it resumable — so nothing is
   * driving the run and nothing reads the request {@link requestCancel} wrote.
   * The engine's parked-run sweep does, once per heartbeat, but a `smithers
   * cancel` process writes the request at the very end of its life and exits
   * before that tick: the release validation watched an engine row stay
   * `suspended` with `cancel_requested_at_ms` set through six more commands
   * and fifteen seconds, so `gc` collected the run in `control.db` and
   * skipped it in `engine.db`.
   *
   * Called AFTER the cancel mutation commits, never inside it: driving a run
   * re-enters the engine, whose writes would wait on the writer the
   * mutation's transaction holds. An executor that does not host the run, or
   * one whose run is not parked, does nothing and leaves the durable request
   * standing for the host that does.
   */
  readonly settleCancelledPark: (input: CancelRequest) => Effect.Effect<void, PersistenceError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class ControlExecutor extends Context.Service<ControlExecutor, Service>()(
  "/control/ControlExecutor"
) {}

/**
 * Builds a {@link Service} from an implementation of its methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: Service): Service => ControlExecutor.of(implementation)

/**
 * A {@link Service} that accepts every launch as `pending` and starts
 * nothing. Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    launch: Effect.fn("ControlExecutor.launch")(() => Effect.succeed("pending" as const)),
    // An executor that starts nothing owns no engine row and no wait point, so
    // it records no cancel and matches no signal. `Control.cancel` still writes
    // its journal entry and interrupts a local fiber, and `Control.signal`
    // still records the message: both are what the port's absence already did.
    requestCancel: Effect.fn("ControlExecutor.requestCancel")(() => Effect.succeed("unknown" as const)),
    deliverSignal: Effect.fn("ControlExecutor.deliverSignal")(() => Effect.succeed("unknown" as const)),
    resumeRun: Effect.fn("ControlExecutor.resumeRun")(() => Effect.succeed("unknown" as const)),
    settleCancelledPark: Effect.fn("ControlExecutor.settleCancelledPark")(() => Effect.void),
    ...overrides
  })

/**
 * Provides {@link ControlExecutor} from an implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: Service): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(make(implementation))

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<ControlExecutor> =>
  Layer.succeed(ControlExecutor)(makeNoop(overrides))
