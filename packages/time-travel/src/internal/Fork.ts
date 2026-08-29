/**
 * The fork verb: a new run seeded from a parent frame, never a parent mutation.
 *
 * `docs/specs/Concepts/Time Travel.md` §Fork: fork never touches the parent —
 * no compensation, no truncation, no restore of the parent's workspace — but
 * the boundary assessment still runs, and its result is **normalized to
 * warnings**: "this effect may execute again on the child". A fork with
 * warnings is a successful fork that disclosed something, not a refused one.
 *
 * @since 0.1.0
 */
import { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as EffectBoundary from "../EffectBoundary.ts"
import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { type Fork as ForkResult, TimeTravelStore } from "../TimeTravelStore.ts"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"

/**
 * What a fork needs to know: which parent frame to branch from, and where the
 * child's workspace goes.
 *
 * The workspace fields are separate because a fork adds a jj workspace for the
 * child rather than restoring the parent's — the parent keeps its own working
 * copy untouched.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
  readonly parentRunId: string
  readonly frame: Frame
  /** The jj workspace name to create for the child run. */
  readonly workspaceName: string
  /** Where that workspace is materialized on disk. */
  readonly workspacePath: string
  /** Journal page size for the suffix scan; defaults to the store's own. */
  readonly pageSize?: number | undefined
}

/**
 * Reads the journal suffix a fork carries past — the entries the child will
 * diverge from, and therefore the effects it may re-arm.
 */
const suffixAfter = (
  journal: Journal.Service,
  runId: string,
  frame: Frame,
  pageSize: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, TimeTravelError> =>
  Effect.gen(function*() {
    const entries: Array<JournalEvent.Entry> = []
    let after = frame.seq as JournalEvent.Seq
    while (true) {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        after,
        limit: pageSize
      }).pipe(Effect.mapError((cause) => error("unknown", `could not read fork suffix for ${runId}`, cause)))
      entries.push(...page.entries)
      if (!page.hasMore || page.entries.length === 0) return entries
      const next = page.entries.reduce((tail, entry) => entry.seq > tail ? entry.seq : tail, after)
      if (next <= after) {
        return yield* Effect.fail(error("invalid", "journal fork pagination did not advance"))
      }
      after = next
    }
  })

/**
 * Turns a boundary assessment into fork warnings.
 *
 * Smithers' `normalizeBranchReport` is the prior art: blocking and revertible
 * entries both become warnings on a branch operation, because the fork will
 * never revert a parent effect. A `warning` entry keeps its own disclosure.
 */
const normalize = (
  assessments: ReadonlyArray<Compensation.Assessment>
): ReadonlyArray<string> =>
  assessments.map((assessment) =>
    assessment.classification === "warning"
      ? `${assessment.effect.kind} (${assessment.effect.id}): ${assessment.residue}`
      : `${assessment.effect.kind} (${assessment.effect.id}) was classified ${assessment.classification} for rewind; ` +
        `on a fork it is never reverted and may execute again on the child. ${assessment.residue}`
  )

/**
 * Branches a child run off a parent frame.
 *
 * Refuses with `live_parent` if the parent is still running, claimed, or
 * owned — a fork copies a settled prefix, and a live parent has no settled
 * prefix to copy. Otherwise it reads the journal suffix past the frame,
 * assesses the effects in it, normalizes every classification to a warning
 * (see the module header), provisions the child's jj workspace, and only then
 * asks the store to commit the fork in one transaction — so a failed
 * provision leaves nothing durable, and a failed commit forgets the lane it
 * provisioned. The parent is never mutated.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fork = (
  options: ForkOptions
): Effect.Effect<
  ForkResult,
  TimeTravelError,
  | CacheStore.CacheStore
  | EffectHandlerRegistry
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
  | TimeTravelStore
> =>
  Effect.fn("Fork.fork")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        parentRunId: options.parentRunId,
        lineageId: options.frame.lineageId,
        seq: options.frame.seq,
        workspaceName: options.workspaceName
      })
      const runs = yield* RunStore.RunStore
      const parent = yield* runs.get(options.parentRunId).pipe(
        Effect.mapError((cause) => error("unknown", "could not read parent", cause))
      )
      if (parent.status === "running" || parent.claim !== null || parent.owner !== null) {
        return yield* Effect.fail(error("live_parent", `parent run ${options.parentRunId} is live`))
      }
      const store = yield* TimeTravelStore
      const journal = yield* Journal.Journal

      // Assessment BEFORE any mutation, exactly as a rewind does — the fork
      // simply refuses to act on the verdict beyond disclosing it.
      const snapshot = yield* store.snapshotAt(options.parentRunId, options.frame)
      const suffix = yield* suffixAfter(journal, options.parentRunId, options.frame, options.pageSize ?? 100)
      const effects = yield* EffectBoundary.fromEntries(suffix)
      const plan = yield* Compensation.assess(effects, snapshot?.changeId)
      const warnings = normalize(plan.assessments)

      const jj = yield* Jj
      /**
       * PROVISION, THEN COMMIT — in that order, on purpose.
       *
       * The store commit is the fork's finalization step, the way Temporal
       * finalizes a workflow record only after what it names exists
       * (`reference/temporal`'s transactional finalization): `createFork`
       * writes the child run, its copied prefix, attempts, and anchors, and
       * the lineage edge in ONE store transaction, and nothing durable exists
       * until that transaction commits. A failed `workspaceAdd` therefore
       * leaves no orphan child, no half-copied history, and no lineage edge
       * to a run that cannot execute — the durable residue the reverse order
       * left behind. A commit that fails AFTER provisioning is compensated
       * right here by forgetting the lane it provisioned. The residual crash
       * window between the two steps leaves only an unregistered jj
       * workspace on disk, never a lie in the system of record.
       */
      yield* jj.workspaceAdd(options.workspaceName, options.workspacePath, snapshot?.changeId).pipe(
        Effect.mapError((cause) => error("unknown", "could not add fork workspace", cause))
      )
      const result = yield* store.createFork(options.parentRunId, options.frame).pipe(
        Effect.onError(() => jj.workspaceForget(options.workspaceName).pipe(Effect.ignore))
      )
      yield* Effect.addFinalizer(() => jj.workspaceForget(options.workspaceName).pipe(Effect.ignore))
      /**
       * THE CHILD'S WORKTREE IS PINNED AT THE FRAME'S POINTER.
       *
       * `docs/specs/Concepts/Time Travel.md` §Fork wants the child's lane
       * restored to the frame's jj pointer, and `Jj.workspaceAdd` now takes
       * that pointer as its optional `revision`: the new workspace is pinned
       * at provisioning time, so the parent is never restored — "Fork never
       * touches the parent. No compensation, no truncation, no workspace
       * restore of the parent". A frame with no recorded pointer still lands
       * at the lane default, and that is what the warning channel discloses.
       */
      return {
        ...result,
        warnings: snapshot === undefined
          ? [
            ...warnings,
            `Frame ${options.frame.lineageId}@${options.frame.seq} has no recorded jj pointer; ` +
            `the fork workspace ${options.workspaceName} starts from the lane default rather than the frame.`
          ]
          : warnings
      }
    })
  )()
