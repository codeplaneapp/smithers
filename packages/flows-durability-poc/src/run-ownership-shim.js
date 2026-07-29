import { hostname } from "node:os"
import { Effect } from "effect"
import { Database } from "@flows/database"
import { RunStore } from "@flows/journal"

const HOST_ID = hostname()

export const RUN_STATUS_TO_FLOWS = {
  "running": "running",
  "waiting-approval": "suspended",
  "waiting-event": "suspended",
  "waiting-timer": "suspended",
  "waiting-quota": "suspended",
  "paused": "suspended",
  "finished": "completed",
  "failed": "failed",
  "cancelled": "cancelled",
  "canceled": "cancelled",
  "continued": "completed"
}

export class UnsupportedShimOperation extends Error {
  constructor(message) {
    super(message)
    this.name = "UnsupportedShimOperation"
  }
}

export const parseRuntimeOwnerId = (runtimeOwnerId) => {
  const match = /^pid:(\d+):(.+)$/.exec(runtimeOwnerId)
  if (!match) {
    throw new UnsupportedShimOperation(`cannot map smithers runtimeOwnerId onto flows OwnerId: ${runtimeOwnerId}`)
  }
  return { hostId: HOST_ID, pid: Number(match[1]), nonce: match[2] }
}

export const formatRuntimeOwnerId = (owner) => owner === null ? null : `pid:${owner.pid}:${owner.nonce}`

const sameOwnerId = (owner, runtimeOwnerId) => formatRuntimeOwnerId(owner) === runtimeOwnerId

const OWNERLESS_STATE_KEYS = new Set([
  "parentRunId",
  "workflowName",
  "workflowPath",
  "workflowHash",
  "cancelRequestedAtMs",
  "cancelRequestId",
  "cancelRequestSource",
  "cancelRequestClientIdentity",
  "cancelRequestClientPid",
  "pauseRequestedAtMs",
  "hijackRequestedAtMs",
  "hijackTarget",
  "vcsType",
  "vcsRoot",
  "vcsRevision",
  "errorJson",
  "configJson",
  "claimedBy"
])

const SMITHERS_STATE_KEY = "smithers"

const readSmithersState = (stateJson) => {
  const parsed = JSON.parse(stateJson)
  return parsed[SMITHERS_STATE_KEY] ?? {}
}

const writeStateJson = (stateJson, smithersState) => {
  const parsed = JSON.parse(stateJson)
  parsed[SMITHERS_STATE_KEY] = smithersState
  return JSON.stringify(parsed)
}

const toSmithersRunRow = (row) => {
  const state = readSmithersState(row.stateJson)
  return {
    runId: row.runId,
    parentRunId: state.parentRunId ?? null,
    workflowName: state.workflowName ?? "",
    workflowPath: state.workflowPath ?? null,
    workflowHash: state.workflowHash ?? null,
    status: state.smithersStatus ??
      (row.status === "suspended" ? "paused" : row.status === "completed" ? "finished" : row.status),
    createdAtMs: row.createdAtMs,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs,
    heartbeatAtMs: row.heartbeatAtMs,
    runtimeOwnerId: formatRuntimeOwnerId(row.owner),
    cancelRequestedAtMs: state.cancelRequestedAtMs ?? null,
    cancelRequestId: state.cancelRequestId ?? null,
    cancelRequestSource: state.cancelRequestSource ?? null,
    cancelRequestClientIdentity: state.cancelRequestClientIdentity ?? null,
    cancelRequestClientPid: state.cancelRequestClientPid ?? null,
    pauseRequestedAtMs: state.pauseRequestedAtMs ?? null,
    hijackRequestedAtMs: state.hijackRequestedAtMs ?? null,
    hijackTarget: state.hijackTarget ?? null,
    vcsType: state.vcsType ?? null,
    vcsRoot: state.vcsRoot ?? null,
    vcsRevision: state.vcsRevision ?? null,
    errorJson: state.errorJson ?? null,
    configJson: state.configJson ?? null,
    claimedBy: state.claimedBy ?? (row.claim === null ? null : formatRuntimeOwnerId(row.claim)),
    claimedAtMs: row.claimedAtMs,
    _flows: { status: row.status, claim: row.claim, stateJson: row.stateJson }
  }
}

