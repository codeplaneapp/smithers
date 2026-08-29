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
import { heartbeatInterval, heartbeatStaleAfter, heartbeatWriteTolerance } from "./Heartbeat.ts"
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
 * Two of the three kinds are collected outside the store: `same-host-pid-dead`
 * is a local process probe, and `cross-host-unreachable-stale` is a
 * reachability judgement the deployment makes. `lease-expired` is different —
 * it asserts only that the persisted heartbeat is older than the staleness
 * cutoff, which is the one claim the store can check for itself, and `steal`
 * checks it: the write refuses any row whose `heartbeat_at_ms` is still inside
 * the window. It is therefore accepted from a claimant on any host, while the
 * other two stay bound to the host relation that makes them meaningful.
 *
 * @since 0.1.0
 * @category models
 */
export const LivenessEvidence = Schema.Struct({
  expectedOwner: OwnerId,
  checkedAtMs: Schema.Number,
  kind: Schema.Literals(["same-host-pid-dead", "cross-host-unreachable-stale", "lease-expired"])
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

/**
 * What a liveness check knows about the run it is asked about, beyond the
 * owner recorded on it.
 *
 * The lease is here because it is the only liveness signal every deployment
 * has: `heartbeatAtMs` is the last heartbeat the owner persisted, `nowMs` is
 * the reading the arbitration is made against, and `claimant` is the identity
 * that would take the run over. A check that wants to probe a pid compares
 * hosts with {@link sameHostIncarnation} first; a check that has nothing but
 * the lease uses {@link leaseLiveness}.
 *
 * @since 0.1.0
 * @category models
 */
export interface LivenessContext {
  readonly claimant: OwnerId
  readonly heartbeatAtMs: number | null
  readonly nowMs: number
}

/**
 * The question ownership arbitration asks before it steals a run: is the
 * recorded owner still working?
 *
 * Answering `true` refuses the takeover. The engine consults this only for a
 * run whose lease has already expired, so a check that has no better evidence
 * than the lease answers `false` there — which is exactly what
 * {@link leaseLiveness} does.
 *
 * @since 0.1.0
 * @category models
 */
export type LivenessCheck = (
  expectedOwner: OwnerId,
  context: LivenessContext
) => Effect.Effect<boolean>

/**
 * Whether two owner identities are incarnations on the same host.
 *
 * The predicate a probe applies before it inspects a pid: `owner.pid` names a
 * process in the claimant's own process namespace only when the hosts match,
 * so a cross-host probe that read it would be answering about an unrelated
 * process. Exposed because the check that needs it — a
 * `process.kill(pid, 0)` probe — belongs to a platform package rather than
 * here.
 *
 * @since 0.1.0
 * @category ownership
 */
export const sameHostIncarnation = (
  expectedOwner: OwnerId,
  claimant: OwnerId
): boolean => expectedOwner.hostId === claimant.hostId

/**
 * The default liveness check: the lease, and nothing else.
 *
 * An owner is treated as alive for as long as its persisted heartbeat is
 * younger than `staleAfter`, and as gone once it is not. That is the weakest
 * honest answer, and it is the one every host can give: a fresh process with
 * no application code at all can reclaim a hard-killed owner's runs once the
 * lease it stopped renewing has expired. A deployment that can say more — a
 * pid probe on the owner's host, an orchestrator that reports pod liveness —
 * supplies its own {@link LivenessCheck} and refuses the takeover for longer.
 *
 * An owner with no recorded heartbeat holds no lease and is reported gone; the
 * steal it enables is still gated by the store's own snapshot compare-and-swap.
 *
 * @since 0.1.0
 * @category ownership
 */
export const leaseLiveness = (
  staleAfter: Duration.Input = heartbeatStaleAfter
): LivenessCheck => {
  const staleAfterMs = Duration.toMillis(staleAfter)
  return (_expectedOwner, context) =>
    Effect.succeed(
      context.heartbeatAtMs !== null &&
        context.heartbeatAtMs >= context.nowMs - staleAfterMs
    )
}

/**
 * The Node hosts' liveness check: does the owner's process still exist?
 *
 * {@link leaseLiveness} is the honest floor — every host can read a persisted
 * heartbeat — but it is only a timeout, so two engine processes over one
 * database steal each other's running rows `heartbeatStaleAfter` after any
 * heartbeat stall: a stop-the-world pause, a swapped-out process, a disk that
 * blocked longer than the window. This answers the question the lease is
 * standing in for, by asking the operating system whether the recorded pid is
 * still there.
 *
 * `process.kill(pid, 0)` sends no signal; it performs only the delivery
 * checks. Three answers matter:
 *
 * - It returns: the process exists and is signalable. The owner is alive.
 * - It throws `EPERM`: the process EXISTS and this user may not signal it.
 *   That is a positive liveness answer, not a failure — reading it as death
 *   would let one user's engine steal from another's on a shared host.
 * - It throws anything else (`ESRCH`): no such process. The owner is gone.
 *
 * A pid is only meaningful inside one process namespace, so a recorded owner
 * on another host is never probed: the answer is `false` and the arbitration
 * falls back to the evidence that does cross hosts — the expired lease, which
 * `RunStore.steal` verifies for itself. The engine consults this check only
 * for a run whose lease has ALREADY expired, so answering `false` here does
 * not weaken anything; it declines to add evidence.
 *
 * Node hosts only. It is not part of the browser promise: this entry point
 * bundles for the browser because it never imports a `node:` built-in, and a
 * browser composition has no process table to ask, so it keeps
 * {@link leaseLiveness}.
 *
 * `@smthrs/platform-node`'s `HostLiveness.isAlive` asks the same question of
 * the same process table and differs in one deliberate place: it answers
 * `true` for an owner on another host, which refuses the steal outright, while
 * this check answers `false` and lets the expired lease decide. The difference
 * matters after a host dies for good — under the refusing answer its runs are
 * never reclaimed by anyone, because no other machine can ever produce
 * evidence about its pids.
 *
 * @since 0.1.0
 * @category ownership
 */
export const sameHostPidProbe: LivenessCheck = (expectedOwner, context) =>
  Effect.sync(() => {
    if (!sameHostIncarnation(expectedOwner, context.claimant)) return false
    try {
      process.kill(expectedOwner.pid, 0)
      return true
    } catch (error) {
      return (error as { readonly code?: string | undefined } | null)?.code === "EPERM"
    }
  })

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
