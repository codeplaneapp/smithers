/**
 * Durable `ControlRuntime` over `@smthrs/journal`'s fenced `RunStore` and a
 * SQL database.
 *
 * `layerMemory` models the production seams but keeps everything in a `Map`, so
 * nothing it decides survives the process. This is the adapter the header of
 * `ControlRuntime` calls missing, specified by
 * `.smithers/tickets/control-runtime-engine-integration.md`.
 *
 * ## Where ownership lives
 *
 * The run lifecycle is not re-implemented here. `RunStore` already owns it, and
 * it is the piece that is hard to get right: every ownership move is a single
 * SQL compare-and-swap, so a stale writer loses the `UPDATE` rather than
 * racing a read-then-write. This module maps the control plane's vocabulary
 * onto it:
 *
 * | control status | `RunStore` status | ownership |
 * | --- | --- | --- |
 * | `accepted`, `running` | `running` | held by this process |
 * | `parked`, `waiting-approval` | `suspended` | released |
 * | `cancelled` / `completed` / `failed` | same | released, terminal |
 *
 * The authoritative `RunSummary` is written into the row's `state_json` by the
 * same fenced `UPDATE` that moves the status, so a projection can never be read
 * out of step with the lifecycle. `RunStore` has no list operation, so
 * `control_runs` is kept as a plain id index and each summary is read back
 * through the store rather than duplicated.
 *
 * ## Fences
 *
 * A fence is a serialized `OwnerId`. `hostId` and `pid` identify the process;
 * the `nonce` is regenerated on **every** claim, so a fence taken before a
 * park is not the fence held after the resume that follows it, and the stale
 * one is refused by the CAS. This is the `rangeID`-style monotonic fence from
 * `reference/temporal`'s history service, narrowed to a per-run token.
 *
 * ## Browser safety
 *
 * Nothing here imports `node:*`. Identity comes from `globalThis.crypto`, and
 * persistence is the driver-neutral SQL contract, so this module runs anywhere
 * `@smthrs/database` has a driver. Fibers are the exception and are
 * deliberately process-local: a fiber is a live continuation, not a row, and
 * cancellation is interruption of the fiber that this process owns.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter"
import type { Ownership } from "@smthrs/run-store"
import { RunStore } from "@smthrs/run-store"
import { Clock, Crypto, Effect, Fiber, Layer, Option } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Attribution from "./Cancellation.ts"
import type { ApprovalTarget, PlanInput } from "./Control.ts"
import {
  AlreadyResolved,
  ClaimLost,
  EnvelopeMismatch,
  FlowNotFound,
  InvalidInput,
  PersistenceError,
  PlanDigestMismatch,
  RunNotFound
} from "./ControlError.ts"
import type { ApprovalToken, BulkGrant, LaunchResult, MemoryFlow, Service, StoredPlan } from "./ControlRuntime.ts"
import { ControlRuntime, make } from "./ControlRuntime.ts"
import type {
  Cancellation,
  Envelope,
  FlowId,
  IdempotencyKey,
  PlanCard,
  Principal,
  Receipt,
  RunId,
  RunStatus,
  RunSummary,
  SignalPayload,
  SteerMessage
} from "./ControlSchema.ts"
import { accepted, alreadyApplied, canonical, emptyEnvelope, planCard, sameEnvelope } from "./internal/planning.ts"
import * as Lineage from "./Lineage.ts"
import { plannable } from "./SystemFlows.ts"

/**
 * A flow the durable runtime can plan.
 *
 * The same shape the memory runtime takes, so a composition can hand the same
 * catalog to either.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DurableFlow = MemoryFlow

/**
 * Durable runtime configuration.
 *
 * `owner` is the process identity every claim is stamped with. It defaults to
 * a fresh identity per constructed runtime, which is what a single-process CLI
 * wants; a supervisor that already has a host identity supplies its own.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  readonly flows?: ReadonlyArray<DurableFlow> | undefined
  readonly owner?: Ownership.OwnerId | undefined
  readonly principal?: Omit<Principal, "stampedAt"> | undefined
}

const persistence = (operation: string) => (cause: unknown): PersistenceError =>
  new PersistenceError({
    operation,
    message: `Control runtime failed to ${operation}`,
    cause
  })

/** A random identifier that does not depend on any Node API. */
const randomId = (): string => globalThis.crypto.randomUUID()

/**
 * Every message a failure and the failures it wraps carry.
 *
 * A SQL failure arrives wrapped: the client reports "Failed to prepare
 * statement" and keeps the driver's own sentence one or two levels down, under
 * `reason` and then `cause`. The depth bound keeps a self-referential chain
 * from looping.
 */
const causeMessages = (value: unknown, depth = 4): string => {
  if (depth === 0 || typeof value !== "object" || value === null) return typeof value === "string" ? value : ""
  const fields = value as { readonly message?: unknown; readonly cause?: unknown; readonly reason?: unknown }
  const own = typeof fields.message === "string" ? fields.message : ""
  return `${own} ${causeMessages(fields.reason, depth - 1)} ${causeMessages(fields.cause, depth - 1)}`
}

/**
 * Whether a query failure means one named table is not in this database.
 *
 * The SQL contract here is driver-neutral and carries no portable error code
 * for a missing relation, so this reads the sentence the driver produced. The
 * three phrasings are the ones SQLite, PostgreSQL, and MySQL use, and each is
 * matched together with the table name, so a DIFFERENT missing table — one
 * this deployment does need — is still reported as a failure.
 */
const missingTable = (table: string) => (cause: unknown): boolean => {
  const message = causeMessages(cause)
  return message.includes(table) && (
    message.includes("no such table") ||
    message.includes("does not exist") ||
    message.includes("doesn't exist")
  )
}

const terminal = (status: RunStatus): boolean => status === "cancelled" || status === "completed" || status === "failed"

/** The `RunStore` status the control plane's status projects onto. */
const storeStatus = (status: RunStatus): RunStore.RunStatus => {
  switch (status) {
    case "accepted":
    case "running":
      return "running"
    case "parked":
    case "waiting-approval":
      return "suspended"
    default:
      return status
  }
}

/**
 * Whether two identities are the same *process*.
 *
 * The nonce is deliberately excluded: it is the per-claim fence, so a process
 * that re-claims a run has a new nonce but is still the same owner.
 */
