/**
 * Retention: the one operation that deletes finished run state.
 *
 * Nothing in the composition removed a `flows_runs` row or anything that hangs
 * off one. Every run a workspace ever finished stayed in `.flows/engine.db`
 * with its attempts, its persisted deferred completions and clock deadlines,
 * its journal entries, and its checkpoints, and journal compaction is off by
 * default (`SqlJournal` `Options.compaction`), so the file only grew. This
 * module is the deletion side, and the whole of it: one operation, run
 * explicitly.
 *
 * Three properties make it safe to run against a live workspace.
 *
 * - **One transaction.** Every delete runs inside a single `journal.transact`,
 *   so a crash leaves either a run with all of its rows or none of them —
 *   never a run row whose history is gone, or history whose run row is gone.
 * - **Terminal and aged only.** A run is a candidate only when its status is
 *   `completed`, `failed`, or `cancelled` AND it finished before the cutoff.
 *   A running, pending, or suspended run is never a candidate at any age.
 * - **Nothing a live run still needs.** A candidate is retained when a live
 *   run stands on either side of it in the lineage, over BOTH relations that
 *   make one run the parent of another: the `flows_run_parents` edge a spawned
 *   child is recorded under, and the reserved `parent_run_id` column the
 *   rounds of one trampoline lineage are chained through. Upward: an aged
 *   terminal run with a live ancestor stays, because a parent reads a settled
 *   child's result out of its run row (`agent/await`) and a parent parked on
 *   an approval, a deferred, or a timer can be parked for longer than the
 *   threshold before it ever asks. Downward: an aged terminal run whose
 *   descendant is still live stays, because deleting it would leave that
 *   descendant's `parent_run_id` pointing at nothing and would drop the live
 *   descendant's lineage edges with the `flows_run_parents_gc` trigger.
 * - **Explicit.** Nothing schedules this. Automatic retention stays opt-in,
 *   for the reason `ArtifactGc` states: deletion is the irreversible
 *   direction, and a human approving a plan must be approving the deletions.
 *
 * Journal history is deleted outright rather than compacted to a checkpoint.
 * `Journal.checkpoint` and `Journal.compact` are owner-fenced — `SqlJournal`'s
 * `fenceGuard` requires a `flows_runs` row that is `running` under the exact
 * owner passed in — so neither can be called for a finished, ownerless run at
 * all. Deleting the run's entries and checkpoints is strictly stronger than
 * compacting them to a checkpoint, and it happens in the same transaction as
 * the run row, which is the property a compaction could not have given.
 *
 * The operation is idempotent and converges: a bounded pass deletes what it
 * can see, and the next pass continues from what is left.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Stable error codes returned by retention.
 *
 * @category models
 * @since 0.1.0
 */
export const RetentionErrorCode = Schema.Literals(["scan_failed", "delete_failed"])

/**
 * Stable error codes returned by retention.
 *
 * @category models
 * @since 0.1.0
 */
export type RetentionErrorCode = typeof RetentionErrorCode.Type

/**
 * A retention pass that could not complete.
 *
 * `scan_failed` means the candidate set could not be computed and nothing was
 * deleted. `delete_failed` means the candidate set held but a delete refused;
 * the transaction rolled back, so nothing was deleted then either, and
 * re-running converges once the cause is fixed.
 *
 * @category errors
 * @since 0.1.0
 */
