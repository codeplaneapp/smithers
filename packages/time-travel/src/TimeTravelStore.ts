/**
 * The persistence contract time travel reads history through.
 *
 * `TimeTravelStore` is the only thing that knows how a run's past is stored.
 * It answers the two questions replay cannot answer on its own — what the
 * tier-2 anchors were at a frame, and what state and attempts existed there —
 * and it owns the three mutations time travel performs: writing the audit
 * trail of an in-flight rewind, truncating a run back to a frame, and creating
 * a fork off one. Everything else in the package is a policy layered over this
 * interface.
 *
 * Two implementations satisfy it: `MemoryTimeTravelStore` for tests and
 * browser use, and `SqlTimeTravelStore` for a durable database. They are held
 * to the same behaviour, so a run inspected under one must be inspected
 * identically under the other.
 *
 * `docs/specs/Concepts/Time Travel.md` is the governing design.
 *
 * @since 0.1.0
 */
import type { OwnerId } from "@smthrs/journal/OwnerId"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Frame, LineageEdge } from "./Frame.ts"
import { error, type TimeTravelError } from "./TimeTravelError.ts"
/**
 * The tier-2 anchor recorded at a frame: the jj pointer current when that seq
 * was journaled, and the plan digest in force.
 *
 * `docs/specs/Concepts/Time Travel.md` names exactly these two as the things
 * replay cannot derive and the frame must therefore carry. `planDigest` is
 * optional because a run driven without a persisted plan has none — an absent
 * digest means "no plan was in force", never "the digest was lost".
 *
 * @since 0.1.0
 * @category models
 */
export const Snapshot = Schema.Struct({
  runId: Schema.NonEmptyString,
  frame: Frame,
  changeId: Schema.NonEmptyString,
  planDigest: Schema.optionalKey(Schema.NonEmptyString)
})
/**
 * The value form of {@link Snapshot}.
 *
 * @since 0.1.0
 * @category models
 */
export type Snapshot = typeof Snapshot.Type
/**
 * The attempt rows that existed at a frame, addressed the way
 * `flows_attempts` addresses them.
 *
 * A fork copies exactly this set rather than every attempt the parent ever
 * ran: an attempt that started after the frame is not part of the history the
 * child inherits.
 *
 * @since 0.1.0
 * @category models
 */
