/**
 * Run ownership arbitration: liveness evidence, probes, and heartbeat
 * supervision.
 *
 * The identity being arbitrated — {@link OwnerId} — is defined by
 * `@smthrs/journal`, because it is the fencing token the journal accepts on
 * durable appends. It is re-exported here so ownership callers keep reading it
 * as one vocabulary.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 * Schema boundary: `docs/specs/Research/Smithers Deviations 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import { OwnerId } from "@smthrs/journal/OwnerId"
import { Clock, Duration, Effect, Schema } from "effect"
import { heartbeatInterval, heartbeatWriteTolerance } from "./Heartbeat.ts"
import { RunStore } from "./RunStore.ts"

export {
  /**
   * A process identity scoped to a host and a unique ownership nonce, defined
   * by `@smthrs/journal` as the fence on durable appends.
   *
   * @since 0.1.0
   * @category models
   */
  OwnerId
}

/**
 * Evidence that the owner in an exact run snapshot is no longer live.
 *
 * @since 0.1.0
 * @category models
 */
export const LivenessEvidence = Schema.Struct({
  expectedOwner: OwnerId,
  checkedAtMs: Schema.Number,
  kind: Schema.Literals(["same-host-pid-dead", "cross-host-unreachable-stale"])
})

/**
 * Evidence that the owner in an exact run snapshot is no longer live.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessEvidence = typeof LivenessEvidence.Type

/**
 * Injected liveness probe used by ownership arbitration before calling
 * `RunStore.steal`.
 *
 * A probe may inspect a PID only when `expectedOwner.hostId` equals
 * `claimant.hostId`. Cross-host checks must not inspect the local PID and fall
 * back to stale-heartbeat reachability evidence. `RunStore` only validates
 * supplied evidence and never probes a process or network itself.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessProbe<E = never, R = never> = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
) => Effect.Effect<LivenessEvidence | undefined, E, R>

export {
  /**
   * Heartbeat cadence adopted from `RUN_HEARTBEAT_MS` in the Run Ownership
   * vault note.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatInterval,
  /**
   * How far the owner's wall clock may run behind a peer's before the lease
   * reasoning stops holding.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatSkewAllowance,
  /**
   * Heartbeat staleness cutoff adopted from `RUN_HEARTBEAT_STALE_MS` in the
   * Run Ownership vault note.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatStaleAfter,
  /**
   * How long the owner may keep working through *failing* heartbeat writes.
   *
   * @since 0.1.0
   * @category constants
   */
  heartbeatWriteTolerance
} from "./Heartbeat.ts"

/**
 * Runs heartbeats until the persisted ownership fence is lost, then interrupts
 * itself. Race this effect with owned work so structured concurrency
 * interrupts the work when ownership disappears.
 *
 * Pulses are delayed by `heartbeatInterval` and read the Effect `Clock`, so the
 * loop is fully driveable with `TestClock`.
 *
 * A lost fence — any outcome other than `Updated` — is durable evidence and
 * interrupts immediately. A failed heartbeat *write* is not: the persisted
 * heartbeat is still there and no other process may steal the run until it is
 * `heartbeatStaleAfter` old, so transient write errors are tolerated for
 * `heartbeatWriteTolerance` — deliberately shorter than the steal cutoff by a
 * pulse plus `heartbeatSkewAllowance`, so an owner whose clock lags a peer's
 * by up to that allowance is still interrupted *before* the peer may steal the
 * run rather than while it is still running side effects. Past that allowance
 * the fence still protects durable writes but non-durable side effects may
 * overlap; see {@link heartbeatWriteTolerance}. Every successful pulse re-arms
 * the window.
 *
 * @since 0.1.0
 * @category supervision
 */
export const heartbeatLoop = (
  runId: string,
  owner: OwnerId
): Effect.Effect<never, never, RunStore> =>
  Effect.gen(function*() {
    const runStore = yield* RunStore
    const toleranceMs = Duration.toMillis(heartbeatWriteTolerance)
    let lastPulseMs = yield* Clock.currentTimeMillis
    return yield* Effect.sleep(heartbeatInterval).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.flatMap((nowMs) =>
        runStore.heartbeat(runId, owner, nowMs).pipe(
          Effect.flatMap((outcome) =>
            outcome._tag === "Updated"
              ? Effect.sync(() => {
                lastPulseMs = nowMs
              })
              : Effect.interrupt
          ),
          Effect.catch(() => nowMs - lastPulseMs >= toleranceMs ? Effect.interrupt : Effect.void)
        )
      ),
      Effect.forever
    )
  })