const livenessEvidenceFor = (expectedOwner, nowMs) => ({
  kind: expectedOwner.hostId === HOST_ID ? "same-host-pid-dead" : "cross-host-unreachable",
  expectedOwner,
  checkedAtMs: nowMs
})

const throwMapped = (method) => (cause) => {
  if (cause instanceof UnsupportedShimOperation) throw cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(`flows run shim ${method}: ${message}`)
  error.cause = cause
  throw error
}

/**
 * SmithersDb run-ownership methods implemented on @flows/journal RunStore.
 * Plain JSON in, plain JSON out; nothing effect-shaped escapes.
 *
 * Field mapping notes:
 *  - flows_runs has no cancel attribution (5 cols), pauseRequestedAtMs,
 *    hijack pair, vcs triple, configJson, parentRunId, or workflow identity
 *    columns. They live in flows_runs.state_json under the "smithers" key.
 *    SQL queryability on those fields is lost (json_extract possible but no
 *    index, and no participation in flows' fenced CAS guards).
 *  - flows' claim/activate assumes the claimant becomes the owner. Smithers'
 *    supervisor-claim-then-engine-owns handoff (patch.runtimeOwnerId different
 *    from the claim owner) has no flows equivalent and throws
 *    UnsupportedShimOperation.
 */