export const AttemptRef = Schema.Struct({
  stepKeyDigest: Schema.NonEmptyString,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
/**
 * The value form of {@link AttemptRef}.
 *
 * @since 0.1.0
 * @category models
 */
export type AttemptRef = typeof AttemptRef.Type
/**
 * A run's descendants at a frame, split by whether they still depend on the
 * history under that frame.
 *
 * `attached` children are the ones a rewind must resolve — cancel them, detach
 * them, or refuse — because truncating the parent would cut history out from
 * under them. `detached` children have already been cut loose and are reported
 * only so the operation can say what it left running.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Descendants = Schema.Struct({ attached: Schema.Array(LineageEdge), detached: Schema.Array(LineageEdge) })
/**
 * The value form of {@link Descendants}.
 *
 * @since 0.1.0
 * @category models
 */
export type Descendants = typeof Descendants.Type
/**
 * The durable record of one rewind attempt, written before the rewind touches
 * anything and updated as it progresses.
 *
 * The audit row is what makes a rewind crash-safe: recovery reads back the
 * `in_progress` rows on layer build and either finishes or rolls back the
 * operation that owned each one. `rateLimit` and `detail` stay `Unknown`
 * because they are diagnostic payloads the store never interprets.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Audit = Schema.Struct({
  id: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  frame: Frame,
  status: Schema.Literals(["in_progress", "completed", "failed"]),
  rateLimit: Schema.optionalKey(Schema.Unknown),
  detail: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link Audit}.
 *
 * @since 0.1.0
 * @category models
 */
export type Audit = typeof Audit.Type
/**
 * Proof that one side effect was compensated during a rewind.
 *
 * A rewind reverts effects by calling their registered rollback handlers; each
 * handler returns an opaque receipt, and the receipt is persisted against the
 * audit row before the journal is truncated. That ordering is what lets
 * recovery tell an effect that was already rolled back from one that never
 * was, so a resumed rewind never compensates the same effect twice.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Receipt = Schema.Struct({
  id: Schema.NonEmptyString,
  auditId: Schema.NonEmptyString,
  effectId: Schema.NonEmptyString,
  receipt: Schema.Unknown
})
/**
 * The value form of {@link Receipt}.
 *
 * @since 0.1.0
 * @category models
 */
export type Receipt = typeof Receipt.Type
/**
 * What a truncation actually did: how many journal records it archived, and
 * which lineage edges it left pointing at history that no longer exists.
 *
 * Archiving is not deletion — the records move aside so a forensic reader can
 * still reach them — and `orphaned` is the honest accounting of descendants
 * the operation detached rather than resolved.
 *
 * @since 0.1.0
 * @category schemas
 */
export const ArchiveResult = Schema.Struct({
  archived: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  orphaned: Schema.Array(LineageEdge)
})
/**
 * The value form of {@link ArchiveResult}.
 *
 * @since 0.1.0
 * @category models
 */
export type ArchiveResult = typeof ArchiveResult.Type
/**
 * A fork's outcome: the child run, its lineage edge, and everything the
 * boundary assessment disclosed.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork: a fork never compensates, so the
 * assessment still runs and its blocking and revertible entries are
 * **normalized to warnings** — "this effect may execute again on the child".
 * A fork with a non-empty `warnings` is a successful fork, not a refused one.
 *
 * @since 0.1.0
 * @category models
 */
export const Fork = Schema.Struct({
  runId: Schema.NonEmptyString,
  edge: LineageEdge,
  warnings: Schema.Array(Schema.String)
})
/**
 * The value form of {@link Fork}.
 *
 * @since 0.1.0
 * @category models
 */
export type Fork = typeof Fork.Type
/**
 * The operations a time-travel state store must provide.
 *
 * The reads (`snapshotAt`, `stateAt`, `attemptsAt`, `descendants`) reconstruct
 * a frame's past; the audit trio (`writeAudit`, `updateAudit`,
 * `pendingAudits`) makes an in-flight rewind recoverable; and
 * `archiveAndTruncate`, `createFork`, and `recordReceipt` are the three
 * mutations that change the lineage tree. Implement it with
 * {@link make}, or stub it with {@link makeNoop}.
 *
 * @since 0.1.0
 * @category services
 */
export interface Service {
  readonly snapshotAt: (runId: string, frame: Frame) => Effect.Effect<Snapshot | undefined, TimeTravelError>
  /**
   * Records one tier-2 anchor. Written by the snapshot projector, which folds
   * the engine's `snapshot-identified` records; never by a caller.
   */
  readonly recordSnapshot: (snapshot: Snapshot) => Effect.Effect<void, TimeTravelError>
  /**
   * The run state AT a frame, derived by replaying the run-decision records up
   * to it — not read off the run row, whose `state_json` is the run's *latest*
   * state (`docs/specs/Concepts/Time Travel.md`; Temporal's
   * `ndc/state_rebuilder.go`). Returns the encoded JSON, so the caller decides
   * what schema to read it under.
   */
  readonly stateAt: (runId: string, frame: Frame) => Effect.Effect<string | undefined, TimeTravelError>
  /**
   * The attempts that had been admitted at a frame, derived the same way from
   * the attempt lifecycle records.
   */
  readonly attemptsAt: (runId: string, frame: Frame) => Effect.Effect<ReadonlyArray<AttemptRef>, TimeTravelError>
  /**
   * The lineage edges hanging off this run at or after a frame, split into the
   * children a rewind must resolve and the ones already detached from it.
   */
  readonly descendants: (runId: string, frame: Frame) => Effect.Effect<Descendants, TimeTravelError>
  /**
   * Opens the audit trail for a rewind. Written before anything is
   * compensated or truncated, so a crash always leaves a row recovery can
   * find.
   */
  readonly writeAudit: (audit: Audit) => Effect.Effect<void, TimeTravelError>
  /** Advances an open audit row — normally to `completed` or `failed`. */
  readonly updateAudit: (id: string, patch: Partial<Audit>) => Effect.Effect<void, TimeTravelError>
  /**
   * Every audit row still `in_progress`: the rewinds a crash interrupted.
   * Recovery drains this on layer build.
   */
  readonly pendingAudits: () => Effect.Effect<ReadonlyArray<Audit>, TimeTravelError>
  /**
   * Truncates a run back to a frame, moving the records above it into the
   * archive rather than deleting them, and persisting the compensation
   * `receipts` that justified the truncation.
   *
   * The mutation is fenced on the caller's ownership of the run: the commit
   * re-checks `flows_runs` for `owner` inside the same transaction, and a
   * superseded owner is refused with a typed `fence_lost` error instead of
   * truncating history behind the live owner.
   */
  readonly archiveAndTruncate: (
    runId: string,
    frame: Frame,
    receipts: ReadonlyArray<Receipt>,
    owner: OwnerId
  ) => Effect.Effect<ArchiveResult, TimeTravelError>
  /**
   * Whether the archive holds a record at `(runId, seq)`. This is recovery's
   * commit-point evidence: an interrupted rewind whose live suffix is gone is
   * only "committed" if the suffix actually landed in the archive — an absence
   * on both sides is corruption to roll back, never success to assume.
   */
  readonly archivedAt: (runId: string, seq: number) => Effect.Effect<boolean, TimeTravelError>
  /**
   * Branches a new run off `parentRunId` at a frame, copying the journal
   * prefix and the attempts that existed there, and recording the `fork`
   * lineage edge. The parent is untouched and keeps running.
   */
  readonly createFork: (parentRunId: string, frame: Frame) => Effect.Effect<Fork, TimeTravelError>
  /**
   * Persists one compensation receipt against its audit row, before the
   * journal range that effect belongs to is truncated.
   */
  readonly recordReceipt: (receipt: Receipt) => Effect.Effect<void, TimeTravelError>
}
/**
 * The service key for a {@link Service}. Inject it to read or mutate a run's
 * history; provide it with {@link layerNoop}, `MemoryTimeTravelStore.layer`,
 * or `SqlTimeTravelStore.layer`.
 *
 * @since 0.1.0
 * @category services
 */
export class TimeTravelStore extends Context.Service<TimeTravelStore, Service>()(
  "@smthrs/time-travel/TimeTravelStore"
) {}
/**
 * Brands a {@link Service} implementation as a `TimeTravelStore`, so a new
 * backend is written against the interface and checked at its definition site
 * rather than at the layer.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (implementation: Service): Service => TimeTravelStore.of(implementation)
const unavailable = <A>(method: string): Effect.Effect<A, TimeTravelError> =>
  Effect.fail(error("unknown", `${method} is unavailable`))
/**
 * A store whose every operation fails with an `unknown`-coded
 * {@link TimeTravelError}, except the ones `overrides` supplies.
 *
 * The failing default is deliberate: a test that stubs only the two methods it
 * exercises gets a named failure — not a silent success — the moment the code
 * under test reaches a third. Prefer `MemoryTimeTravelStore` when the test
 * actually needs a working store.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  TimeTravelStore.of({
    snapshotAt: () => unavailable("snapshotAt"),
    recordSnapshot: () => unavailable("recordSnapshot"),
    stateAt: () => unavailable("stateAt"),
    attemptsAt: () => unavailable("attemptsAt"),
    descendants: () => unavailable("descendants"),
    writeAudit: () => unavailable("writeAudit"),
    updateAudit: () => unavailable("updateAudit"),
    pendingAudits: () => unavailable("pendingAudits"),
    archiveAndTruncate: () => unavailable("archiveAndTruncate"),
    archivedAt: () => unavailable("archivedAt"),
    createFork: () => unavailable("createFork"),
    recordReceipt: () => unavailable("recordReceipt"),
    ...overrides
  })
/**
 * Provides {@link makeNoop} as a `TimeTravelStore` layer.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<TimeTravelStore> =>
  Layer.succeed(TimeTravelStore)(makeNoop(overrides))
