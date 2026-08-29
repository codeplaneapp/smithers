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
 * What a fork needs to know: which parent frame to branch from, and which lane
 * the child's workspace goes under.
 *
 * The lane is a root rather than a full path because a fork adds a jj
 * workspace for the child rather than restoring the parent's — the parent
 * keeps its own working copy untouched — and the child's own run id, minted
 * inside the operation, is what names it.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
  readonly parentRunId: string
  readonly frame: Frame
  /**
   * The lane the child's jj workspace is materialized under. The workspace's
   * own name is {@link workspaceNameFor} of the child run id, never a
   * caller-supplied label: the fork mints the child id first precisely so the
   * lane and the run it holds carry one identity.
   */
  readonly workspaceRoot: string
  /** Journal page size for the suffix scan; defaults to the store's own. */
  readonly pageSize?: number | undefined
}

/**
 * Everything a jj workspace name and a directory component both accept.
 *
 * @since 0.1.0
 * @category constructors
 */
const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "-")

/**
 * FNV-1a over the run id, as eight lowercase hexadecimal characters.
 *
 * This is a disambiguator, not an identity: it never crosses the journal, the
 * cache, or the wire, so it does not go through `@smthrs/crypto`'s injected
 * SHA-256, whose `Crypto` requirement would follow every fork into every
 * composition. What it must be is browser-safe, synchronous, and total, which
 * a 32-bit multiply-and-xor over the code units is.
 *
 * @since 0.1.0
 * @category constructors
 */
const digest = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * The workspace name a forked run's lane carries.
 *
 * THE CHILD RUN ID IS THE ONLY INPUT, on purpose. Naming the lane after the
 * parent frame, meaning the parent run id and the frame's seq, gave the second
 * fork of one frame the first child's name, and gave two parents that differ
 * only in a character the sanitizer folds (`demo/a` and `demo:a`) one shared
 * name.
 * The child run id distinguishes exactly what the store distinguishes, and the
 * digest of the RAW id restores what sanitizing and the 64-character cap fold
 * away. Two children share a name only when their sanitized, capped ids match
 * AND their raw ids share a 32-bit FNV-1a digest, about one pair in 4.3
 * billion for ids that already differ by an ordinal the store hands out. That
 * residual case is loud rather than silent: `jj workspace add` refuses a name
 * the repository already holds, so the fork fails instead of two runs sharing
 * one directory.
 *
 * `jj workspace list` shows this name to an operator, so it carries the
 * product's name rather than the imported repository's.
 *
 * @since 0.1.0
 * @category constructors
 */
export const workspaceNameFor = (childRunId: string): string =>
  `smithers-fork-${sanitize(childRunId).slice(0, 64)}-${digest(childRunId)}`

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
 * (see the module header), mints the child's run id, provisions that child's
 * jj workspace under {@link ForkOptions.workspaceRoot}, and only then asks the
 * store to commit the fork in one transaction — so a failed provision leaves
 * nothing durable, and a failed commit forgets the lane it provisioned. The
 * parent is never mutated.
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
        seq: options.frame.seq
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
       * MINT, THEN PROVISION, THEN COMMIT — in that order, on purpose.
       *
       * The mint is what makes the lane and the child one identity: the
       * workspace is named after the run that will live in it, so a frame
       * forked twice provisions two lanes and two parents that sanitize alike
       * never share one. Nothing durable exists yet — `nextForkId` writes
       * nothing — so a mint that is never committed costs an unused ordinal.
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
      const childRunId = yield* store.nextForkId(options.parentRunId, options.frame)
      const workspaceName = workspaceNameFor(childRunId)
      yield* Effect.annotateCurrentSpan({ childRunId, workspaceName })
      yield* jj.workspaceAdd(workspaceName, `${options.workspaceRoot}/${workspaceName}`, snapshot?.changeId).pipe(
        Effect.mapError((cause) => error("unknown", "could not add fork workspace", cause))
      )
      const result = yield* store.createFork(options.parentRunId, options.frame, childRunId).pipe(
        Effect.onError(() => jj.workspaceForget(workspaceName).pipe(Effect.ignore))
      )
      yield* Effect.addFinalizer(() => jj.workspaceForget(workspaceName).pipe(Effect.ignore))
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
            `the fork workspace ${workspaceName} starts from the lane default rather than the frame.`
          ]
          : warnings
      }
    })
  )()
