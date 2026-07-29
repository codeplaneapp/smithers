import { SmithersDb } from "@smithers-orchestrator/db/adapter"
import { createFlowsBoundary } from "./index.js"
import { createRunOwnershipShim } from "./run-ownership-shim.js"
import { createAttemptShim } from "./attempt-shim.js"
import { createJournalShim } from "./journal-shim.js"

const resolveRawHandle = (db) => {
  const client = db?.$client ?? db?.session?.client
  if (!client || typeof client.query !== "function") {
    throw new TypeError("FlowsBackedSmithersDb requires a drizzle bun:sqlite database")
  }
  return client
}

/**
 * A SmithersDb whose 16 run-ownership / attempt / journal-event methods are
 * backed by the vendored flows durability stack (flows_runs, flows_attempts,
 * flows_journal_events) instead of smithers' own tables. Every other method
 * falls through to the real adapter against the same sqlite file.
 *
 * The flows side shares the adapter's bun:sqlite handle, so a smithers
 * withTransaction covering both smithers_* and flows_* writes is one SQLite
 * transaction (see src/v4client.js).
 */
export class FlowsBackedSmithersDb extends SmithersDb {
  constructor(db) {
    super(db)
    const sqlite = resolveRawHandle(db)
    this._flowsBoundaryPromise = createFlowsBoundary({ sqlite, runMigrations: true })
    this._flowsShimsPromise = this._flowsBoundaryPromise.then((boundary) => ({
      boundary,
      runs: createRunOwnershipShim(boundary),
      attempts: createAttemptShim(boundary),
      journal: createJournalShim(boundary)
    }))
  }

  async disposeFlows() {
    const { boundary } = await this._flowsShimsPromise
    await boundary.dispose()
  }

  _runs() {
    return this._flowsShimsPromise.then((s) => s.runs)
  }

  _attempts() {
    return this._flowsShimsPromise.then((s) => s.attempts)
  }

  _journal() {
    return this._flowsShimsPromise.then((s) => s.journal)
  }

  insertRun(row) {
    return this.write("flows insert run", () => this._runs().then((s) => s.insertRun(row)))
  }

  heartbeatRun(runId, runtimeOwnerId, heartbeatAtMs) {
    return this.write("flows heartbeat run", () =>
      this._runs().then((s) => s.heartbeatRun(runId, runtimeOwnerId, heartbeatAtMs)))
  }

  getRun(runId) {
    return this.read("flows get run", () => this._runs().then((s) => s.getRun(runId)))
  }

  listStaleRunningRuns(staleBeforeMs, limit = 1000) {
    return this.read("flows list stale running runs", () =>
      this._runs().then((s) => s.listStaleRunningRuns(staleBeforeMs, limit)))
  }

  claimRunForResume(params) {
    return this.write("flows claim run for resume", () => this._runs().then((s) => s.claimRunForResume(params)))
  }

  releaseRunResumeClaim(params) {
    return this.write("flows release run resume claim", () =>
      this._runs().then((s) => s.releaseRunResumeClaim(params)))
  }

  updateClaimedRun(params) {
    return this.write("flows update claimed run", () => this._runs().then((s) => s.updateClaimedRun(params)))
  }

  completeRun(runId, runtimeOwnerId, finishedAtMs) {
    return this.write("flows complete run", () =>
      this._runs().then((s) => s.completeRun(runId, runtimeOwnerId, finishedAtMs)))
  }

  insertAttempt(row) {
    return this.write("flows insert attempt", () => this._attempts().then((s) => s.insertAttempt(row)))
  }

  updateAttempt(runId, nodeId, iteration, attempt, patch) {
    return this.write("flows update attempt", () =>
      this._attempts().then((s) => s.updateAttempt(runId, nodeId, iteration, attempt, patch)))
  }

  heartbeatAttempt(runId, nodeId, iteration, attempt, heartbeatAtMs, heartbeatDataJson, runtimeOwnerId) {
    return this.write("flows heartbeat attempt", () =>
      this._attempts().then((s) =>
        s.heartbeatAttempt(runId, nodeId, iteration, attempt, heartbeatAtMs, heartbeatDataJson, runtimeOwnerId)
      ))
  }

  listAttempts(runId, nodeId, iteration) {
    return this.read("flows list attempts", () => this._attempts().then((s) => s.listAttempts(runId, nodeId, iteration)))
  }

  claimAttemptTerminal(runId, nodeId, iteration, attempt, runtimeOwnerId, state, finishedAtMs, errorJson) {
    return this.write("flows claim attempt terminal", () =>
      this._attempts().then((s) =>
        s.claimAttemptTerminal(runId, nodeId, iteration, attempt, runtimeOwnerId, state, finishedAtMs, errorJson)
      ))
  }

  insertEventWithNextSeq(row) {
    return this.write("flows insert event with next seq", () =>
      this._journal().then((s) => s.insertEventWithNextSeq(row)))
  }

  getLastEventSeq(runId) {
    return this.read("flows get last event seq", () => this._journal().then((s) => s.getLastEventSeq(runId)))
  }

  listEventHistory(runId, query = {}) {
    return this.read("flows list event history", () => this._journal().then((s) => s.listEventHistory(runId, query)))
  }
}