export class RetentionError extends Schema.TaggedError<RetentionError>()(
  "@smthrs/engine-store/RetentionError",
  {
    code: RetentionErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Options for one retention pass.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainOptions {
  /**
   * How long a run must have been finished to be collected, in milliseconds.
   * A run's age is measured from `finished_at_ms`, or from `created_at_ms`
   * for a terminal row that never recorded one. Zero collects every terminal
   * run; a negative value is read as zero.
   */
  readonly olderThanMs: number
  /**
   * Largest number of runs one pass deletes. Defaults to
   * {@link defaultLimit}. Retention is idempotent, so a workspace with more
   * aged runs than the bound converges over repeated passes instead of
   * holding one long write transaction open. A negative value is read as
   * zero, so a pass under a mistyped bound deletes nothing.
   */
  readonly limit?: number | undefined
  /** Compute and report the pass without deleting anything. */
  readonly dryRun?: boolean | undefined
}

/**
 * What one retention pass did, or — under `dryRun` — would do.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetainReport {
  /** Runs finished at or before this instant were candidates. */
  readonly cutoffMs: number
  /** The runs deleted, oldest first. */
  readonly runIds: ReadonlyArray<string>
  /**
   * Aged terminal runs left in place because a descendant of theirs is not
   * terminal, or is terminal and is not being deleted by this pass. They
   * become collectable once that descendant is. At most `limit` of them are
   * reported, the oldest first, so the report costs no more than the pass.
   */
  readonly retainedForLiveDescendants: ReadonlyArray<string>
  /**
   * Aged terminal runs left in place because an ancestor of theirs is not
   * terminal. That ancestor can still read the run's settled result through
   * `agent/await`, which answers out of the run row. They become collectable
   * once every ancestor is terminal — a terminal ancestor holds nothing back,
   * whatever its own age. A run retained for both reasons is reported under
   * {@link retainedForLiveDescendants}, and at most `limit` runs are reported.
   */
  readonly retainedForLiveAncestors: ReadonlyArray<string>
  readonly runs: number
  readonly attempts: number
  readonly clockDeadlines: number
  readonly deferredCompletions: number
  readonly journalEntries: number
  readonly journalCheckpoints: number
  /** Time-travel archive rows; always zero where that table is not installed. */
  readonly archiveEntries: number
  readonly dryRun: boolean
}

/**
 * Explicit run retention.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Deletes every aged terminal run and its dependents in one transaction.
   * Explicit only — nothing in the engine composition ever calls this.
   */
  readonly retain: (
    options: RetainOptions
  ) => Effect.Effect<RetainReport, RetentionError | Journal.JournalError>
}

/**
 * Service tag for run retention.
 *
 * @category services
 * @since 0.1.0
 */
export class Retention extends Context.Service<Retention, Service>()("@smthrs/engine-store/Retention") {}

/**
 * Runs deleted by one pass when the caller names no bound. Large enough that
 * an ordinary workspace finishes in one pass, small enough that the write
 * transaction stays short on a workspace that has never been collected.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultLimit = 1000

/**
 * Run ids per `IN (...)` list. SQLite's default host-parameter ceiling is 999.
 *
 * @category constants
 * @since 0.1.0
 */
const chunkSize = 500

/** The statuses a run can never leave. */
const terminalStatuses = ["completed", "failed", "cancelled"]

/** `terminalStatuses` as a SQL list, for the lineage prelude below. */
const terminalList = terminalStatuses.map((status) => `'${status}'`).join(", ")

/**
 * The prelude every scan opens with: which runs a live run stands above, and
 * which it stands below.
 *
 * Two relations make one run the parent of another, and a walk over either one
 * alone misses half the lineage. A SPAWNED child records its parent as a
 * `flows_run_parents` edge, one row per parent so a diamond records both, and
 * leaves `parent_run_id` NULL: the engine reserves that column for the rounds
 * of one trampoline lineage (`RunDriver.continueLineage`). The edge is the
 * relation every `agent/await` depends on. `link` is both relations as one
 * edge list.
 *
 * `under_live` is every run reachable downward from a run that is not
 * terminal. Those runs have a live ancestor, which can still read a settled
 * result out of their run row. `over_live` is every run reachable upward from
 * one. Those runs have a live descendant, whose own lineage the
 * `flows_run_parents_gc` trigger would drop with them. An edge whose parent
 * row is gone is not reachable from `live` at all, so it holds nothing back,
 * and since only terminal runs are ever deleted it never can.
 *
 * The walks carry run ids and nothing else, so `UNION` makes them terminate on
 * their own: a corrupt edge that closed a cycle adds a row the set already
 * holds, and the walk stops. That matters because these reads run inside the
 * pass's write transaction. They are SQLite-specific, like the `sqlite_master`
 * probe below, and rc.0 is SQLite-only.
 *
 * `parentEdges: false` drops the `flows_run_parents` half of `link`. A
 * database that carries the run rows but not the engine's edge table — the
 * control plane's, which migrates the run store and the journal and nothing
 * else — has no edges to walk, and reading the missing table would fail the
 * whole scan. The `parent_run_id` half still runs, so the continuation
 * lineage is guarded there too. The retention pass itself always walks both.
 *
 * @category constructors
 * @since 0.1.0
 */
