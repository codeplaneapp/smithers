/**
 * The adapter-compat module: `adapter.js`'s event, run-claim, and attempt call
 * signatures, implemented on the flows `Journal`, `RunStore`, and
 * `AttemptStore`.
 *
 * Stage 1.1 of `.smithers/specs/flows-migration.md`. Every method here takes the
 * arguments the `SmithersDb` method of the same name takes and returns what it
 * returns, so `adapter.js` delegates without any caller changing.
 *
 * What flows contributes, and what stays:
 *
 * - **Sequence allocation moves inside the write transaction.** `emitDurable`
 *   allocates `MAX(seq) + 1` in the same transaction that commits the row, so
 *   the legacy read-then-insert under `BEGIN IMMEDIATE` and its transaction turn
 *   are no longer what keeps sequences gapless.
 * - **Writes are fenced on the persisted owner.** A journal append, an attempt
 *   heartbeat, and an attempt terminal transition all refuse when the run's
 *   recorded owner has moved on, instead of relying on a `WHERE` clause the
 *   caller remembered to write.
 * - **Stale-owner takeover becomes a lease.** `claimRunForResume` runs the flows
 *   compare-and-swap with liveness evidence rather than only comparing a
 *   heartbeat.
 * - **The legacy tables stay the read model.** Every write mirrors into
 *   `_smithers_*` in the same transaction, so `listAttempts`, the event history
 *   queries, the gateway, and the UI keep reading exactly what they read before.
 *
 * Two boundaries are deliberate and load-bearing:
 *
 * 1. **A caller-owned transaction keeps the legacy path.** The flows stores hold
 *    their own connection to the same SQLite file. When `adapter.js` already has
 *    a transaction open on its connection it holds the database's write lock, so
 *    a flows write inside it would wait for a lock its own caller holds.
 *    `adapter.js` therefore only delegates at transaction depth zero, and
 *    {@link FlowsAdapterCompat} repairs whatever the legacy path wrote on the
 *    next call through {@link syncRunIntoFlows}.
 * 2. **`updateAttempt` stays on the legacy path.** It writes an arbitrary column
 *    patch, which has no flows counterpart; flows models attempt lifecycle
 *    (`put`, `heartbeat`, `finish`), not column patches. The per-run catch-up
 *    copies whatever it wrote.
 */
import { Effect } from "effect";
import { SqlClient, openFlowsStores } from "./flowsStores.js";
import { flowsModules } from "./vendoredFlows.js";
import { LIVE_EVENT_SOURCE_ID, toJournalEventInput } from "./eventTranslation.js";
import { attemptStepKeyDigest, toFlowsAttempt } from "./attemptTranslation.js";
import { classifyRunDriverLiveness } from "../runDriverLiveness.js";
import { sameFlowsOwner, toFlowsOwnerId } from "./ownerIdentity.js";
import { insertOrIgnore, updateWhereReturning, upsertRow } from "./mirrorSql.js";
import { migrateLiveRuns, reconcileRunOwnership, syncRunIntoFlows } from "./flowsRunSync.js";
import { clearAttemptResumePointers, isNonSuccessTerminalAttemptState } from "../attempt-resume-pointers.js";

/**
 * Rolls the surrounding transaction back and reports the compare-and-set as
 * lost. It is a failure rather than a value so that whatever the mirror already
 * wrote inside the transaction is discarded with it.
 */
class ClaimLost {
  /** @param {string} reason */
  constructor(reason) {
    this.reason = reason;
  }
}

/**
 * The attempt error column is JSON text on the Smithers side and a decoded value
 * on the flows side. Text that does not parse is carried verbatim rather than
 * failing the terminal transition.
 *
 * @param {string} errorJson
 * @returns {unknown}
 */
function decodeErrorJson(errorJson) {
  try {
    return JSON.parse(errorJson);
  } catch {
    return { text: errorJson };
  }
}

/** @param {unknown} error */
function isClaimLost(error) {
  return error instanceof ClaimLost;
}

/**
 * The `_smithers_runs` predicate that fences every attempt write: the run is
 * running, nobody asked to cancel it, and the writer owns it.
 */
