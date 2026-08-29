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
 * pause is not the fence held after the resume that follows it, and the stale
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
import { catalog } from "./SystemFlows.ts"

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
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make_ = (
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
    const configuredFlows = options.flows ?? catalog.map((entry): DurableFlow => ({
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
          ...(storeStatus(status) === "running" ? {} : { ownerId: undefined })
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

    const listRunIds: Effect.Effect<ReadonlyArray<string>, PersistenceError> = sql<{ readonly runId: string }>`
      SELECT run_id AS "runId" FROM control_runs ORDER BY created_seq
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
            if (Option.isSome(stored)) return storedPlan(stored.value).card
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
        return card
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
      getRun: Effect.fn("SqlControlRuntime.getRun")((runId: RunId) => Effect.map(requireRow(runId), summaryOf)),
      listRuns: Effect.fn("SqlControlRuntime.listRuns")(() =>
        Effect.flatMap(
          listRunIds,
          Effect.forEach((runId) => Effect.map(requireRow(runId), summaryOf))
        ).pipe(Effect.catchTag("/control/RunNotFound", () => Effect.succeed([] as ReadonlyArray<RunSummary>)))
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
      registerFiber: Effect.fn("SqlControlRuntime.registerFiber")(function*(
        runId: RunId,
        fiber: Fiber.Fiber<unknown, unknown>
      ) {
        yield* requireRow(runId)
        fibers.set(runId, fiber)
      }),
      interrupt: Effect.fn("SqlControlRuntime.interrupt")(function*(runId: RunId) {
        const row = yield* requireRow(runId)
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
        const fiber = fibers.get(runId)
        // Cancellation is fiber interruption, not a flag anyone polls.
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        fibers.delete(runId)
        return yield* transition(runId, row.owner, summaryOf(row), "cancelled")
      }),
      pause: Effect.fn("SqlControlRuntime.pause")(function*(runId: RunId) {
        const row = yield* requireRow(runId)
        if (!ownedByUs(row)) return yield* new ClaimLost({ runId })
        return yield* transition(runId, row.owner, summaryOf(row), "parked")
      }),
      resume: Effect.fn("SqlControlRuntime.resume")(function*(runId: RunId) {
        const row = yield* requireRow(runId)
        const summary = summaryOf(row)
        if (terminal(summary.status)) return summary
        // Start-or-join: owning the run already means resume is a no-op, and a
        // run owned by a live peer is theirs to drive.
        if (row.status === "running") {
          return ownedByUs(row) ? summary : yield* new ClaimLost({ runId })
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
      stampPrincipal: Effect.fn("SqlControlRuntime.stampPrincipal")(function*(submitted?: Principal | undefined) {
        const timestamp = yield* now
        return {
          id: options.principal?.id ?? submitted?.id ?? "local",
          kind: options.principal?.kind ?? submitted?.kind ?? "operator",
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
> => Layer.effect(ControlRuntime)(make_(options))

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
 * @slop
 */
export { make_ as make }

/**
 * Re-exported so a composition can name a flow without two imports.
 * @slop
 */
export type { FlowId }
