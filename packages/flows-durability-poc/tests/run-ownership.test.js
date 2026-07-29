import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFlowsBoundary } from "../src/index.js"
import { createRunOwnershipShim, UnsupportedShimOperation } from "../src/run-ownership-shim.js"

const OWNER_A = "pid:1111:nonce-a"
const OWNER_B = "pid:2222:nonce-b"

let dir
let sqlite
let boundary
let shim

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "flows-poc-runs-"))
  sqlite = new BunSqliteDatabase(join(dir, "smithers.db"))
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA busy_timeout = 30000")
  sqlite.run("PRAGMA foreign_keys = ON")
  boundary = await createFlowsBoundary({ sqlite })
  shim = createRunOwnershipShim(boundary)
})

afterEach(async () => {
  await boundary.dispose()
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const insertRunningRun = (runId, owner = OWNER_A, overrides = {}) =>
  shim.insertRun({
    runId,
    parentRunId: null,
    workflowName: "wf",
    workflowPath: "/tmp/wf.tsx",
    workflowHash: "hash",
    status: "running",
    createdAtMs: 1000,
    startedAtMs: 1000,
    finishedAtMs: null,
    heartbeatAtMs: 1000,
    runtimeOwnerId: owner,
    cancelRequestedAtMs: null,
    pauseRequestedAtMs: null,
    hijackRequestedAtMs: null,
    hijackTarget: null,
    vcsType: "jj",
    vcsRoot: "/tmp/repo",
    vcsRevision: "abc",
    errorJson: null,
    configJson: "{\"x\":1}",
    ...overrides
  })

describe("step 2: run ownership shim on flows RunStore", () => {
  test("insertRun + getRun round-trips every smithers run field", async () => {
    await insertRunningRun("run-1")
    const row = await shim.getRun("run-1")
    expect(row.runId).toBe("run-1")
    expect(row.status).toBe("running")
    expect(row.runtimeOwnerId).toBe(OWNER_A)
    expect(row.heartbeatAtMs).toBe(1000)
    expect(row.startedAtMs).toBe(1000)
    expect(row.workflowName).toBe("wf")
    expect(row.workflowPath).toBe("/tmp/wf.tsx")
    expect(row.vcsType).toBe("jj")
    expect(row.vcsRevision).toBe("abc")
    expect(row.configJson).toBe("{\"x\":1}")
    expect(row.cancelRequestedAtMs).toBeNull()
    expect(row.pauseRequestedAtMs).toBeNull()
    expect(row.hijackRequestedAtMs).toBeNull()
  })

  test("getRun returns undefined for a missing run", async () => {
    expect(await shim.getRun("nope")).toBeUndefined()
  })

  test("heartbeatRun is fenced on the owner triple", async () => {
    await insertRunningRun("run-2")
    expect(await shim.heartbeatRun("run-2", OWNER_A, 2000)).toBe(1)
    expect((await shim.getRun("run-2")).heartbeatAtMs).toBe(2000)
    expect(await shim.heartbeatRun("run-2", OWNER_B, 3000)).toBe(0)
    expect((await shim.getRun("run-2")).heartbeatAtMs).toBe(2000)
  })

  test("listStaleRunningRuns returns only stale running runs", async () => {
    await insertRunningRun("run-stale", OWNER_A, { heartbeatAtMs: 100 })
    await insertRunningRun("run-fresh", OWNER_A, { heartbeatAtMs: 1_000_000 })
    const stale = await shim.listStaleRunningRuns(500)
    expect(stale.map((r) => r.runId)).toEqual(["run-stale"])
    expect(stale[0].runtimeOwnerId).toBe(OWNER_A)
    expect(stale[0].status).toBe("running")
  })

  test("claimRunForResume: exactly one of two competing claimants wins a stale run", async () => {
    await insertRunningRun("run-3", OWNER_A, { heartbeatAtMs: 100 })
    const nowMs = 100 + 30_000 + 1
    const first = await shim.claimRunForResume({
      runId: "run-3",
      expectedStatus: "running",
      expectedRuntimeOwnerId: OWNER_A,
      expectedHeartbeatAtMs: 100,
      staleBeforeMs: nowMs - 30_000,
      claimOwnerId: OWNER_B,
      claimHeartbeatAtMs: nowMs
    })
    expect(first).toBe(true)
    const second = await shim.claimRunForResume({
      runId: "run-3",
      expectedStatus: "running",
      expectedRuntimeOwnerId: OWNER_A,
      expectedHeartbeatAtMs: 100,
      staleBeforeMs: nowMs - 30_000,
      claimOwnerId: "pid:3333:nonce-c",
      claimHeartbeatAtMs: nowMs
    })
    expect(second).toBe(false)
  })

  test("claimRunForResume refuses a run with a fresh heartbeat", async () => {
    const nowMs = Date.now()
    await insertRunningRun("run-4", OWNER_A, { heartbeatAtMs: nowMs })
    const claimed = await shim.claimRunForResume({
      runId: "run-4",
      expectedStatus: "running",
      expectedRuntimeOwnerId: OWNER_A,
      expectedHeartbeatAtMs: nowMs,
      staleBeforeMs: nowMs - 30_000,
      claimOwnerId: OWNER_B,
      claimHeartbeatAtMs: nowMs + 1
    })
    expect(claimed).toBe(false)
  })

  test("releaseRunResumeClaim abandons the held claim so another claimant can take it", async () => {
    await insertRunningRun("run-5", OWNER_A, { heartbeatAtMs: 100 })
    const nowMs = 100 + 30_000 + 1
    expect(
      await shim.claimRunForResume({
        runId: "run-5",
        expectedStatus: "running",
        expectedRuntimeOwnerId: OWNER_A,
        expectedHeartbeatAtMs: 100,
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId: OWNER_B,
        claimHeartbeatAtMs: nowMs
      })
    ).toBe(true)
    await shim.releaseRunResumeClaim({
      runId: "run-5",
      claimOwnerId: OWNER_B,
      restoreRuntimeOwnerId: OWNER_A,
      restoreHeartbeatAtMs: 100
    })
    expect(
      await shim.claimRunForResume({
        runId: "run-5",
        expectedStatus: "running",
        expectedRuntimeOwnerId: OWNER_A,
        expectedHeartbeatAtMs: 100,
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId: "pid:3333:nonce-c",
        claimHeartbeatAtMs: nowMs
      })
    ).toBe(true)
  })

  test("claim → updateClaimedRun activates the run under the claimant; completeRun finishes it", async () => {
    await insertRunningRun("run-6", OWNER_A, { heartbeatAtMs: 100 })
    const nowMs = 100 + 30_000 + 1
    expect(
      await shim.claimRunForResume({
        runId: "run-6",
        expectedStatus: "running",
        expectedRuntimeOwnerId: OWNER_A,
        expectedHeartbeatAtMs: 100,
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId: OWNER_B,
        claimHeartbeatAtMs: nowMs
      })
    ).toBe(true)
    const activated = await shim.updateClaimedRun({
      runId: "run-6",
      expectedRuntimeOwnerId: OWNER_B,
      expectedHeartbeatAtMs: nowMs,
      patch: {
        status: "running",
        startedAtMs: 1000,
        finishedAtMs: null,
        heartbeatAtMs: nowMs,
        runtimeOwnerId: OWNER_B,
        cancelRequestedAtMs: null,
        pauseRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        workflowPath: "/tmp/wf.tsx",
        workflowHash: "hash2",
        vcsType: "jj",
        vcsRoot: "/tmp/repo",
        vcsRevision: "def",
        errorJson: null,
        configJson: "{\"x\":2}"
      }
    })
    expect(activated).toBe(true)
    const row = await shim.getRun("run-6")
    expect(row.status).toBe("running")
    expect(row.runtimeOwnerId).toBe(OWNER_B)
    expect(row.workflowHash).toBe("hash2")
    expect(row.vcsRevision).toBe("def")
    expect(row.configJson).toBe("{\"x\":2}")
    expect(await shim.completeRun("run-6", OWNER_A, nowMs + 5)).toBe(false)
    expect(await shim.completeRun("run-6", OWNER_B, nowMs + 5)).toBe(true)
    const finished = await shim.getRun("run-6")
    expect(finished.status).toBe("finished")
    expect(finished.runtimeOwnerId).toBeNull()
  })

  test("updateClaimedRun owned-path state patch participates in cancel guard of completeRun", async () => {
    await insertRunningRun("run-7")
    const patched = await shim.updateClaimedRun({
      runId: "run-7",
      expectedRuntimeOwnerId: OWNER_A,
      expectedHeartbeatAtMs: 1000,
      patch: { cancelRequestedAtMs: 5000 }
    })
    expect(patched).toBe(true)
    expect((await shim.getRun("run-7")).cancelRequestedAtMs).toBe(5000)
    expect(await shim.completeRun("run-7", OWNER_A, 6000)).toBe(false)
  })

  test("insertRun directly into a suspended-mapped status is unsupported by flows", async () => {
    await expect(insertRunningRun("run-8", OWNER_A, { status: "paused", runtimeOwnerId: null })).rejects.toThrow(
      /only admits 'pending'/
    )
  })

  test("claim-held ownership transfer to a third party is rejected honestly", async () => {
    await insertRunningRun("run-9", OWNER_A, { heartbeatAtMs: 100 })
    const nowMs = 100 + 30_000 + 1
    expect(
      await shim.claimRunForResume({
        runId: "run-9",
        expectedStatus: "running",
        expectedRuntimeOwnerId: OWNER_A,
        expectedHeartbeatAtMs: 100,
        staleBeforeMs: nowMs - 30_000,
        claimOwnerId: OWNER_B,
        claimHeartbeatAtMs: nowMs
      })
    ).toBe(true)
    await expect(
      shim.updateClaimedRun({
        runId: "run-9",
        expectedRuntimeOwnerId: OWNER_B,
        expectedHeartbeatAtMs: nowMs,
        patch: { status: "running", runtimeOwnerId: "pid:3333:nonce-c" }
      })
    ).rejects.toThrow(UnsupportedShimOperation)
  })
})