const RUN_OWNERSHIP_PREDICATE = `EXISTS (SELECT 1 FROM _smithers_runs r
  WHERE r.run_id = _smithers_attempts.run_id
    AND r.status = 'running'
    AND r.cancel_requested_at_ms IS NULL
    AND ((r.runtime_owner_id IS NULL AND CAST(? AS TEXT) IS NULL) OR r.runtime_owner_id = ?))`;

const ATTEMPT_KEY_PREDICATE = "run_id = ? AND node_id = ? AND iteration = ? AND attempt = ?";

/**
 * Build the liveness evidence flows requires before one owner replaces another.
 *
 * Smithers already owns this judgement, in `runDriverLiveness.js`, and stage 1.5
 * keeps that kind of classification on the Smithers side of the seam. This
 * function is the adapter between the two vocabularies and nothing more: it
 * classifies the `_smithers_runs` row through `classifyRunDriverLiveness` and
 * translates a not-live verdict into the `LivenessEvidence` shape flows
 * validates.
 *
 * Re-deriving the verdict here instead would lose two rules the Smithers
 * classifier already encodes and the resume paths depend on:
 *
 * - **A recycled PID is dead.** A PID that started *after* the run's last
 *   heartbeat cannot be the process that wrote it, so ordinary crash recovery
 *   still resumes a crashed run whose PID an unrelated process has since been
 *   handed.
 * - **A remote owner is judged by its heartbeat.** Its PID belongs to another
 *   host, so a fresh heartbeat means live and a stale one means unreachable —
 *   not "cross-host, therefore claimable".
 *
 * The evidence `kind` is chosen from the flows host ids rather than the Smithers
 * ones because that is what flows validates: it accepts `same-host-pid-dead`
 * only when the expected owner and the observer share a host id, and
 * `cross-host-unreachable-stale` only when they do not.
 *
 * @param {{ status?: string | null; runtimeOwnerId?: string | null; heartbeatAtMs?: number | null }} run the `_smithers_runs` fields, in Smithers vocabulary
 * @param {{ hostId: string; pid: number; nonce: string }} expectedOwner
 * @param {{ hostId: string; pid: number; nonce: string }} claimant
 * @param {number} nowMs must equal the `nowMs` passed to the flows call
 * @param {Parameters<typeof classifyRunDriverLiveness>[1]} [probes] liveness probe overrides
 * @returns {{ expectedOwner: { hostId: string; pid: number; nonce: string }; checkedAtMs: number; kind: "same-host-pid-dead" | "cross-host-unreachable-stale" } | null} `null` when the owner is still live, so no honest evidence exists
 */
export function buildLivenessEvidence(run, expectedOwner, claimant, nowMs, probes = {}) {
  const liveness = classifyRunDriverLiveness(run, { ...probes, now: nowMs });
  if (liveness.live) return null;
  return {
    expectedOwner,
    checkedAtMs: nowMs,
    kind: expectedOwner.hostId === claimant.hostId ? "same-host-pid-dead" : "cross-host-unreachable-stale",
  };
}

/**
 * The `_smithers_runs` fields `classifyRunDriverLiveness` reads, from the
 * snake_case row the flows SQL client returns.
 *
 * @param {Record<string, any>} row
 * @returns {{ status: string | null; runtimeOwnerId: string | null; heartbeatAtMs: number | null }}
 */
function toLivenessInput(row) {
  const heartbeatAtMs = row.heartbeat_at_ms ?? null;
  return {
    status: row.status ?? null,
    runtimeOwnerId: row.runtime_owner_id ?? null,
    heartbeatAtMs: heartbeatAtMs === null ? null : Number(heartbeatAtMs),
  };
}

/**
 * The flows-backed implementation of the `adapter.js` methods this lane moves.
 */
export class FlowsAdapterCompat {
  /** @param {import("./flowsStores.js").FlowsStores} stores */
  constructor(stores) {
    this.stores = stores;
  }

  /**
   * @param {{ filename: string }} options
   * @returns {Promise<FlowsAdapterCompat>}
   */
  static async open(options) {
    return new FlowsAdapterCompat(await openFlowsStores(options));
  }