export const createRunOwnershipShim = (boundary) => {
  let storePromise
  const getStore = () => storePromise ??= boundary.run(RunStore.make)
  let dbPromise
  const getDb = () => dbPromise ??= boundary.run(Effect.service(Database.Database))

  const getRunRow = async (runId) => {
    const store = await getStore()
    try {
      return await boundary.run(store.get(runId))
    } catch (cause) {
      if (cause?.code === "not_found_row") return undefined
      throwMapped("get")(cause)
    }
  }

  const insertRun = async (row) => {
    try {
      const smithersState = { smithersStatus: row.status }
      for (const key of Object.keys(row)) {
        if (OWNERLESS_STATE_KEYS.has(key)) smithersState[key] = row[key] ?? null
      }
      const flowsStatus = RUN_STATUS_TO_FLOWS[row.status] ?? "pending"
      const stateJson = JSON.stringify({ [SMITHERS_STATE_KEY]: smithersState })
      const store = await getStore()
      await boundary.run(store.create(row.runId, stateJson))
      if (flowsStatus === "pending") return true
      if (flowsStatus !== "running") {
        throw new UnsupportedShimOperation(
          `insertRun: flows RunStore.create only admits 'pending'; cannot insert run directly as '${row.status}'`
        )
      }
      const owner = parseRuntimeOwnerId(row.runtimeOwnerId)
      const claimAtMs = row.heartbeatAtMs ?? Date.now()
      const pendingSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }
      const claimOutcome = await boundary.run(store.claim(row.runId, pendingSnapshot, owner, claimAtMs))
      if (claimOutcome._tag !== "Claimed") {
        throw new Error(`insertRun claim failed: ${claimOutcome._tag}`)
      }
      const activateOutcome = await boundary.run(store.activate(row.runId, owner, claimOutcome.claimedAtMs, pendingSnapshot))
      if (activateOutcome._tag !== "Activated") {
        throw new Error(`insertRun activate failed: ${activateOutcome._tag}`)
      }
      if (row.startedAtMs != null || row.heartbeatAtMs != null) {
        const db = await getDb()
        await boundary.run(
          db.write(
            db.sql`UPDATE flows_runs SET started_at_ms = ${row.startedAtMs ?? null}, heartbeat_at_ms = ${row.heartbeatAtMs ?? null} WHERE run_id = ${row.runId}`
          )
        )
      }
      return true
    } catch (cause) {
      throwMapped("insertRun")(cause)
    }
  }

  const getRun = async (runId) => {
    const row = await getRunRow(runId)
    return row === undefined ? undefined : toSmithersRunRow(row)
  }

  const heartbeatRun = async (runId, runtimeOwnerId, heartbeatAtMs) => {
    try {
      const store = await getStore()
      const outcome = await boundary.run(store.heartbeat(runId, parseRuntimeOwnerId(runtimeOwnerId), heartbeatAtMs))
      if (outcome._tag === "NotFound") throw new Error(`run ${runId} not found`)
      return outcome._tag === "Updated" ? 1 : 0
    } catch (cause) {
      throwMapped("heartbeatRun")(cause)
    }
  }

  const listStaleRunningRuns = async (staleBeforeMs, limit = 1000) => {
    try {
      const db = await getDb()
      const rows = await boundary.run(db.sql`
        SELECT run_id AS "runId", heartbeat_at_ms AS "heartbeatAtMs",
               owner_host_id AS "ownerHostId", owner_pid AS "ownerPid", owner_nonce AS "ownerNonce",
               status AS "status", state_json AS "stateJson"
        FROM flows_runs
        WHERE status = 'running' AND (heartbeat_at_ms IS NULL OR heartbeat_at_ms < ${staleBeforeMs})
        ORDER BY COALESCE(heartbeat_at_ms, 0) ASC
        LIMIT ${limit}
      `)
      return rows.map((row) => ({
        runId: row.runId,
        workflowPath: readSmithersState(row.stateJson).workflowPath ?? null,
        heartbeatAtMs: row.heartbeatAtMs,
        runtimeOwnerId: row.ownerHostId === null ? null : `pid:${row.ownerPid}:${row.ownerNonce}`,
        status: readSmithersState(row.stateJson).smithersStatus ?? row.status
      }))
    } catch (cause) {
      throwMapped("listStaleRunningRuns")(cause)
    }
  }

  const claimRunForResume = async (params) => {
    try {
      const expectedStatus = params.expectedStatus ?? "running"
      const flowsExpectedStatus = RUN_STATUS_TO_FLOWS[expectedStatus] ?? "pending"
      const expectedOwner = params.expectedRuntimeOwnerId === null
        ? null
        : parseRuntimeOwnerId(params.expectedRuntimeOwnerId)
      const claimant = parseRuntimeOwnerId(params.claimOwnerId)
      const expected = {
        status: flowsExpectedStatus,
        owner: expectedOwner,
        heartbeatAtMs: params.expectedHeartbeatAtMs
      }
      const store = await getStore()
      if (flowsExpectedStatus === "running") {
        if (expectedOwner === null) return false
        const outcome = await boundary.run(
          store.steal(params.runId, expected, claimant, params.claimHeartbeatAtMs, livenessEvidenceFor(expectedOwner, params.claimHeartbeatAtMs))
        )
        return outcome._tag === "Claimed"
      }
      const outcome = await boundary.run(store.claim(params.runId, expected, claimant, params.claimHeartbeatAtMs))
      return outcome._tag === "Claimed"
    } catch (cause) {
      throwMapped("claimRunForResume")(cause)
    }
  }

  const releaseRunResumeClaim = async (params) => {
    try {
      const row = await getRunRow(params.runId)
      if (row === undefined || row.claim === null || row.claimedAtMs === null) return
      if (!sameOwnerId(row.claim, params.claimOwnerId)) return
      const store = await getStore()
      await boundary.run(store.abandonClaim(params.runId, row.claim, row.claimedAtMs))
    } catch (cause) {
      throwMapped("releaseRunResumeClaim")(cause)
    }
  }

  const mergeStatePatch = (row, patch) => {
    const state = readSmithersState(row.stateJson)
    for (const [key, value] of Object.entries(patch)) {
      if (key === "status") {
        state.smithersStatus = value
      } else if (key === "claimedAtMs") {
        continue
      } else if (OWNERLESS_STATE_KEYS.has(key)) {
        state[key] = value
      } else if (key === "startedAtMs" || key === "finishedAtMs" || key === "heartbeatAtMs" || key === "runtimeOwnerId") {
        continue
      } else {
        throw new UnsupportedShimOperation(`updateClaimedRun: no home in flows_runs for patch key '${key}'`)
      }
    }
    return writeStateJson(row.stateJson, state)
  }

  const updateClaimedRun = async (params) => {
    try {
      const row = await getRunRow(params.runId)
      if (row === undefined) return false
      const stateJson = mergeStatePatch(row, params.patch)
      const patchStatus = typeof params.patch.status === "string" ? params.patch.status : undefined
      const targetFlowsStatus = patchStatus === undefined ? row.status : RUN_STATUS_TO_FLOWS[patchStatus]
      if (targetFlowsStatus === undefined) {
        throw new UnsupportedShimOperation(`updateClaimedRun: cannot map status '${patchStatus}' onto flows RunStatus`)
      }
      const store = await getStore()

      // Claim-held path: the expected "owner" is actually the claim holder.
      if (row.claim !== null && sameOwnerId(row.claim, params.expectedRuntimeOwnerId)) {
        if (targetFlowsStatus !== "running") {
          throw new UnsupportedShimOperation(
            "updateClaimedRun: a claim-held update can only activate to 'running' in flows"
          )
        }
        if (params.patch.runtimeOwnerId !== undefined && params.patch.runtimeOwnerId !== params.expectedRuntimeOwnerId) {
          throw new UnsupportedShimOperation(
            "updateClaimedRun: flows claim/activate requires the claimant to become the owner; " +
              `patch transfers ownership to '${params.patch.runtimeOwnerId}'`
          )
        }
        const outcome = await boundary.run(
          store.activate(params.runId, row.claim, row.claimedAtMs, {
            status: row.status,
            owner: row.owner,
            heartbeatAtMs: row.heartbeatAtMs
          })
        )
        if (outcome._tag !== "Activated") return false
        const db = await getDb()
        await boundary.run(
          db.write(
            db.sql`UPDATE flows_runs SET state_json = ${stateJson}, started_at_ms = COALESCE(${params.patch.startedAtMs ?? null}, started_at_ms), heartbeat_at_ms = COALESCE(${params.patch.heartbeatAtMs ?? null}, heartbeat_at_ms) WHERE run_id = ${params.runId}`
          )
        )
        return true
      }

      // Owned path.
      if (!sameOwnerId(row.owner, params.expectedRuntimeOwnerId)) return false
      const hasClaimGuard = Object.prototype.hasOwnProperty.call(params, "expectedClaimedBy") ||
        Object.prototype.hasOwnProperty.call(params, "expectedClaimedAtMs")
      if (hasClaimGuard) {
        const claimedBy = formatRuntimeOwnerId(row.claim)
        if (claimedBy !== (params.expectedClaimedBy ?? null)) return false
        if ((row.claimedAtMs ?? null) !== (params.expectedClaimedAtMs ?? null)) return false
      }
      if (row.status !== "running") {
        throw new UnsupportedShimOperation(
          `updateClaimedRun: flows transitionOwned requires status 'running', row is '${row.status}'`
        )
      }
      const owner = parseRuntimeOwnerId(params.expectedRuntimeOwnerId)
      const outcome = await boundary.run(store.transitionOwned(params.runId, owner, targetFlowsStatus, stateJson))
      if (outcome._tag !== "Transitioned") return false
      if (params.patch.heartbeatAtMs !== undefined && targetFlowsStatus === "running") {
        const store2 = await getStore()
        await boundary.run(store2.heartbeat(params.runId, owner, params.patch.heartbeatAtMs))
      }
      return true
    } catch (cause) {
      throwMapped("updateClaimedRun")(cause)
    }
  }

  const completeRun = async (runId, runtimeOwnerId, finishedAtMs) => {
    try {
      const row = await getRunRow(runId)
      if (row === undefined) return false
      if (!sameOwnerId(row.owner, runtimeOwnerId) || row.status !== "running") return false
      const state = readSmithersState(row.stateJson)
      if (state.cancelRequestedAtMs != null) return false
      state.smithersStatus = "finished"
      state.cancelRequestedAtMs = null
      state.hijackRequestedAtMs = null
      state.hijackTarget = null
      const store = await getStore()
      const outcome = await boundary.run(
        store.transitionOwned(runId, parseRuntimeOwnerId(runtimeOwnerId), "completed", writeStateJson(row.stateJson, state))
      )
      return outcome._tag === "Transitioned"
    } catch (cause) {
      throwMapped("completeRun")(cause)
    }
  }

  return {
    insertRun,
    getRun,
    heartbeatRun,
    listStaleRunningRuns,
    claimRunForResume,
    releaseRunResumeClaim,
    updateClaimedRun,
    completeRun
  }
}