const sameProcess = (left: Ownership.OwnerId, right: Ownership.OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid

interface PlanRow {
  readonly planId: string
  readonly cardJson: string
  readonly decodedInputJson: string
  readonly decision: string
}

interface TokenRow {
  readonly tokenId: string
  readonly targetJson: string
  readonly resolved: number
}

const migrations = [
  `CREATE TABLE IF NOT EXISTS control_plans (
    plan_id TEXT PRIMARY KEY,
    card_json TEXT NOT NULL,
    decoded_input_json TEXT NOT NULL,
    decision TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_plan_keys (
    idempotency_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    plan_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_tokens (
    token_id TEXT PRIMARY KEY,
    target_json TEXT NOT NULL,
    resolved INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_grants (
    token_id TEXT PRIMARY KEY,
    envelope_json TEXT NOT NULL,
    scope TEXT NOT NULL,
    installed_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_mutations (
    mutation_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_runs (
    run_id TEXT PRIMARY KEY,
    created_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_run_resumes (
    run_id TEXT PRIMARY KEY,
    requested_seq INTEGER NOT NULL,
    requested_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_run_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS control_sequences (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  )`
] as const

/**
 * Creates every control-plane table.
 *
 * `RunStore`'s own migrations are the journal package's business and are
 * applied by its layer.
 *
 * @category migrations
 * @since 0.1.0
 * @slop
 */
export const migrate: Effect.Effect<void, PersistenceError, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  for (const statement of migrations) {
    yield* sql.unsafe(statement).pipe(Effect.mapError(persistence("migrate")))
  }
})

/**
 * Constructs a durable runtime over the ambient database and run store.
 *
 * Not exported under this name: `make` below is the single public constructor.
 * Exporting both put two names for one function on the package's public
 * surface, and only one of them was documented.
 */
const makeRuntime = (
  options: Options = {}
): Effect.Effect<
  Service,
  PersistenceError,
  Crypto.Crypto | DurableWriter | SqlClient.SqlClient | RunStore.RunStore
