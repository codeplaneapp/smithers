import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Database } from "@flows/database"
import { AttemptStore } from "@flows/journal"
import { parseRuntimeOwnerId, UnsupportedShimOperation } from "./run-ownership-shim.js"

const SMITHERS_META_KEY = "smithers"

export const stepKeyDigestFor = (runId, nodeId, iteration) =>
  createHash("sha256").update(`smithers-attempt:v1:${runId}:${nodeId}:${iteration}`).digest("hex")

const STATE_TO_FLOWS = { "in-progress": "running" }
const STATE_FROM_FLOWS = { "running": "in-progress" }

const toFlowsState = (state) => STATE_TO_FLOWS[state] ?? state
const fromFlowsState = (state) => STATE_FROM_FLOWS[state] ?? state

const parseJsonOrNull = (value) => {
  if (value === null || value === undefined) return undefined
  return JSON.parse(value)
}

const readSmithersMeta = (meta) => {
  if (meta === null || typeof meta !== "object") return {}
  return meta[SMITHERS_META_KEY] ?? {}
}

const writeMeta = (agentMeta, smithersFields) => ({
  ...(agentMeta && typeof agentMeta === "object" ? agentMeta : {}),
  [SMITHERS_META_KEY]: smithersFields
})

const toSmithersAttemptRow = (attempt) => {
  const smithers = readSmithersMeta(attempt.meta)
  const agentMeta = { ...(attempt.meta && typeof attempt.meta === "object" ? attempt.meta : {}) }
  delete agentMeta[SMITHERS_META_KEY]
  return {
    runId: attempt.runId,
    nodeId: smithers.nodeId ?? null,
    iteration: smithers.iteration ?? null,
    attempt: attempt.attempt,
    state: fromFlowsState(attempt.state),
    startedAtMs: attempt.startedAtMs,
    finishedAtMs: attempt.finishedAtMs ?? null,
    heartbeatAtMs: attempt.heartbeatAtMs ?? null,
    heartbeatDataJson: attempt.checkpoint === undefined ? null : JSON.stringify(attempt.checkpoint),
    errorJson: attempt.error === undefined ? null : JSON.stringify(attempt.error),
    jjPointer: smithers.jjPointer ?? null,
    responseText: smithers.responseText ?? null,
    jjCwd: smithers.jjCwd ?? null,
    cached: smithers.cached ?? false,
    metaJson: Object.keys(agentMeta).length === 0 ? null : JSON.stringify(agentMeta)
  }
}

const throwMapped = (method) => (cause) => {
  if (cause instanceof UnsupportedShimOperation) throw cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(`flows attempt shim ${method}: ${message}`)
  error.cause = cause
  throw error
}

const META_PATCH_KEYS = new Set(["responseText", "jjPointer", "jjCwd", "cached", "metaJson"])

/**
 * SmithersDb attempt methods implemented on @flows/journal AttemptStore.
 *
 * Mapping:
 *  - step_key_digest = sha256("smithers-attempt:v1:<runId>:<nodeId>:<iteration>").
 *    nodeId/iteration are not recoverable from the digest; they are stored in
 *    meta_json.smithers and listAttempts filters via json_extract.
 *  - heartbeatDataJson (the agent session checkpoint) -> checkpoint_json
 *    (flows caps checkpoints at 1 MiB; larger agent sessions fail to persist).
 *  - errorJson -> error_json (parsed/re-serialized).
 *  - responseText, jjPointer, jjCwd, cached -> meta_json.smithers (no flows
 *    columns; not covered by flows' fenced CAS).
 *  - agent-shaped metaJson -> meta_json top level (read by name by engine.js).
 *  - smithers attempt state 'in-progress' <-> flows attempt state 'running'.
 */