  /** @returns {Promise<void>} */
  close() {
    return this.stores.close();
  }

  /**
   * The effect that runs `body` in one flows write transaction, with the
   * services it needs.
   *
   * `Journal.transact` is the seam that makes the flows state transition, its
   * journal entry, and the legacy mirror row one atomic write: a failure
   * anywhere inside rolls all three back.
   *
   * @param {(services: { sql: any; journal: any; runStore: any; attemptStore: any }) => any} body
   * @returns {any}
   */
  program(body) {
    const modules = flowsModules();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = yield* modules.journal.Journal.Journal;
      const runStore = yield* modules.runStore.RunStore.RunStore;
      const attemptStore = yield* modules.runStore.AttemptStore.AttemptStore;
      return yield* journal.transact(body({ sql, journal, runStore, attemptStore }));
    });
  }

  /**
   * @param {(services: { sql: any; journal: any; runStore: any; attemptStore: any }) => any} body
   * @returns {Promise<any>}
   */
  transact(body) {
    return this.stores.runPromise(this.program(body));
  }

  /**
   * Run a compare-and-set whose lost outcome rolls the transaction back.
   *
   * The result is inspected outside the transaction on purpose: a `ClaimLost`
   * observed inside it would commit whatever the mirror had already written.
   *
   * @param {(services: { sql: any; journal: any; runStore: any; attemptStore: any }) => any} body
   * @returns {Promise<boolean>}
   */
  async transactClaim(body) {
    const outcome = await this.stores.runPromise(Effect.result(this.program(body)));
    if (outcome._tag === "Success") return outcome.success !== false;
    if (isClaimLost(outcome.failure)) return false;
    throw outcome.failure;
  }

  /**
   * Copy every live run's legacy rows into the flows tables.
   *
   * @returns {Promise<{ runs: number; events: number; attempts: number }>}
   */
  migrateLiveRuns() {
    return this.transact(({ sql }) => migrateLiveRuns(sql));
  }

  /**
   * `SmithersDb.insertEventWithNextSeq`: append one event and return its
   * sequence.
   *
   * @param {{ runId: string; timestampMs: number; type: string; payloadJson: string }} row
   * @returns {Promise<number>}
   */
  insertEventWithNextSeq(row) {
    return this.transact(({ sql, journal }) =>
      Effect.gen(function* () {
        const ownership = yield* syncRunIntoFlows(sql, row.runId);
        // The legacy dedupe key is the whole row, and callers rely on a retried
        // write returning the original sequence rather than a second one.
        const existing = yield* sql.unsafe(
          `SELECT seq FROM _smithers_events
           WHERE run_id = ? AND timestamp_ms = ? AND type = ? AND payload_json = ?
           ORDER BY seq DESC LIMIT 1`,
          [row.runId, row.timestampMs, row.type, row.payloadJson],
        );
        if (existing[0]?.seq !== undefined) return Number(existing[0].seq);
        const receipt = yield* journal.emitDurable(
          toJournalEventInput(row, { sourceId: LIVE_EVENT_SOURCE_ID }),
          ownership?.owner ?? undefined,
        );
        const seq = Number(receipt.seq);
        yield* insertOrIgnore(sql, "_smithers_events", {
          runId: row.runId,
          seq,
          timestampMs: row.timestampMs,
          type: row.type,
          payloadJson: row.payloadJson,
        });
        return seq;
      }),
    );
  }

  /**
   * `SmithersDb.claimRunForResume`: take over a run whose owner is gone, or
   * whose owner an operator has decided to displace.
   *
   * Two takeover modes, because the caller already distinguishes them.
   * `requireStale` is `false` exactly when the caller passed `--force` or
   * `--steal-ownership` on a running run (`activateRunForResume` in
   * `packages/engine/src/engine.js`), which is a deliberate operator override of
   * the live-owner precondition; otherwise it is `true` and the call is ordinary
   * crash recovery.
   *
   * - **Crash recovery** runs the flows lease: `RunStore.claimAndOwn` with the
   *   liveness evidence {@link buildLivenessEvidence} produces. A live owner
   *   yields no evidence and the claim is refused.
   * - **Operator override** cannot run the flows lease. Every flows takeover
   *   path — `claimAndOwn` and `steal` alike — requires the persisted heartbeat
   *   to be older than `heartbeatStaleAfter`, and `steal` requires evidence on
   *   top of that, so flows models lease expiry and has no counterpart for "take
   *   it anyway". The legacy compare-and-set stays the arbiter and
   *   `reconcileRunOwnership` republishes the row it wrote into `flows_runs`,
   *   inside the same transaction, so the flows fence still names the new owner.
   * - **Reactivating a terminal run** takes the same legacy-arbiter path.
   *   `claimAndOwn` admits `pending`, `suspended`, and `running` only, and
   *   Smithers resumes runs that already finished, failed, or were cancelled
   *   (replay, fork, `retry-task`), which map onto flows terminal statuses.
   * - **A claim owner id flows cannot fence** takes it too: `runtime_owner_id`
   *   is opaque on the Smithers side, and the supervisor claims with
   *   `supervisor:<name>`, which names no pid.
   *
   * @param {{ runId: string; expectedStatus?: string; expectedRuntimeOwnerId: string | null; expectedHeartbeatAtMs: number | null; staleBeforeMs: number; claimOwnerId: string; claimHeartbeatAtMs: number; requireStale?: boolean }} params
   * @returns {Promise<boolean>}
   */
  claimRunForResume(params) {
    const expectedStatus = params.expectedStatus ?? "running";
    const requireStale = params.requireStale ?? expectedStatus === "running";
    // `runtime_owner_id` is an opaque string on the Smithers side, and callers
    // outside the engine write ids that name no pid — the supervisor claims with
    // `supervisor:<name>`. flows fences on a host/pid/nonce triple and has no
    // token for such an id, so those claims stay on the legacy predicate.
    const claimant = toFlowsOwnerId(params.claimOwnerId);
    const nowMs = params.claimHeartbeatAtMs;
    return this.transactClaim(({ sql, runStore }) =>
      Effect.gen(function* () {
        const expected = yield* syncRunIntoFlows(sql, params.runId);
        if (expected === null) return yield* Effect.fail(new ClaimLost("run-not-found"));
        // The exact three columns the flows compare-and-swap tests, lifted out of
        // the catch-up result so nothing else in it reaches the store.
        const snapshot = { status: expected.status, owner: expected.owner, heartbeatAtMs: expected.heartbeatAtMs };
        // `flows_runs` carries an owner triple on exactly its `running` rows, and
        // every flows takeover path refuses one whose heartbeat is not yet stale.
        // A caller that asked not to require staleness is therefore asking for
        // something flows cannot express, whoever the current owner is.
        const owned = expected.status === "running" && expected.owner !== null;
        const override = owned && !requireStale;
        // `claimAndOwn` only admits `pending`, `suspended`, and `running`. A run
        // Smithers finished, failed, or cancelled maps onto a flows terminal
        // status, and Smithers resumes exactly those rows — replay, fork, and
        // `retry-task` all reactivate a run that already reached an end state.
        // flows has no lease transition out of a terminal status, so those
        // resumes stay on the legacy compare-and-set, which is what decided them
        // before this module existed.
        const leasable = expected.status === "pending" || expected.status === "suspended" || owned;
        // In all three cases the flows lease cannot arbitrate, so the legacy
        // predicate does and `flows_runs` is republished from the row it wrote.
        const legacyArbitrates = override || !leasable || claimant === null;
        // Evidence is only needed to displace an owner that is not the claimant;
        // flows lets an owner re-enter its own run without it.
        const contested = owned && !sameFlowsOwner(expected.owner, claimant);
        const evidence =
          contested && !legacyArbitrates
            ? buildLivenessEvidence(toLivenessInput(expected.run), expected.owner, claimant, nowMs)
            : undefined;
        if (evidence === null) return yield* Effect.fail(new ClaimLost("owner-still-alive"));
        // The legacy compare-and-set, unchanged, so a caller that depends on its
        // exact predicate — expected status, expected owner, expected heartbeat,
        // staleness — sees the same answer it always saw.
        const updated = yield* updateWhereReturning(
          sql,
          "_smithers_runs",
          { runtimeOwnerId: params.claimOwnerId, heartbeatAtMs: params.claimHeartbeatAtMs },
          `run_id = ?
             AND status = ?
             AND COALESCE(runtime_owner_id, '') = COALESCE(?, '')
             AND COALESCE(heartbeat_at_ms, -1) = COALESCE(?, -1)
             AND (? = 0 OR heartbeat_at_ms IS NULL OR heartbeat_at_ms < ?)`,
          [
            params.runId,
            expectedStatus,
            params.expectedRuntimeOwnerId,
            params.expectedHeartbeatAtMs,
            requireStale ? 1 : 0,
            params.staleBeforeMs,
          ],
        );
        if (updated.length === 0) return yield* Effect.fail(new ClaimLost("legacy-guard-failed"));
        if (legacyArbitrates) {
          yield* reconcileRunOwnership(sql, params.runId);
          return true;
        }
        const outcome = yield* runStore.claimAndOwn(
          params.runId,
          snapshot,
          /** @type {{ hostId: string; pid: number; nonce: string }} */ (claimant),
          nowMs,
          evidence,
        );
        if (outcome._tag !== "Activated") return yield* Effect.fail(new ClaimLost(outcome._tag));
        return true;
      }),
    );
  }

  /**
   * `SmithersDb.insertAttempt`: record a new attempt row.
   *
   * @param {Record<string, unknown>} row
   * @returns {Promise<void>}
   */
  async insertAttempt(row) {
    const runId = String(row.runId);
    const outcome = await this.stores.runPromise(
      Effect.result(
        this.program(({ sql, attemptStore }) =>
          Effect.gen(function* () {
            const ownership = yield* syncRunIntoFlows(sql, runId);
            yield* upsertRow(sql, "_smithers_attempts", row, ["runId", "nodeId", "iteration", "attempt"]);
            if (ownership?.owner) {
              const result = yield* attemptStore.put(toFlowsAttempt(row), ownership.owner);
              if (result._tag === "FenceLost" || result._tag === "RunNotFound") {
                return yield* Effect.fail(new ClaimLost(result._tag));
              }
            }
          }),
        ),
      ),
    );
    if (outcome._tag === "Failure") {
      if (isClaimLost(outcome.failure)) {
        throw new Error(`flows attempt store refused the attempt write: ${outcome.failure.reason}`);
      }
      throw outcome.failure;
    }
  }

  /**
   * `SmithersDb.claimAttemptCompletion`: compare-and-set the attempt to
   * `finished`.
   *
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {string | null} runtimeOwnerId
   * @param {number} finishedAtMs
   * @returns {Promise<boolean>}
   */
  claimAttemptCompletion(runId, nodeId, iteration, attempt, runtimeOwnerId, finishedAtMs) {
    return this.claimAttemptTerminal(runId, nodeId, iteration, attempt, runtimeOwnerId, "finished", finishedAtMs);
  }

  /**
   * `SmithersDb.claimAttemptTerminal`: compare-and-set the attempt's terminal
   * state.
   *
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {string | null} runtimeOwnerId
   * @param {string} state
   * @param {number} finishedAtMs
   * @param {string} [errorJson]
   * @returns {Promise<boolean>}
   */
  claimAttemptTerminal(runId, nodeId, iteration, attempt, runtimeOwnerId, state, finishedAtMs, errorJson) {
    const ownerId = runtimeOwnerId ?? null;
    const stepKeyDigest = attemptStepKeyDigest(nodeId, iteration);
    return this.transactClaim(({ sql, attemptStore }) =>
      Effect.gen(function* () {
        const ownership = yield* syncRunIntoFlows(sql, runId, {
          attempts: true,
          attemptTarget: { nodeId, iteration, attempt },
        });
        const claimed = yield* updateWhereReturning(
          sql,
          "_smithers_attempts",
          {
            state,
            finishedAtMs,
            ...(errorJson === undefined ? {} : { errorJson }),
          },
          `${ATTEMPT_KEY_PREDICATE} AND state = 'in-progress' AND ${RUN_OWNERSHIP_PREDICATE}`,
          [runId, nodeId, iteration, attempt, ownerId, ownerId],
        );
        if (claimed.length === 0) return yield* Effect.fail(new ClaimLost("legacy-guard-failed"));
        if (ownership?.owner) {
          const outcome = yield* attemptStore.finish(
            {
              runId,
              stepKeyDigest,
              attempt,
              state,
              finishedAtMs,
              ...(errorJson === undefined ? {} : { error: decodeErrorJson(errorJson) }),
            },
            ownership.owner,
          );
          if (outcome._tag !== "Finished") return yield* Effect.fail(new ClaimLost(outcome._tag));
        }
        // Same hygiene as the legacy path (#1610): an attempt that ended without
        // success must stop advertising resume pointers that name a conversation
        // which is usually already gone.
        if (isNonSuccessTerminalAttemptState(state)) {
          const rows = yield* sql.unsafe(
            `SELECT meta_json FROM _smithers_attempts WHERE ${ATTEMPT_KEY_PREDICATE} LIMIT 1`,
            [runId, nodeId, iteration, attempt],
          );
          const cleared = clearAttemptResumePointers(rows[0]?.meta_json);
          if (cleared !== null) {
            yield* sql.unsafe(`UPDATE _smithers_attempts SET meta_json = ? WHERE ${ATTEMPT_KEY_PREDICATE}`, [
              cleared,
              runId,
              nodeId,
              iteration,
              attempt,
            ]);
          }
        }
        return true;
      }),
    );
  }

  /**
   * `SmithersDb.heartbeatAttempt`: refresh the run and attempt heartbeats as one
   * ownership-fenced fact.
   *
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} iteration
   * @param {number} attempt
   * @param {number} heartbeatAtMs
   * @param {string | null} heartbeatDataJson
   * @param {string} runtimeOwnerId
   * @returns {Promise<boolean>}
   */
  heartbeatAttempt(runId, nodeId, iteration, attempt, heartbeatAtMs, heartbeatDataJson, runtimeOwnerId) {
    const ownerId = runtimeOwnerId ?? null;
    const stepKeyDigest = attemptStepKeyDigest(nodeId, iteration);
    return this.transactClaim(({ sql, runStore, attemptStore }) =>
      Effect.gen(function* () {
        const ownership = yield* syncRunIntoFlows(sql, runId, {
          attempts: true,
          attemptTarget: { nodeId, iteration, attempt },
        });
        const runUpdated = yield* updateWhereReturning(
          sql,
          "_smithers_runs",
          { heartbeatAtMs },
          `run_id = ? AND status = ? AND cancel_requested_at_ms IS NULL
             AND ((runtime_owner_id IS NULL AND CAST(? AS TEXT) IS NULL) OR runtime_owner_id = ?)`,
          [runId, "running", ownerId, ownerId],
        );
        if (runUpdated.length === 0) return yield* Effect.fail(new ClaimLost("run-fence-lost"));
        const attemptUpdated = yield* updateWhereReturning(
          sql,
          "_smithers_attempts",
          {
            heartbeatAtMs,
            ...(heartbeatDataJson === null ? {} : { heartbeatDataJson }),
          },
          `${ATTEMPT_KEY_PREDICATE} AND state = 'in-progress'`,
          [runId, nodeId, iteration, attempt],
        );
        if (attemptUpdated.length === 0) return yield* Effect.fail(new ClaimLost("attempt-fence-lost"));
        if (ownership?.owner) {
          const runBeat = yield* runStore.heartbeat(runId, ownership.owner, heartbeatAtMs);
          if (runBeat._tag !== "Updated") return yield* Effect.fail(new ClaimLost(runBeat._tag));
          const attemptBeat = yield* attemptStore.heartbeat(
            runId,
            stepKeyDigest,
            attempt,
            ownership.owner,
            heartbeatAtMs,
          );
          if (attemptBeat._tag !== "Updated") return yield* Effect.fail(new ClaimLost(attemptBeat._tag));
        }
        return true;
      }),
    );
  }
}