export const lineagePrelude = (
  options: { readonly parentEdges: boolean } = { parentEdges: true }
): string =>
  `
      WITH RECURSIVE
        link(child_id, parent_id) AS (
          ${
    options.parentEdges
      ? `SELECT child_id, parent_id FROM flows_run_parents
          UNION
          `
      : ``
  }SELECT run_id, parent_run_id FROM flows_runs WHERE parent_run_id IS NOT NULL
        ),
        live(run_id) AS (
          SELECT run_id FROM flows_runs WHERE status NOT IN (${terminalList})
        ),
        under_live(run_id) AS (
          SELECT link.child_id FROM link JOIN live ON live.run_id = link.parent_id
          UNION
          SELECT link.child_id FROM link JOIN under_live ON under_live.run_id = link.parent_id
        ),
        over_live(run_id) AS (
          SELECT link.parent_id FROM link JOIN live ON live.run_id = link.child_id
          UNION
          SELECT link.parent_id FROM link JOIN over_live ON over_live.run_id = link.child_id
        )
    `

/** Classifies a read of the scan phase, where nothing has been deleted yet. */
const scanning = (what: string) => (cause: unknown): RetentionError =>
  new RetentionError({ code: "scan_failed", message: `${what} could not be read`, cause })

/** Classifies a statement of the delete phase, which rolls the pass back. */
const deleting = (what: string) => (cause: unknown): RetentionError =>
  new RetentionError({ code: "delete_failed", message: `${what} could not be collected`, cause })

const chunksOf = (ids: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const chunks: Array<ReadonlyArray<string>> = []
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    chunks.push(ids.slice(offset, offset + chunkSize))
  }
  return chunks
}

interface Candidate {
  readonly runId: string
  readonly parentRunId: string | null
}

/** A run and the candidate it names as its parent. */
interface ChildEdge {
  readonly runId: string
  readonly parentRunId: string
}