export const createAttemptShim = (boundary) => {
  let storePromise
  const getStore = () => storePromise ??= boundary.run(AttemptStore.make)
  let dbPromise
  const getDb = () => dbPromise ??= boundary.run(Effect.service(Database.Database))

  const insertAttempt = async (row) => {
    try {
      const store = await getStore()
      const stepKeyDigest = stepKeyDigestFor(row.runId, row.nodeId, row.iteration)
      const agentMeta = parseJsonOrNull(row.metaJson) ?? {}
      if (row.runtimeOwnerId == null) {
        throw new UnsupportedShimOperation(
          "insertAttempt: flows AttemptStore.put is fenced on run ownership; a runtimeOwnerId is required"
        )
      }
      const result = await boundary.run(
        store.put({
          runId: row.runId,
          stepKeyDigest,
          attempt: row.attempt,
          state: toFlowsState(row.state),
          startedAtMs: row.startedAtMs,
          ...(row.finishedAtMs != null ? { finishedAtMs: row.finishedAtMs } : {}),
          ...(row.heartbeatAtMs != null ? { heartbeatAtMs: row.heartbeatAtMs } : {}),
          ...(row.heartbeatDataJson != null ? { checkpoint: JSON.parse(row.heartbeatDataJson) } : {}),
          ...(row.errorJson != null ? { error: JSON.parse(row.errorJson) } : {}),
          meta: writeMeta(agentMeta, {
            nodeId: row.nodeId,
            iteration: row.iteration,
            jjPointer: row.jjPointer ?? null,
            responseText: row.responseText ?? null,
            jjCwd: row.jjCwd ?? null,
            cached: row.cached ?? false
          })
        }, parseRuntimeOwnerId(row.runtimeOwnerId))
      )
      if (result._tag === "Inserted" || result._tag === "ExistingSame") return
      if (result._tag === "Conflict") {
        throw new UnsupportedShimOperation(
          `insertAttempt: smithers upsert semantics conflict with flows first-writer-wins admission for ${row.nodeId}#${row.attempt}`
        )
      }
      throw new Error(`insertAttempt fence lost: ${result._tag}`)
    } catch (cause) {
      throwMapped("insertAttempt")(cause)
    }
  }

  const getAttempt = async (runId, nodeId, iteration, attempt) => {
    try {
      const store = await getStore()
      const found = await boundary.run(
        store.get({ runId, stepKeyDigest: stepKeyDigestFor(runId, nodeId, iteration), attempt })
      )
      return found._tag === "None" ? undefined : toSmithersAttemptRow(found.value)
    } catch (cause) {
      throwMapped("getAttempt")(cause)
    }
  }

  const updateAttempt = async (runId, nodeId, iteration, attempt, patch) => {
    try {
      for (const key of Object.keys(patch)) {
        if (!META_PATCH_KEYS.has(key) && key !== "heartbeatAtMs" && key !== "heartbeatDataJson") {
          throw new UnsupportedShimOperation(
            `updateAttempt: flows AttemptStore has no unfenced path for patch key '${key}'; ` +
              "terminal state transitions must go through claimAttemptTerminal"
          )
        }
      }
      const store = await getStore()
      const stepKeyDigest = stepKeyDigestFor(runId, nodeId, iteration)
      const found = await boundary.run(store.get({ runId, stepKeyDigest, attempt }))
      if (found._tag === "None") return 0
      const current = toSmithersAttemptRow(found.value)
      const merged = { ...current, ...patch }
      const db = await getDb()
      const nextMeta = JSON.stringify(writeMeta(parseJsonOrNull(merged.metaJson) ?? {}, {
        nodeId,
        iteration,
        jjPointer: merged.jjPointer ?? null,
        responseText: merged.responseText ?? null,
        jjCwd: merged.jjCwd ?? null,
        cached: merged.cached ?? false
      }))
      const heartbeatAtMs = patch.heartbeatAtMs ?? current.heartbeatAtMs
      const checkpointJson = patch.heartbeatDataJson !== undefined
        ? patch.heartbeatDataJson
        : current.heartbeatDataJson
      await boundary.run(
        db.write(
          db.sql`UPDATE flows_attempts
                 SET meta_json = ${nextMeta},
                     heartbeat_at_ms = ${heartbeatAtMs},
                     checkpoint_json = ${checkpointJson}
                 WHERE run_id = ${runId} AND step_key_digest = ${stepKeyDigest} AND attempt = ${attempt}`
        )
      )
      return 1
    } catch (cause) {
      throwMapped("updateAttempt")(cause)
    }
  }

  const heartbeatAttempt = async (runId, nodeId, iteration, attempt, heartbeatAtMs, heartbeatDataJson, runtimeOwnerId) => {
    try {
      const store = await getStore()
      const result = await boundary.run(
        store.heartbeat(
          runId,
          stepKeyDigestFor(runId, nodeId, iteration),
          attempt,
          parseRuntimeOwnerId(runtimeOwnerId),
          heartbeatAtMs,
          heartbeatDataJson === null || heartbeatDataJson === undefined ? undefined : JSON.parse(heartbeatDataJson)
        )
      )
      return result._tag === "Updated"
    } catch (cause) {
      throwMapped("heartbeatAttempt")(cause)
    }
  }

  const claimAttemptTerminal = async (runId, nodeId, iteration, attempt, runtimeOwnerId, state, finishedAtMs, errorJson) => {
    try {
      const store = await getStore()
      const result = await boundary.run(
        store.finish({
          runId,
          stepKeyDigest: stepKeyDigestFor(runId, nodeId, iteration),
          attempt,
          state: toFlowsState(state),
          finishedAtMs,
          ...(errorJson === undefined || errorJson === null ? {} : { error: JSON.parse(errorJson) })
        }, parseRuntimeOwnerId(runtimeOwnerId))
      )
      return result._tag === "Finished"
    } catch (cause) {
      throwMapped("claimAttemptTerminal")(cause)
    }
  }

  const listAttempts = async (runId, nodeId, iteration) => {
    try {
      const db = await getDb()
      const rows = await boundary.run(db.sql`
        SELECT run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
               heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
        FROM flows_attempts
        WHERE run_id = ${runId}
          AND json_extract(meta_json, '$.smithers.nodeId') = ${nodeId}
          AND json_extract(meta_json, '$.smithers.iteration') = ${iteration}
        ORDER BY attempt DESC
      `)
      return rows.map((row) =>
        toSmithersAttemptRow({
          runId: row.run_id,
          stepKeyDigest: row.step_key_digest,
          attempt: row.attempt,
          state: row.state,
          startedAtMs: row.started_at_ms,
          ...(row.finished_at_ms === null ? {} : { finishedAtMs: row.finished_at_ms }),
          ...(row.heartbeat_at_ms === null ? {} : { heartbeatAtMs: row.heartbeat_at_ms }),
          ...(row.checkpoint_json === null ? {} : { checkpoint: JSON.parse(row.checkpoint_json) }),
          ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) }),
          meta: JSON.parse(row.meta_json)
        })
      )
    } catch (cause) {
      throwMapped("listAttempts")(cause)
    }
  }

  return { insertAttempt, getAttempt, updateAttempt, heartbeatAttempt, claimAttemptTerminal, listAttempts }
}