> =>
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto
    const writer = yield* DurableWriter
    const runStore = yield* RunStore.RunStore
    yield* migrate
    const sql = yield* Effect.service(SqlClient.SqlClient)

    const owner: Ownership.OwnerId = options.owner ?? {
      hostId: "local",
      pid: 0,
      nonce: randomId()
    }
    const configuredFlows = options.flows ?? plannable.map((entry): DurableFlow => ({
      flowId: entry.flowId,
      description: `Reserved ${entry.verb} system flow`,
      deployClass: entry.deployClass,
      envelope: emptyEnvelope
    }))
    const flows = new Map(configuredFlows.map((flow) => [flow.flowId, flow] as const))

    // Fibers are live continuations, not rows. A restarted process legitimately
    // has none, and interrupting a run it does not own is the other process's
    // job — so this map is process-local by design, not by omission.
    const fibers = new Map<RunId, Fiber.Fiber<unknown, unknown>>()

    const now = Clock.currentTimeMillis

    const query = <A>(operation: string) => (effect: Effect.Effect<ReadonlyArray<A>, unknown>) =>
      effect.pipe(Effect.mapError(persistence(operation)))

    /** Allocates the next value of a durable counter inside one transaction. */
    const nextSequence = (name: string): Effect.Effect<number, PersistenceError> =>
      writer.write(Effect.gen(function*() {
        yield* sql`INSERT INTO control_sequences (name, value) VALUES (${name}, 0) ON CONFLICT (name) DO NOTHING`
        const rows = yield* sql<{ readonly value: number }>`
          UPDATE control_sequences SET value = value + 1 WHERE name = ${name} RETURNING value
        `
        return Number(rows[0]?.value ?? 0)
      })).pipe(Effect.mapError(persistence("allocate a sequence")))

    const readPlan = (planId: string): Effect.Effect<Option.Option<PlanRow>, PersistenceError> =>
      sql<PlanRow>`
        SELECT plan_id AS "planId", card_json AS "cardJson",
               decoded_input_json AS "decodedInputJson", decision
        FROM control_plans WHERE plan_id = ${planId}
      `.pipe(query("read a plan"), Effect.map((rows) => Option.fromNullishOr(rows[0])))

    const storedPlan = (row: PlanRow): StoredPlan => ({
      card: JSON.parse(row.cardJson) as PlanCard,
      decodedInput: JSON.parse(row.decodedInputJson) as unknown,
      decision: row.decision as StoredPlan["decision"]
    })

    const requirePlan = (planId: string): Effect.Effect<PlanRow, RunNotFound | PersistenceError> =>
      Effect.flatMap(
        readPlan(planId),
        Option.match({
          onNone: () => Effect.fail(new RunNotFound({ runId: planId })),
          onSome: Effect.succeed
        })
      )

    /**
     * Reads a run row, translating a missing row into `RunNotFound` and every
     * other store failure into `PersistenceError` — never a defect.
     */
    const requireRow = (runId: RunId): Effect.Effect<RunStore.RunRow, RunNotFound | PersistenceError> =>
      runStore.get(runId).pipe(
        Effect.mapError((error) =>
          error.code === "not_found_row"
            ? new RunNotFound({ runId })
            : persistence("read a run")(error)
        )
      )

    /**
     * The control status a store status projects back onto.
     *
     * The forward map is lossy — `accepted` and `running` both store as
     * `running` — so a run this plane did not launch is reported under the
     * status the store can actually prove.
     */
    const controlStatus = (status: RunStore.RunStatus): RunStatus => {
      switch (status) {
        case "pending":
          return "accepted"
        case "running":
          return "running"
        case "suspended":
          return "parked"
        default:
          return status
      }
    }

    /**
     * The control summary a run row carries, when it carries one.
     *
     * A run this plane launched has its `RunSummary` written into `state_json`
     * by the same fenced `UPDATE` that moves its status. A run the engine
     * created has the engine's state there instead, and this returns
     * `undefined` for it rather than pretending the shape matched.
     */
    const storedSummary = (stateJson: string): RunSummary | undefined => {
      const parsed = JSON.parse(stateJson) as unknown
      if (typeof parsed !== "object" || parsed === null) return undefined
      const candidate = parsed as Partial<RunSummary>
      return typeof candidate.runId === "string" && typeof candidate.flowId === "string" &&
          typeof candidate.status === "string"
        ? candidate as RunSummary
        : undefined
    }

    /** The flow name the engine records in its own run state. */
    const engineFlowName = (stateJson: string): string => {
      const parsed = JSON.parse(stateJson) as unknown
      const name = typeof parsed === "object" && parsed !== null
        ? (parsed as { readonly flowName?: unknown }).flowName
        : undefined
      return typeof name === "string" && name.length > 0 ? name : "unknown"
    }

    const optional = <A>(value: A | null | undefined): { readonly value?: A } =>
      value === null || value === undefined ? {} : { value }

    /**
     * How much of the database one projection needs to read.
     *
     * `undefined` is every row, which is what a LISTING needs: it projects
     * every row at once, and a per-row query would make one listing N round
     * trips. A single run needs the run and its ancestor chain and nothing
     * else — cascade attribution walks ancestors and stops — so a mutation on
     * one run does not pay for the size of the whole database.
     */
    type IndexScope = ReadonlyArray<string> | undefined

    /** `WHERE` material narrowing a column to a scope, or nothing at all. */
    const within = (column: string, scope: IndexScope) =>
      scope === undefined ? sql.literal("1 = 1") : sql.in(column, scope as Array<string>)

    /**
     * The two facts a run row cannot tell about itself.
     */
    interface AncestryIndex {
      /** Run ids a `fork-created` marker names. */
      readonly forked: ReadonlySet<string>
      /** The run that spawned each child, by child id. */
      readonly spawnedBy: ReadonlyMap<string, string>
      /** What each parked run is waiting for, by run id. */
      readonly waitingFor: ReadonlyMap<string, string>
      /** Who cancelled each cancelled run, by run id. */
      readonly cancellations: ReadonlyMap<string, Cancellation>
      /** The outstanding resume delegation of each run that has one. */
      readonly pendingResumes: ReadonlyMap<string, number>
    }

    /**
     * Projects a run row onto a control summary, ancestry included.
     *
     * Ancestry reaches the row from two different places, because the engine
     * records two different relationships. `parent_run_id` is the trampoline
     * chain — the round before this one — and it is the only ancestry a run
     * row carries. A run another run SPAWNED records nothing in its own row:
     * the edge lives in `flows_run_parents`, which is the subflow DAG cycle
     * detection walks (`packages/run-store/src/migrations/0002_lineage.ts`).
     * A projection that read the column alone would report every child of
     * every run as an orphan.
     *
     * The column wins when both exist, which is the case for round 1 of a run
     * that was itself spawned: the round's nearest ancestor is the round
     * before it, not the run that spawned round 0.
     *
     * @param row the run row
     * @param ancestry the fork markers and spawn edges of the whole database
     */
    const summaryFrom = (row: RunStore.RunRow, ancestry: AncestryIndex): RunSummary => {
      const stored = storedSummary(row.stateJson)
      const base: RunSummary = stored ?? {
        runId: row.runId,
        flowId: engineFlowName(row.stateJson),
        status: controlStatus(row.status),
        createdAt: row.createdAtMs,
        updatedAt: row.finishedAtMs ?? row.startedAtMs ?? row.createdAtMs
      }
      const parentRunId = optional(row.parentRunId).value ?? ancestry.spawnedBy.get(row.runId)
      const lineageId = optional(row.lineageId).value
      const roundOrdinal = optional(row.roundOrdinal).value
      const origin = Lineage.originOf({
        ...(parentRunId === undefined ? {} : { parentRunId }),
        ...(roundOrdinal === undefined ? {} : { roundOrdinal }),
        forked: ancestry.forked.has(row.runId)
      })
      const waitingReason = ancestry.waitingFor.get(row.runId)
      const cancellation = ancestry.cancellations.get(row.runId)
      const pendingResume = ancestry.pendingResumes.get(row.runId)
      return {
        ...base,
        ...(pendingResume === undefined ? {} : { pendingResume }),
        ...(parentRunId === undefined ? {} : { parentRunId }),
        ...(lineageId === undefined ? {} : { lineageId }),
        ...(roundOrdinal === undefined ? {} : { roundOrdinal }),
        ...(origin === undefined ? {} : { origin }),
        ...(waitingReason === undefined ? {} : { waitingReason }),
        ...(cancellation === undefined ? {} : { cancellation })
      }
    }

    /**
     * The runs a `fork-created` marker names.
     *
     * Time travel writes the marker on the forked child's own journal, which
     * is the only evidence separating a fork from an ordinary child: both
     * record `parent_run_id`. A composition whose journal is not this database
     * has no journal table here at all, and the honest answer there is "no
     * fork evidence" — not a failed projection — so exactly that one failure
     * is folded into the empty set.
     *
     * Every other failure is reported. A locked database, a corrupt page, or
     * a table that exists but no longer answers this question would otherwise
     * report every fork in the deployment as an ordinary child, silently and
     * for as long as the condition lasted.
     */
    const forkedRunIds = (scope: IndexScope): Effect.Effect<ReadonlySet<string>, PersistenceError> =>
      sql<{ readonly runId: string }>`
      SELECT DISTINCT run_id AS "runId" FROM flows_journal_events
      WHERE event_type = ${Lineage.forkCreatedEventType} AND ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.runId)) as ReadonlySet<string>),
        Effect.catchIf(
          missingTable("flows_journal_events"),
          () => Effect.succeed(new Set<string>() as ReadonlySet<string>)
        ),
        Effect.mapError(persistence("read fork markers"))
      )

    /**
     * The run that spawned each child, by child id.
     *
     * `seq` is the engine's store-global insertion order, so the FIRST edge is
     * the creating parent. A diamond's later parents are edges too, and a
     * summary names one ancestor, so the creating one is the one it names.
     *
     * Missing table, missing evidence, exactly as with the fork markers: a
     * control plane over a database with no engine state in it observes runs
     * that spawned nothing.
     */
    const spawnedBy = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, string>, PersistenceError> =>
      sql<{
        readonly childId: string
        readonly parentId: string
      }>`
      SELECT child_id AS "childId", parent_id AS "parentId"
      FROM flows_run_parents WHERE ${within("child_id", scope)} ORDER BY seq DESC
    `.pipe(
        // Descending, so the lowest `seq` is written last and wins the key.
        Effect.map((rows) => new Map(rows.map((row) => [row.childId, row.parentId])) as ReadonlyMap<string, string>),
        Effect.catchIf(
          missingTable("flows_run_parents"),
          () => Effect.succeed(new Map<string, string>() as ReadonlyMap<string, string>)
        ),
        Effect.mapError(persistence("read spawn edges"))
      )

    /**
     * What each parked run is waiting for, by run id.
     *
     * The engine writes `waiting_reason` on the run row when it parks a run
     * (`packages/engine-store/src/DurableEngineState.ts` `park`), and clears
     * it on the wake. The control plane reads it and never writes it: a park
     * belongs to whoever is holding the run, and the projection reports the
     * hold rather than deciding it.
     *
     * The reason separates the parks a steer can end from the parks it
     * cannot, so `Control.steer` needs it on the summary and not only in the
     * engine's own store.
     */
    const waitingFor = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, string>, PersistenceError> =>
      sql<{
        readonly runId: string
        readonly waitingReason: string
      }>`
      SELECT run_id AS "runId", waiting_reason AS "waitingReason"
      FROM flows_runs WHERE waiting_reason IS NOT NULL AND ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.runId, row.waitingReason])) as ReadonlyMap<string, string>),
        Effect.mapError(persistence("read waiting reasons"))
      )

    /**
     * The attributed cancel requests this plane journaled, by run id.
     *
     * The FIRST entry for a run wins. A cancel is idempotent, so a repeat asks
     * for something that already happened; the request that caused the
     * cancellation is the one that gets to name the principal and the reason.
     */
    const cancelRequests = (
      scope: IndexScope
    ): Effect.Effect<ReadonlyMap<string, Attribution.Request>, PersistenceError> =>
      sql<{
        readonly runId: string
        readonly emittedAtMs: number
        readonly payloadJson: string
      }>`
      SELECT run_id AS "runId", emitted_at_ms AS "emittedAtMs", payload_json AS "payloadJson"
      FROM flows_journal_events
      WHERE event_type = ${Attribution.requestedEventType} AND ${within("run_id", scope)}
      ORDER BY run_id, seq
    `.pipe(
        Effect.map((rows) => {
          const requests = new Map<string, Attribution.Request>()
          for (const row of rows) {
            if (requests.has(row.runId)) continue
            const payload = JSON.parse(row.payloadJson) as {
              readonly principal?: Principal
              readonly reason?: string
            }
            requests.set(row.runId, {
              requestedAt: Number(row.emittedAtMs),
              ...(payload.principal === undefined ? {} : { principal: payload.principal }),
              ...(payload.reason === undefined ? {} : { reason: payload.reason })
            })
          }
          return requests
        }),
        Effect.catchIf(
          missingTable("flows_journal_events"),
          () => Effect.succeed(new Map<string, Attribution.Request>() as ReadonlyMap<string, Attribution.Request>)
        ),
        Effect.mapError(persistence("read cancel requests"))
      )

    /**
     * When the engine journaled each run's interruption.
     *
     * The engine writes this record in the same transaction as the `cancelled`
     * transition (`packages/engine-store/src/internal/RunDriver.ts`), so it is
     * the moment a cancellation actually took, as opposed to the moment
     * somebody asked. A run cancelled by a peer process that never wrote a
     * request column still has this.
     */
    const engineInterruptions = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, number>, PersistenceError> =>
      sql<{
        readonly runId: string
        readonly payloadJson: string
      }>`
      SELECT run_id AS "runId", payload_json AS "payloadJson"
      FROM flows_journal_events
      WHERE event_type = ${Attribution.interruptedEventType} AND ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) => {
          const cancelled = new Map<string, number>()
          for (const row of rows) {
            const payload = JSON.parse(row.payloadJson) as {
              readonly outcome?: string
              readonly interruptedAtMs?: number
            }
            if (payload.outcome !== "cancelled") continue
            cancelled.set(row.runId, Number(payload.interruptedAtMs ?? 0))
          }
          return cancelled
        }),
        Effect.catchIf(
          missingTable("flows_journal_events"),
          () => Effect.succeed(new Map<string, number>() as ReadonlyMap<string, number>)
        ),
        Effect.mapError(persistence("read engine interruptions"))
      )

    /**
     * The ancestry and cancel columns of every run row.
     *
     * Cascade is a fact about a run's ancestors, so the attribution cannot be
     * decided a row at a time: the request that cancelled a child may be three
     * rounds up the chain.
     */
    const cancelEvidence = (scope: IndexScope): Effect.Effect<
      ReadonlyArray<{
        readonly runId: string
        readonly parentRunId: string | null
        readonly cancelRequestedAtMs: number | null
      }>,
      PersistenceError
    > =>
      sql<{
        readonly runId: string
        readonly parentRunId: string | null
        readonly cancelRequestedAtMs: number | null
      }>`
      SELECT run_id AS "runId", parent_run_id AS "parentRunId",
             cancel_requested_at_ms AS "cancelRequestedAtMs"
      FROM flows_runs WHERE ${within("run_id", scope)}
    `.pipe(Effect.mapError(persistence("read cancel evidence")))

    /** Every cancelled run's attribution in the scope, folded in one pass. */
    const cancellations = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, Cancellation>, PersistenceError> =>
      Effect.map(
        Effect.all({
          rows: cancelEvidence(scope),
          requests: cancelRequests(scope),
          interrupted: engineInterruptions(scope),
          spawnedBy: spawnedBy(scope)
        }),
        ({ interrupted, requests, rows, spawnedBy }) =>
          Attribution.attribute({
            runs: rows.map((row) => {
              const parentRunId = row.parentRunId ?? spawnedBy.get(row.runId)
              const cancelledAt = interrupted.get(row.runId)
              return {
                runId: row.runId,
                ...(parentRunId === undefined || parentRunId === null ? {} : { parentRunId }),
                ...(row.cancelRequestedAtMs === null ? {} : { cancelRequestedAt: Number(row.cancelRequestedAtMs) }),
                ...(cancelledAt === undefined ? {} : { cancelledAt })
              }
            }),
            requests
          })
      )

    /**
     * The outstanding resume delegation of each run in the scope.
     *
     * Read from `control_run_resumes` rather than from the journal because the
     * question is "what has not been taken up yet", which a log of what was
     * asked cannot answer without a per-run cursor.
     */
    const pendingResumeIndex = (scope: IndexScope): Effect.Effect<ReadonlyMap<string, number>, PersistenceError> =>
      sql<{ readonly runId: string; readonly requestedSeq: number }>`
      SELECT run_id AS "runId", requested_seq AS "requestedSeq"
      FROM control_run_resumes WHERE ${within("run_id", scope)}
    `.pipe(
        Effect.map((rows) =>
          new Map(rows.map((row) => [row.runId, Number(row.requestedSeq)] as const)) as ReadonlyMap<string, number>
        ),
        Effect.mapError(persistence("read pending resumes"))
      )

    /** Every index a projection needs over one scope, read together. */
    const ancestryIndex = (scope: IndexScope): Effect.Effect<AncestryIndex, PersistenceError> =>
      Effect.map(
        Effect.all({
          forked: forkedRunIds(scope),
          spawnedBy: spawnedBy(scope),
          waitingFor: waitingFor(scope),
          cancellations: cancellations(scope),
          pendingResumes: pendingResumeIndex(scope)
        }),
        (index): AncestryIndex => index
      )

    /**
     * One run and every ancestor above it, nearest first.
     *
     * The trampoline chain is one recursive read over `parent_run_id`. A
     * SPAWNED run records nothing in its own row, so when a chain runs out the
     * spawn edge is looked up and the walk continues from there — one extra
     * read per nesting level, and subflow nesting is shallow where a
     * trampoline is long. The visited set makes corrupt ancestry terminate
     * instead of taking the control plane down with it.
     */
    const ancestorChain = (runId: RunId): Effect.Effect<ReadonlyArray<string>, PersistenceError> =>
      Effect.gen(function*() {
        const chain: Array<string> = []
        const visited = new Set<string>()
        let start: string | undefined = runId
        while (start !== undefined && !visited.has(start)) {
          const rows = yield* sql<{ readonly runId: string; readonly parentRunId: string | null }>`
            WITH RECURSIVE ancestry(run_id, parent_run_id) AS (
              SELECT run_id, parent_run_id FROM flows_runs WHERE run_id = ${start}
              UNION
              SELECT runs.run_id, runs.parent_run_id
              FROM flows_runs runs JOIN ancestry ON runs.run_id = ancestry.parent_run_id
            )
            SELECT run_id AS "runId", parent_run_id AS "parentRunId" FROM ancestry
          `.pipe(Effect.mapError(persistence("walk a run's ancestry")))
          if (rows.length === 0) {
            // No row at all: the caller's own `requireRow` reports that.
            if (!visited.has(start)) chain.push(start)
            break
          }
          let last: string | undefined
          for (const row of rows) {
            if (visited.has(row.runId)) continue
            visited.add(row.runId)
            chain.push(row.runId)
            if (row.parentRunId === null) last = row.runId
          }
          // The chain ended at a row naming no parent. A run somebody SPAWNED
          // records its parent in the edge table instead, so the walk
          // continues from there.
          const spawn = last === undefined ? undefined : (yield* spawnedBy([last])).get(last)
          start = spawn
        }
        return chain
      })

    const summaryOf = (row: RunStore.RunRow): RunSummary => JSON.parse(row.stateJson) as RunSummary

    const snapshotOf = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
      status: row.status,
      owner: row.owner,
      heartbeatAtMs: row.heartbeatAtMs
    })

    // A type predicate, not a plain boolean: a row this process owns has a
    // non-null owner by construction, and the callers hand `row.owner` straight
    // to the fenced transitions.
    const ownedByUs = (
      row: RunStore.RunRow
    ): row is RunStore.RunRow & { readonly owner: Ownership.OwnerId } =>
      row.status === "running" && row.owner !== null && sameProcess(row.owner, owner)

    /**
     * Moves a run this process owns to a new control status, writing the
     * projection in the same compare-and-swap. A lost fence is `ClaimLost`.
     */
    const transition = (
      runId: RunId,
      claim: Ownership.OwnerId,
      summary: RunSummary,
      status: RunStatus
    ): Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError> =>
      Effect.gen(function*() {
        const timestamp = yield* now
        const next: RunSummary = {
          ...summary,
          status,
          updatedAt: timestamp,
          ...(storeStatus(status) === "running" ? {} : { ownerId: undefined }),
          // A park releases the owner columns, so the row itself stops saying
          // which process is hosting the execution. The fence it was parked
          // under is kept instead: it is what lets the host recognize its own
          // park, and every other process tell that the execution belongs to
          // one it cannot see (triage B-15). Any other status ends the park,
          // so it ends the record with it.
          parkedBy: storeStatus(status) === "suspended" ? JSON.stringify(claim) : undefined
        }
        const outcome = yield* runStore.transitionOwned(
          runId,
          claim,
          storeStatus(status),
          JSON.stringify(next)
        ).pipe(Effect.mapError(persistence("transition a run")))
        if (outcome._tag === "NotFound") return yield* Effect.fail(new RunNotFound({ runId }))
        if (outcome._tag !== "Transitioned") return yield* Effect.fail(new ClaimLost({ runId }))
        return next
      })

    /** Takes ownership of a suspended or pending run under a fresh nonce. */
    const claim = (
      runId: RunId,
      row: RunStore.RunRow
    ): Effect.Effect<RunSummary, RunNotFound | ClaimLost | PersistenceError> =>
      Effect.gen(function*() {
        const timestamp = yield* now
        const claimant: Ownership.OwnerId = { ...owner, nonce: randomId() }
        const outcome = yield* runStore.claimAndOwn(runId, snapshotOf(row), claimant, timestamp).pipe(
          Effect.mapError(persistence("claim a run"))
        )
        if (outcome._tag === "NotFound") return yield* Effect.fail(new RunNotFound({ runId }))
        if (outcome._tag !== "Activated") return yield* Effect.fail(new ClaimLost({ runId }))
        return yield* transition(runId, claimant, {
          ...summaryOf(row),
          ownerId: JSON.stringify(claimant)
        }, "accepted")
      })

    /**
     * Every durable run, this plane's own first.
     *
     * `control_runs` indexes only the runs this plane launched. A control
     * plane that listed nothing else could not answer "what did that run
     * spawn?", because a child, a fork, and a later trampoline round are all
     * created by the engine straight into `flows_runs`. The left join keeps
     * launch order for the runs that have one and falls back to creation order
     * for the rest.
     */
    const listRunIds: Effect.Effect<ReadonlyArray<string>, PersistenceError> = sql<{ readonly runId: string }>`
      SELECT runs.run_id AS "runId"
      FROM flows_runs AS runs
      LEFT JOIN control_runs AS indexed ON indexed.run_id = runs.run_id
      ORDER BY CASE WHEN indexed.created_seq IS NULL THEN 1 ELSE 0 END,
               indexed.created_seq, runs.created_at_ms, runs.run_id
    `.pipe(query("list runs"), Effect.map((rows) => rows.map((row) => row.runId)))

    const listPlanIds: Effect.Effect<ReadonlyArray<string>, PersistenceError> = sql<{ readonly planId: string }>`
      SELECT plan_id AS "planId" FROM control_plans ORDER BY rowid
    `.pipe(query("list plans"), Effect.map((rows) => rows.map((row) => row.planId)))

    const messages = (
      runId: RunId,
      kind: "steer" | "signal"
    ): Effect.Effect<ReadonlyArray<unknown>, PersistenceError> =>
      sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson" FROM control_run_messages
        WHERE run_id = ${runId} AND kind = ${kind} ORDER BY seq
      `.pipe(query("read run messages"), Effect.map((rows) => rows.map((row) => JSON.parse(row.payloadJson))))

    const appendMessage = (
      runId: RunId,
      kind: "steer" | "signal",
      payload: unknown
    ): Effect.Effect<void, RunNotFound | PersistenceError> =>
      Effect.gen(function*() {
        yield* requireRow(runId)
        yield* sql`
          INSERT INTO control_run_messages (run_id, kind, payload_json)
          VALUES (${runId}, ${kind}, ${JSON.stringify(payload)})
        `.pipe(Effect.mapError(persistence("append a run message")))
      })

    const service = make({
      plan: Effect.fn("SqlControlRuntime.plan")(function*(input: PlanInput) {
        const flow = flows.get(input.flowId)
        if (flow === undefined) return yield* new FlowNotFound({ flowId: input.flowId })
        const planFingerprint = yield* Effect.try({
          try: () => canonical({ flowId: input.flowId, input: input.input }),
          catch: (cause) => new InvalidInput({ issue: String(cause) })
        })
        if (input.idempotencyKey !== undefined) {
          const prior = yield* sql<{ readonly fingerprint: string; readonly planId: string }>`
            SELECT fingerprint, plan_id AS "planId" FROM control_plan_keys
            WHERE idempotency_key = ${input.idempotencyKey}
          `.pipe(query("read a plan key"))
          const found = prior[0]
          if (found !== undefined) {
            if (found.fingerprint !== planFingerprint) {
              return yield* new InvalidInput({
                issue: `idempotency key ${input.idempotencyKey} was used for another plan`
              })
            }
            const stored = yield* readPlan(found.planId)
            if (Option.isSome(stored)) return { card: storedPlan(stored.value).card, created: false }
          }
        }
        const decoded = yield* (flow.decode?.(input.input) ?? Effect.try({
          try: () => {
            canonical(input.input)
            return input.input
          },
          catch: (cause) => new InvalidInput({ issue: String(cause) })
        }))
        const planId = `plan-${yield* nextSequence("plan")}`
        const handoff = flow.plan === undefined ? undefined : yield* flow.plan(decoded, planId)
        const card = yield* planCard({
          planId,
          flowId: input.flowId,
          decodedInput: decoded,
          envelope: flow.envelope,
          deployClass: flow.deployClass,
          handoff,
          idempotencyKey: input.idempotencyKey
        }).pipe(Effect.provideService(Crypto.Crypto, crypto))
        yield* writer.write(Effect.gen(function*() {
          yield* sql`
            INSERT INTO control_plans (plan_id, card_json, decoded_input_json, decision)
            VALUES (${planId}, ${JSON.stringify(card)}, ${JSON.stringify(decoded ?? null)}, 'pending')
          `
          yield* sql`
            INSERT INTO control_tokens (token_id, target_json, resolved)
            VALUES (${planId}, ${JSON.stringify(card.approval.target)}, 0)
          `
          if (input.idempotencyKey !== undefined) {
            yield* sql`
              INSERT INTO control_plan_keys (idempotency_key, fingerprint, plan_id)
              VALUES (${input.idempotencyKey}, ${planFingerprint}, ${planId})
            `
          }
        })).pipe(Effect.mapError(persistence("store a plan")))
        return { card, created: true }
      }),
      getPlan: Effect.fn("SqlControlRuntime.getPlan")((planId: string) => Effect.map(requirePlan(planId), storedPlan)),
      listPlanIds,
      lookupApproval: Effect.fn("SqlControlRuntime.lookupApproval")(function*(target: ApprovalTarget) {
        const tokenId = target._tag === "Plan" ? target.planId : target.requestId
        const rows = yield* sql<TokenRow>`
          SELECT token_id AS "tokenId", target_json AS "targetJson", resolved
          FROM control_tokens WHERE token_id = ${tokenId}
        `.pipe(query("read an approval token"))
        const row = rows[0]
        if (row === undefined) {
          return yield* new RunNotFound({ runId: target._tag === "Node" ? target.runId : target.planId })
        }
        const stored = JSON.parse(row.targetJson) as ApprovalTarget
        if (stored.digest !== target.digest) {
          return yield* new PlanDigestMismatch({
            planId: tokenId,
            expected: stored.digest,
            actual: target.digest
          })
        }
        if (!sameEnvelope(stored.envelope, target.envelope)) {
          return yield* new EnvelopeMismatch({
            planId: tokenId,
            expected: canonical(stored.envelope),
            actual: canonical(target.envelope)
          })
        }
        if (row.resolved !== 0) return yield* new AlreadyResolved({ requestId: tokenId })
        return { tokenId, target: stored, resolved: false }
      }),
      registerApproval: Effect.fn("SqlControlRuntime.registerApproval")(function*(
        target: Extract<ApprovalTarget, { readonly _tag: "Node" }>
      ) {
        yield* requireRow(target.runId)
        yield* sql`
          INSERT INTO control_tokens (token_id, target_json, resolved)
          VALUES (${target.requestId}, ${JSON.stringify(target)}, 0)
          ON CONFLICT (token_id) DO NOTHING
        `.pipe(Effect.mapError(persistence("register an approval token")))
        const rows = yield* sql<TokenRow>`
          SELECT token_id AS "tokenId", target_json AS "targetJson", resolved
          FROM control_tokens WHERE token_id = ${target.requestId}
        `.pipe(query("read an approval token"))
        const row = rows[0]
        if (row === undefined) {
          return yield* Effect.fail(
            new PersistenceError({
              operation: "register an approval token",
              message: "A registered approval token could not be read back"
            })
          )
        }
        const stored = JSON.parse(row.targetJson) as ApprovalTarget
        if (stored.digest !== target.digest) {
          return yield* new PlanDigestMismatch({
            planId: target.requestId,
            expected: stored.digest,
            actual: target.digest
          })
        }
        if (!sameEnvelope(stored.envelope, target.envelope)) {
          return yield* new EnvelopeMismatch({
            planId: target.requestId,
            expected: canonical(stored.envelope),
            actual: canonical(target.envelope)
          })
        }
        return { tokenId: row.tokenId, target: stored, resolved: row.resolved !== 0 }
      }),
      installBulkGrant: Effect.fn("SqlControlRuntime.installBulkGrant")(function*(
        token: ApprovalToken,
        envelope: Envelope,
        scope
      ) {
        const timestamp = yield* now
        // The envelope is installed whole. Splitting it into capabilities here
        // would let a partial grant exist, which is exactly what the bulk-grant
        // rule forbids.
        yield* sql`
          INSERT INTO control_grants (token_id, envelope_json, scope, installed_at_ms)
          VALUES (${token.tokenId}, ${JSON.stringify(envelope)}, ${scope}, ${timestamp})
          ON CONFLICT (token_id) DO NOTHING
        `.pipe(Effect.mapError(persistence("install a grant")))
      }),
      resolveApproval: Effect.fn("SqlControlRuntime.resolveApproval")(function*(
        token: ApprovalToken,
        decision: "approved" | "denied"
      ) {
        // Exactly once: the guard is in the UPDATE, so two concurrent decisions
        // cannot both observe an unresolved token.
        const resolved = yield* writer.write(Effect.gen(function*() {
          const rows = yield* sql<{ readonly tokenId: string }>`
            UPDATE control_tokens SET resolved = 1
            WHERE token_id = ${token.tokenId} AND resolved = 0
            RETURNING token_id AS "tokenId"
          `
          if (rows.length === 0) return false
          yield* sql`UPDATE control_plans SET decision = ${decision} WHERE plan_id = ${token.tokenId}`
          return true
        })).pipe(Effect.mapError(persistence("resolve an approval")))
        if (!resolved) return yield* new AlreadyResolved({ requestId: token.tokenId })
      }),
      launch: Effect.fn("SqlControlRuntime.launch")(function*(
        planId: string,
        requestedDigest: string,
        envelope: Envelope
      ) {
        const row = yield* requirePlan(planId)
        const plan = storedPlan(row)
        if (plan.card.digest !== requestedDigest) {
          return yield* new PlanDigestMismatch({
            planId,
            expected: plan.card.digest,
            actual: requestedDigest
          })
        }
        if (!sameEnvelope(plan.card.envelope, envelope)) {
          return yield* new EnvelopeMismatch({
            planId,
            expected: canonical(plan.card.envelope),
            actual: canonical(envelope)
          })
        }
        if (plan.decision === "pending") {
          const parked: LaunchResult = {
            _tag: "Parked",
            receipt: {
              _tag: "Parked",
              receiptId: `launch:${planId}`,
              planId,
              status: "waiting-approval"
            }
          }
          return parked
        }
        if (plan.decision !== "approved") return yield* new ClaimLost({ runId: planId })

        const sequence = yield* nextSequence("run")
        const runId = `run-${sequence}`
        const timestamp = yield* now
        const claimant: Ownership.OwnerId = { ...owner, nonce: randomId() }
        const summary: RunSummary = {
          runId,
          flowId: plan.card.flowId,
          status: "accepted",
          planId,
          planDigest: plan.card.digest,
          ownerId: JSON.stringify(claimant),
          createdAt: timestamp,
          updatedAt: timestamp
        }
        yield* runStore.create(runId, JSON.stringify(summary)).pipe(
          Effect.mapError(persistence("create a run"))
        )
        yield* sql`INSERT INTO control_runs (run_id, created_seq) VALUES (${runId}, ${sequence})`.pipe(
          Effect.mapError(persistence("index a run"))
        )
        const outcome = yield* runStore.claimAndOwn(
          runId,
          { status: "pending", owner: null, heartbeatAtMs: null },
          claimant,
          timestamp
        ).pipe(Effect.mapError(persistence("claim a new run")))
        if (outcome._tag !== "Activated") return yield* new ClaimLost({ runId })
        const started: LaunchResult = {
          _tag: "Started",
          receipt: accepted(`launch:${planId}:${runId}`, runId),
          run: summary
        }
        return started
      }),
      getRun: Effect.fn("SqlControlRuntime.getRun")((runId: RunId) =>
        Effect.gen(function*() {
          const row = yield* requireRow(runId)
          return summaryFrom(row, yield* ancestryIndex(yield* ancestorChain(runId)))
        })
      ),
      listRuns: Effect.fn("SqlControlRuntime.listRuns")(() =>
        Effect.gen(function*() {
          const ancestry = yield* ancestryIndex(undefined)
          const runIds = yield* listRunIds
          // The id index and the rows are two statements, so retention or
          // `smithers gc` can delete a row between them. A vanished row is one
          // row missing from the answer, not a failed listing: catching
          // `RunNotFound` around the whole `forEach` collapsed the ENTIRE
          // listing to `[]`, so `smithers ps` on a busy project intermittently
          // reported no runs at all.
          const summaries = yield* Effect.forEach(runIds, (runId) =>
            requireRow(runId).pipe(
              Effect.map((row) => Option.some(summaryFrom(row, ancestry))),
              Effect.catchTag("/control/RunNotFound", () => Effect.succeed(Option.none<RunSummary>()))
            ))
          return summaries.filter(Option.isSome).map((summary) => summary.value)
        })
      )(),
      listFlows: Effect.fn("SqlControlRuntime.listFlows")(() =>
        Effect.succeed(
          Array.from(flows.values(), (flow) => ({
            flowId: flow.flowId,
            description: flow.description
          }))
        )
      )(),
      enqueueSteer: Effect.fn("SqlControlRuntime.enqueueSteer")((runId: RunId, message: SteerMessage) =>
        appendMessage(runId, "steer", message)
      ),
      drainSteering: Effect.fn("SqlControlRuntime.drainSteering")(function*(runId: RunId) {
        yield* requireRow(runId)
        // Read and delete in one transaction: two turn boundaries draining at
        // once must not both see the same message.
        const drained = yield* writer.write(Effect.gen(function*() {
          const rows = yield* sql<{ readonly payloadJson: string }>`
            DELETE FROM control_run_messages WHERE run_id = ${runId} AND kind = 'steer'
            RETURNING payload_json AS "payloadJson"
          `
          return rows.map((row) => JSON.parse(row.payloadJson) as SteerMessage)
        })).pipe(Effect.mapError(persistence("drain steering")))
        return drained
      }),
      deliverSignal: Effect.fn("SqlControlRuntime.deliverSignal")((runId: RunId, signal: SignalPayload) =>
        // Durable delivery, and deliberately no resumption: a signal records a
        // fact, it does not decide who runs next.
        appendMessage(runId, "signal", signal)
      ),
      deliveredSignals: Effect.fn("SqlControlRuntime.deliveredSignals")(function*(runId: RunId) {
        yield* requireRow(runId)
        return (yield* messages(runId, "signal")) as ReadonlyArray<SignalPayload>
      }),
      requestResume: Effect.fn("SqlControlRuntime.requestResume")(function*(runId: RunId) {
        yield* requireRow(runId)
        const sequence = yield* nextSequence("resume")
        const timestamp = yield* now
        yield* writer.write(sql`
          INSERT INTO control_run_resumes (run_id, requested_seq, requested_at_ms)
          VALUES (${runId}, ${sequence}, ${timestamp})
          ON CONFLICT (run_id) DO UPDATE SET
            requested_seq = excluded.requested_seq,
            requested_at_ms = excluded.requested_at_ms
        `).pipe(Effect.mapError(persistence("record a resume delegation")))
        return sequence
      }),
      // Terminal runs are filtered in SQL: a delegation nobody will ever take
      // up must not keep appearing in every host's poll.
      pendingResumes: sql<
        { readonly runId: string; readonly requestedSeq: number; readonly requestedAtMs: number }
      >`
        SELECT resumes.run_id AS "runId",
               resumes.requested_seq AS "requestedSeq",
               resumes.requested_at_ms AS "requestedAtMs"
        FROM control_run_resumes AS resumes
        JOIN flows_runs AS runs ON runs.run_id = resumes.run_id
        WHERE runs.status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY resumes.requested_seq
      `.pipe(
        query("read pending resumes"),
        Effect.map((rows) =>
          rows.map((row) => ({
            runId: row.runId,
            sequence: Number(row.requestedSeq),
            requestedAtMs: Number(row.requestedAtMs)
          }))
        )
      ),
      clearResume: Effect.fn("SqlControlRuntime.clearResume")((runId: RunId, sequence: number) =>
        writer.write(sql`
          DELETE FROM control_run_resumes WHERE run_id = ${runId} AND requested_seq = ${sequence}
        `).pipe(Effect.mapError(persistence("clear a resume delegation")), Effect.asVoid)
      ),
      registerFiber: Effect.fn("SqlControlRuntime.registerFiber")(function*(
        runId: RunId,
        fiber: Fiber.Fiber<unknown, unknown>
      ) {
        yield* requireRow(runId)
        fibers.set(runId, fiber)
      }),
      interrupt: Effect.fn("SqlControlRuntime.interrupt")(function*(runId: RunId) {
        const row = yield* requireRow(runId)
        const summary = summaryOf(row)
        // Terminality is asked FIRST, as `resume` asks it. A settled run has
        // released its owner, so `ownedByUs` is false for every process
        // including the one that ran it, and asking ownership first answered
        // `ClaimLost` — "somebody else has it" — for a run that had simply
        // finished. Its caller has a `Terminal` receipt for exactly this.
        if (terminal(summary.status)) return summary
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
        const fiber = fibers.get(runId)
        // Cancellation is fiber interruption, not a flag anyone polls.
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        fibers.delete(runId)
        return yield* transition(runId, row.owner, summary, "cancelled")
      }),
      resume: Effect.fn("SqlControlRuntime.resume")(function*(
        runId: RunId,
        options?: { readonly scope?: "launched" | "any" | undefined } | undefined
      ) {
        const row = yield* requireRow(runId)
        const summary = summaryOf(row)
        if (terminal(summary.status)) return summary
        // Start-or-join: owning the run already means resume is a no-op, and a
        // run owned by a live peer is theirs to drive.
        if (row.status === "running") {
          return ownedByUs(row) ? summary : yield* new ClaimLost({ runId })
        }
        // `scope: "launched"` is the steer wake's request: only a run this
        // plane launched is this plane's to claim there. An engine-created
        // run — a child, a fork, a trampoline round — has its own driver, and
        // a wake that claimed it would move the row under this plane's fence
        // where that driver's `scheduleResume` gives up, orphaning the run.
        // The wake intent is already durable (the notification queue admitted
        // the message), so the owning driver's next poll or sweep delivers
        // it. An explicit operator or monitor resume omits the scope and may
        // claim any suspended run — a wedged run is one nobody is driving.
        if (options?.scope === "launched") {
          const indexed = yield* sql`SELECT run_id FROM control_runs WHERE run_id = ${runId}`.pipe(
            Effect.mapError(persistence("read the launch index"))
          )
          if (indexed.length === 0) return yield* new ClaimLost({ runId })
        }
        return yield* claim(runId, row)
      }),
      claimFence: Effect.fn("SqlControlRuntime.claimFence")(function*(runId: RunId) {
        const row = yield* requireRow(runId)
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
        return JSON.stringify(row.owner)
      }),
      writeStatus: Effect.fn("SqlControlRuntime.writeStatus")(function*(
        runId: RunId,
        fence: string,
        status: RunStatus
      ) {
        const row = yield* requireRow(runId)
        const presented = yield* Effect.try({
          try: () => JSON.parse(fence) as Ownership.OwnerId,
          catch: () => new ClaimLost({ runId })
        })
        return yield* transition(runId, presented, summaryOf(row), status)
      }),
      /**
       * The submitted identity wins, and only the clock is the runtime's.
       *
       * `Control.RunMutationInput` states the order: the runtime "supplies its
       * own principal when the caller names none". The submitted one is the
       * identity the server authenticated at its boundary, so a composition
       * default that overrode it would rename every remote operator to
       * whatever this process was built with.
       */
      stampPrincipal: Effect.fn("SqlControlRuntime.stampPrincipal")(function*(submitted?: Principal | undefined) {
        const timestamp = yield* now
        return {
          id: submitted?.id ?? options.principal?.id ?? "local",
          kind: submitted?.kind ?? options.principal?.kind ?? "operator",
          stampedAt: timestamp
        }
      }),
      lookupMutation: Effect.fn("SqlControlRuntime.lookupMutation")(function*(
        key: IdempotencyKey,
        fingerprint: string
      ) {
        const rows = yield* sql<{ readonly fingerprint: string; readonly receiptJson: string }>`
          SELECT fingerprint, receipt_json AS "receiptJson" FROM control_mutations WHERE mutation_key = ${key}
        `.pipe(query("read a mutation"))
        const row = rows[0]
        if (row === undefined) return undefined
        return row.fingerprint === fingerprint
          ? alreadyApplied(key, JSON.parse(row.receiptJson) as Receipt)
          : { _tag: "Conflict" as const, message: `idempotency key ${key} was used for another mutation` }
      }),
      recordMutation: Effect.fn("SqlControlRuntime.recordMutation")((
        key: IdempotencyKey,
        fingerprint: string,
        receipt: Receipt
      ) =>
        writer.write(Effect.gen(function*() {
          yield* sql`
          INSERT INTO control_mutations (mutation_key, fingerprint, receipt_json)
          VALUES (${key}, ${fingerprint}, ${JSON.stringify(receipt)})
          ON CONFLICT (mutation_key) DO NOTHING
        `
          const rows = yield* sql<{ readonly fingerprint: string; readonly receiptJson: string }>`
          SELECT fingerprint, receipt_json AS "receiptJson"
          FROM control_mutations WHERE mutation_key = ${key}
        `
          const stored = rows[0]
          if (
            stored === undefined || stored.fingerprint !== fingerprint || stored.receiptJson !== JSON.stringify(receipt)
          ) {
            return yield* Effect.fail(
              new PersistenceError({
                operation: "record a mutation",
                message: `Idempotency key ${key} was already settled by another mutation`
              })
            )
          }
        })).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            cause instanceof PersistenceError ? cause : persistence("record a mutation")(cause)
          )
        )
      ),
      grants: Effect.fn("SqlControlRuntime.grants")(() =>
        sql<{
          readonly tokenId: string
          readonly envelopeJson: string
          readonly scope: string
          readonly installedAtMs: number
        }>`
          SELECT token_id AS "tokenId", envelope_json AS "envelopeJson",
                 scope, installed_at_ms AS "installedAtMs"
          FROM control_grants ORDER BY installed_at_ms, token_id
        `.pipe(
          query("list grants"),
          Effect.map((rows) =>
            rows.map((row): BulkGrant => ({
              tokenId: row.tokenId,
              envelope: JSON.parse(row.envelopeJson) as Envelope,
              scope: row.scope as BulkGrant["scope"],
              installedAt: Number(row.installedAtMs)
            }))
          )
        )
      )()
    })
    return service
  })

/**
 * Provides a durable runtime over the ambient database and run store.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (
  options: Options = {}
): Layer.Layer<
  ControlRuntime,
  PersistenceError,
  Crypto.Crypto | DurableWriter | SqlClient.SqlClient | RunStore.RunStore
> => Layer.effect(ControlRuntime)(makeRuntime(options))

/**
 * Provides a durable runtime and the run store it needs over the ambient
 * database.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerWithStore = (
  options: Options = {}
): Layer.Layer<
  ControlRuntime,
  PersistenceError,
  Crypto.Crypto | DurableWriter | SqlClient.SqlClient
> => layer(options).pipe(Layer.provideMerge(RunStore.layer))

/**
 * Constructs a durable runtime over the ambient database and run store.
 *
 * @category constructors
 * @since 0.1.0
 */
export { makeRuntime as make }
