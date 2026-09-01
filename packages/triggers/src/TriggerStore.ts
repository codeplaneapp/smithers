/**
 * Durable trigger declaration and fire store.
 *
 * @see packages/triggers/docs/api.md
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import type { Action } from "./Overlap.ts"
import type { Trigger } from "./Trigger.ts"
import { TriggerError } from "./TriggerError.ts"

/**
 * A stored trigger, with the revision that fences concurrent edits and
 * when it last fired.
 *
 * @category models
 * @since 0.1.0
 */
export interface Registered extends Trigger {
  readonly revision: number
  readonly lastFiredAt?: number | undefined
}
/**
 * One scheduled occurrence of a trigger, addressed by its occurrence
 * number so a retry cannot fire it twice.
 *
 * @category models
 * @since 0.1.0
 */
export interface Fire {
  readonly triggerId: string
  readonly occurrence: number
}
/**
 * A {@link Fire} together with the revision it was computed from and whether
 * it is resuming a buffered occurrence.
 *
 * The overlap policy is deliberately absent. A claim applies the policy stored
 * on the trigger row, read inside the same transaction, so a caller holding a
 * stale snapshot cannot fire a trigger that has since been disabled, cannot
 * point it at a different flow, and cannot supersede a run that the stored
 * declaration says to leave alone. `expectedRevision` is the fence: a claim
 * whose revision no longer matches the row is refused with `revision_mismatch`
 * so the caller re-reads before deciding again.
 *
 * @category models
 * @since 0.1.0
 */
export interface ClaimFire extends Fire {
  readonly expectedRevision: number
  readonly resumeBuffered?: boolean | undefined
}
/**
 * The outcome of claiming an occurrence: either another worker holds it, or
 * this caller does and must take `action`.
 *
 * @category models
 * @since 0.1.0
 */
export type Claim =
  | { readonly claimed: false }
  | {
    readonly claimed: true
    readonly action: Action
    readonly reservationId?: string | undefined
    readonly activeRunId?: string | undefined
  }
/**
 * The prefix marking an `active_run_id` that is a launch reservation rather
 * than a run the runtime knows about.
 *
 * A reservation is written by the claim and replaced by the real run id once
 * the launch reports one, so both stores and the scheduler read this prefix.
 * It is a contract between them and lives here rather than being re-spelled at
 * each site.
 *
 * @category constants
 * @since 0.1.0
 */
export const reservationPrefix = "trigger-reservation:"

/**
 * The reservation id one occurrence of one trigger claims.
 *
 * @category constructors
 * @since 0.1.0
 */
export const reservationId = (triggerId: string, occurrence: number): string =>
  `${reservationPrefix}${triggerId}:${occurrence}`

/**
 * Whether a stored `active_run_id` is a launch reservation.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isReservation = (runId: string | undefined): boolean =>
  runId !== undefined && runId.startsWith(reservationPrefix)

/**
 * How a claimed occurrence ended.
 *
 * @category models
 * @since 0.1.0
 */
export type Outcome = "launched" | "completed" | "skipped" | "buffered" | "superseded" | "failed"
/**
 * The reported end of one occurrence, with the run it started when it
 * launched one.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result extends Fire {
  readonly outcome: Outcome
  readonly runId?: string | undefined
  readonly error?: string | undefined
}

/**
 * Durable trigger state: registration, enabled-trigger listing, and the claim
 * protocol that keeps two schedulers from firing the same occurrence.
 *
 * `listEnabled` is not a due-time query. Due-ness is a cron computation the
 * scheduler performs against its own watermark, so the store is asked only for
 * the triggers eligible to be considered.
 *
 * Every method addressing one trigger fails with `unknown_trigger` when no
 * such row exists, except `clearActive`, whose compare-and-swap cannot tell a
 * missing trigger from a run id that no longer matches and so stays a no-op
 * for both.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly register: (trigger: Trigger) => Effect.Effect<Registered, TriggerError>
  readonly get: (triggerId: string) => Effect.Effect<Option.Option<Registered>, TriggerError>
  readonly list: () => Effect.Effect<ReadonlyArray<Registered>, TriggerError>
  readonly listEnabled: () => Effect.Effect<ReadonlyArray<Registered>, TriggerError>
  readonly claimFire: (fire: ClaimFire) => Effect.Effect<Claim, TriggerError>
  readonly recordResult: (result: Result) => Effect.Effect<void, TriggerError>
  readonly setPending: (fire: Fire) => Effect.Effect<void, TriggerError>
  readonly takePending: (triggerId: string) => Effect.Effect<Option.Option<number>, TriggerError>
  readonly activeRun: (triggerId: string) => Effect.Effect<Option.Option<string>, TriggerError>
  readonly clearActive: (triggerId: string, runId: string) => Effect.Effect<void, TriggerError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class TriggerStore extends Context.Service<TriggerStore, Service>()("flows/triggers/TriggerStore") {}

const unavailable = (method: string): Effect.Effect<never, TriggerError> =>
  Effect.fail(new TriggerError({ code: "store", message: `${method} is unavailable` }))

/**
 * A {@link Service} that fails every method as unavailable, for an
 * environment with no trigger store. Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  register: () => unavailable("register"),
  get: () => unavailable("get"),
  list: () => unavailable("list"),
  listEnabled: () => unavailable("listEnabled"),
  claimFire: () => unavailable("claimFire"),
  recordResult: () => unavailable("recordResult"),
  setPending: () => unavailable("setPending"),
  takePending: () => unavailable("takePending"),
  activeRun: () => unavailable("activeRun"),
  clearActive: () => unavailable("clearActive"),
  ...overrides
})

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<TriggerStore> =>
  Layer.succeed(TriggerStore)(makeNoop(overrides))