/**
 * Builds the retention operation over the composition's own durable tables.
 *
 * The scan reads `flows_runs` directly, the way `DurableEngineState` and
 * `ArtifactGc` do: this package composes the run-store, journal, and engine
 * migrations, so the schema is its own.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (): Effect.Effect<Service, never, SqlClient.SqlClient | Journal.Journal> =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const journal = yield* Journal.Journal

    /**
     * Whether the time-travel archive exists here. Block 5000 is not part of
     * the engine ladder the CLI installs, so an ordinary engine database has
     * no archive table and retention has nothing to delete from it. The
     * catalog read is SQLite-specific, like the `flows_run_parents_gc` trigger
     * this package already ships; rc.0 is SQLite-only.
     */
    const archiveInstalled = sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flows_time_travel_archive'
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(scanning("the schema catalog"))
    )

    /**
     * Aged terminal runs no live run stands above or below, oldest first,
     * bounded by the pass's limit.
     *
     * The lineage filters run BEFORE the bound, and that is what makes a
     * bounded pass converge. A workspace whose oldest thousand aged runs all
     * hang under one parked parent would otherwise fill the window with runs
     * the pass then has to retain, and report nothing collected while younger
     * collectable runs sat behind them, pass after pass.
     */
    const candidatesOf = (cutoffMs: number, limit: number) =>
      sql<{ readonly run_id: string; readonly parent_run_id: string | null }>`
        ${sql.unsafe(lineagePrelude())}
        SELECT run_id, parent_run_id FROM flows_runs
        WHERE ${sql.in("status", terminalStatuses)}
          AND COALESCE(finished_at_ms, created_at_ms) <= ${cutoffMs}
          AND run_id NOT IN (SELECT run_id FROM under_live)
          AND run_id NOT IN (SELECT run_id FROM over_live)
        ORDER BY COALESCE(finished_at_ms, created_at_ms), run_id
        LIMIT ${limit}
      `.pipe(
        Effect.map((rows): ReadonlyArray<Candidate> =>
          rows.map((row) => ({ runId: row.run_id, parentRunId: row.parent_run_id }))
        ),
        Effect.mapError(scanning("the run table"))
      )

    /** Every run whose parent is a candidate, candidates included. */
    const childrenOf = (candidateIds: ReadonlyArray<string>) =>
      Effect.reduce(
        chunksOf(candidateIds),
        (): Array<ChildEdge> => [],
        (accumulated, chunk) =>
          // `parent_run_id` is the match predicate, so every row this returns
          // has one.
          sql<{ readonly run_id: string; readonly parent_run_id: string }>`
            SELECT run_id, parent_run_id FROM flows_runs WHERE ${sql.in("parent_run_id", chunk)}
          `.pipe(
            Effect.map((rows) => {
              for (const row of rows) {
                accumulated.push({ runId: row.run_id, parentRunId: row.parent_run_id })
              }
              return accumulated
            }),
            Effect.mapError(scanning("the run lineage"))
          )
      )

    /**
     * The aged terminal runs a live run holds back, and which side it stands
     * on: `liveDescendant` when the run is an ancestor of something not
     * terminal, otherwise it is a descendant of something not terminal.
     *
     * These runs are never candidates — `candidatesOf` excludes them — so this
     * read exists to say WHY a workspace with aged runs collected fewer than
     * it holds. It carries the pass's own bound so the report costs no more
     * than the pass does.
     */
    const retainedByLineage = (cutoffMs: number, limit: number) =>
      sql<{ readonly run_id: string; readonly live_descendant: number }>`
        ${sql.unsafe(lineagePrelude())}
        SELECT
          run_id,
          (run_id IN (SELECT run_id FROM over_live)) AS live_descendant
        FROM flows_runs
        WHERE ${sql.in("status", terminalStatuses)}
          AND COALESCE(finished_at_ms, created_at_ms) <= ${cutoffMs}
          AND (
            run_id IN (SELECT run_id FROM under_live)
            OR run_id IN (SELECT run_id FROM over_live)
          )
        ORDER BY COALESCE(finished_at_ms, created_at_ms), run_id
        LIMIT ${limit}
      `.pipe(Effect.mapError(scanning("the run lineage")))

    const countIn = (table: string, column: string, ids: ReadonlyArray<string>) =>
      Effect.reduce(chunksOf(ids), () => 0, (total, chunk) =>
        sql<{ readonly total: number }>`
          SELECT COUNT(*) AS total FROM ${sql.unsafe(table)} WHERE ${sql.in(column, chunk)}
        `.pipe(
          Effect.map((rows) => rows.reduce((sum, row) => sum + Number(row.total), total)),
          Effect.mapError(deleting(table))
        ))

    const deleteIn = (table: string, column: string, ids: ReadonlyArray<string>) =>
      Effect.forEach(
        chunksOf(ids),
        (chunk) =>
          sql`DELETE FROM ${sql.unsafe(table)} WHERE ${sql.in(column, chunk)}`.pipe(
            Effect.mapError(deleting(table))
          ),
        { discard: true }
      )

    /**
     * Drops from `doomed` every candidate that must outlive this pass, and
     * every ancestor of one.
     *
     * A candidate whose child is not being deleted has to stay: `flows_runs`
     * carries a self-referential foreign key on `parent_run_id`, so deleting
     * it would orphan a row that still exists. Retention is upward-closed for
     * the same reason — once a candidate is retained, the candidate it points
     * at is still referenced and is retained too.
     */
    const pinAncestors = (
      doomed: Set<string>,
      retained: Set<string>,
      parentOf: ReadonlyMap<string, string | null>,
      from: string
    ): void => {
      let current: string | undefined = from
      while (current !== undefined && doomed.has(current)) {
        doomed.delete(current)
        retained.add(current)
        current = parentOf.get(current) ?? undefined
      }
    }

    /**
     * Groups the doomed runs so that no group holds a run and one of its
     * doomed descendants. Deleting a parent while its child row still exists
     * violates the foreign key, and SQLite evaluates it per row rather than at
     * commit, so the delete runs deepest generation first.
     */
    const generations = (
      doomed: ReadonlySet<string>,
      parentOf: ReadonlyMap<string, string | null>
    ): ReadonlyArray<ReadonlyArray<string>> => {
      const depths = new Map<string, number>()
      const depthOf = (runId: string): number => {
        const known = depths.get(runId)
        if (known !== undefined) return known
        const parent = parentOf.get(runId) ?? undefined
        const depth = parent !== undefined && doomed.has(parent) ? depthOf(parent) + 1 : 0
        depths.set(runId, depth)
        return depth
      }
      const byDepth = new Map<number, Array<string>>()
      for (const runId of doomed) {
        const depth = depthOf(runId)
        const bucket = byDepth.get(depth)
        if (bucket === undefined) byDepth.set(depth, [runId])
        else bucket.push(runId)
      }
      return Array.from(byDepth.keys())
        .sort((left, right) => right - left)
        .map((depth) => byDepth.get(depth)!)
    }

    const pass = (options: RetainOptions, cutoffMs: number, hasArchive: boolean) =>
      Effect.gen(function*() {
        // Clamped, not interpolated: SQLite reads a negative `LIMIT` as no
        // limit at all, which would make a mistyped bound a full sweep.
        const limit = Math.max(0, options.limit ?? defaultLimit)
        const candidates = yield* candidatesOf(cutoffMs, limit)
        const candidateIds = candidates.map((candidate) => candidate.runId)
        const parentOf = new Map(candidates.map((candidate) => [candidate.runId, candidate.parentRunId]))
        const doomed = new Set(candidateIds)
        const retained = new Set<string>()
        const retainedAbove = new Set<string>()
        const candidateSet = new Set(candidateIds)
        // The foreign key, which the lineage filters do not cover: a child row
        // that is terminal and simply outside this pass — younger than the
        // cutoff, or past the bound — still points at its parent.
        for (const child of yield* childrenOf(candidateIds)) {
          if (candidateSet.has(child.runId)) continue
          pinAncestors(doomed, retained, parentOf, child.parentRunId)
        }
        // Why the workspace kept aged runs this pass. These never entered the
        // candidate set, so this only classifies them.
        for (const held of yield* retainedByLineage(cutoffMs, limit)) {
          if (Number(held.live_descendant) > 0) retained.add(held.run_id)
          else retainedAbove.add(held.run_id)
        }
        // `candidateIds` is already oldest first, so the report reads in the
        // order the pass collected.
        const runIds = candidateIds.filter((runId) => doomed.has(runId))

        const counts = yield* Effect.all({
          attempts: countIn("flows_attempts", "run_id", runIds),
          clockDeadlines: countIn("flows_clock_deadlines", "execution_id", runIds),
          deferredCompletions: countIn("flows_deferred_completions", "execution_id", runIds),
          journalEntries: countIn("flows_journal_events", "run_id", runIds),
          journalCheckpoints: countIn("flows_journal_checkpoints", "run_id", runIds),
          archiveEntries: hasArchive ? countIn("flows_time_travel_archive", "run_id", runIds) : Effect.succeed(0)
        })

        if (options.dryRun !== true) {
          yield* deleteIn("flows_deferred_completions", "execution_id", runIds)
          yield* deleteIn("flows_clock_deadlines", "execution_id", runIds)
          yield* deleteIn("flows_attempts", "run_id", runIds)
          yield* deleteIn("flows_journal_events", "run_id", runIds)
          yield* deleteIn("flows_journal_checkpoints", "run_id", runIds)
          if (hasArchive) yield* deleteIn("flows_time_travel_archive", "run_id", runIds)
          // Last, and deepest generation first. The `flows_run_parents_gc`
          // trigger drops each run's DAG edges as its row goes.
          for (const generation of generations(doomed, parentOf)) {
            yield* deleteIn("flows_runs", "run_id", generation)
          }
        }

        return {
          cutoffMs,
          runIds,
          retainedForLiveDescendants: Array.from(retained).sort(),
          retainedForLiveAncestors: Array.from(retainedAbove).sort(),
          runs: runIds.length,
          ...counts,
          dryRun: options.dryRun === true
        } satisfies RetainReport
      })

    const retain: Service["retain"] = Effect.fn("Retention.retain")((options: RetainOptions) =>
      Effect.gen(function*() {
        const nowMs = yield* Clock.currentTimeMillis
        const cutoffMs = nowMs - Math.max(0, options.olderThanMs)
        const hasArchive = yield* archiveInstalled
        // One commit: `transact` joins the run-row deletes, the dependent
        // deletes, and the journal truncation into a single write transaction,
        // so a crash can never leave a run without its history or history
        // without its run. A transaction that cannot commit fails as the
        // `JournalError` it is rather than being laundered into a retention
        // code that would claim to know why.
        return yield* journal.transact(pass(options, cutoffMs, hasArchive))
      })
    )

    return { retain }
  })

/**
 * Provides run retention. Nothing schedules `retain()`; invoking it stays an
 * explicit caller decision.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Retention, never, SqlClient.SqlClient | Journal.Journal> = Layer.effect(Retention)(
  make()
)
