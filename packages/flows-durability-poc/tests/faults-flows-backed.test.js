import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure"
import { deriveRunState } from "@smithers-orchestrator/db/runState/deriveRunState"
import { FlowsBackedSmithersDb } from "../src/flows-backed-db.js"

const STALE_THRESHOLD_MS = 30_000

const instances = []

function buildFlowsBackedDb() {
  const sqlite = new Database(":memory:")
  const db = drizzle(sqlite)
  ensureSmithersTables(db)
  const adapter = new FlowsBackedSmithersDb(db)
  instances.push({ sqlite, adapter })
  return { sqlite, adapter }
}

function corruptFlowsHeartbeat(sqlite, runId, mode) {
  const now = Date.now()
  const heartbeatAtMs = mode === "stale" ? now - 10 * STALE_THRESHOLD_MS : mode === "missing" ? null : now + 3_600_000
  sqlite.query("UPDATE flows_runs SET heartbeat_at_ms = ? WHERE run_id = ?").run(heartbeatAtMs, runId)
}

async function seedStaleRunningRun(adapter, runId, ownerId, now) {
  const heartbeatAtMs = now - 10 * STALE_THRESHOLD_MS
  await adapter.insertRun({
    runId,
    workflowName: "case-workflow",
    status: "running",
    createdAtMs: heartbeatAtMs - 5_000,
    startedAtMs: heartbeatAtMs - 5_000,
    heartbeatAtMs,
    runtimeOwnerId: ownerId
  })
}

afterEach(async () => {
  for (const { sqlite, adapter } of instances.splice(0)) {
    await adapter.disposeFlows()
    sqlite.close()
  }
})

describe("case 01 (flows-backed): kill engine mid-task — stale discovery + exclusive takeover", () => {
  test("killed engine -> orphaned within SLO; supervisor takeover is exclusive", async () => {
    const { adapter, sqlite } = buildFlowsBackedDb()
    const runId = "flows-case01-run"
    const originalOwnerId = "pid:99999:engine-victim"
    const now = Date.now()
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now)

    const staleRun = await adapter.getRun(runId)
    const stale = deriveRunState({ run: staleRun, staleThresholdMs: STALE_THRESHOLD_MS })
    expect(stale.state).toBe("orphaned")
    expect(stale.unhealthy?.kind).toBe("engine-heartbeat-stale")

    const claimHeartbeatAtMs = Date.now()
    const staleBeforeMs = claimHeartbeatAtMs - STALE_THRESHOLD_MS
    const staleRows = await adapter.listStaleRunningRuns(staleBeforeMs)
    expect(staleRows).toEqual([
      expect.objectContaining({ runId, runtimeOwnerId: originalOwnerId, status: "running" })
    ])

    const supervisorOwnerId = "supervisor:case01-takeover"
    const firstClaim = await adapter.claimRunForResume({
      runId,
      expectedRuntimeOwnerId: staleRun.runtimeOwnerId,
      expectedHeartbeatAtMs: staleRun.heartbeatAtMs,
      staleBeforeMs,
      claimOwnerId: supervisorOwnerId,
      claimHeartbeatAtMs
    })
    expect(firstClaim).toBe(true)

    const secondClaim = await adapter.claimRunForResume({
      runId,
      expectedRuntimeOwnerId: staleRun.runtimeOwnerId,
      expectedHeartbeatAtMs: staleRun.heartbeatAtMs,
      staleBeforeMs,
      claimOwnerId: "supervisor:would-be-double-resume",
      claimHeartbeatAtMs
    })
    expect(secondClaim).toBe(false)

    const afterClaim = await adapter.getRun(runId)
    expect(afterClaim.runtimeOwnerId).toBe(supervisorOwnerId)
    expect(afterClaim.heartbeatAtMs).toBe(claimHeartbeatAtMs)
  })
})

describe("case 06 (flows-backed): concurrent resume vs supervisor takeover", () => {
  const claimStale = (adapter, runId, snapshot, claimOwnerId, claimHeartbeatAtMs, now) =>
    Promise.resolve(
      adapter.claimRunForResume({
        runId,
        expectedStatus: "running",
        expectedRuntimeOwnerId: snapshot.owner,
        expectedHeartbeatAtMs: snapshot.heartbeat,
        staleBeforeMs: now - STALE_THRESHOLD_MS,
        claimOwnerId,
        claimHeartbeatAtMs,
        requireStale: true
      })
    )

  test("CAS: exactly one of (resume, supervisor) wins", async () => {
    const { adapter } = buildFlowsBackedDb()
    const runId = "flows-case06-run"
    const originalOwnerId = "pid:11111:engine-victim"
    const now = Date.now()
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now)
    const seen = await adapter.getRun(runId)
    const snapshot = { owner: seen?.runtimeOwnerId ?? null, heartbeat: seen?.heartbeatAtMs ?? null }

    const resumeClaimed = await claimStale(adapter, runId, snapshot, "resume-cli:case06", now, now)
    const supervisorClaimed = await claimStale(adapter, runId, snapshot, "supervisor:case06", now + 1, now)

    expect([resumeClaimed, supervisorClaimed].filter(Boolean).length).toBe(1)
    expect(resumeClaimed).toBe(true)
    expect(supervisorClaimed).toBe(false)

    const row = await adapter.getRun(runId)
    expect(row?.runtimeOwnerId).toBe("resume-cli:case06")
  })

  test("supervisor wins when it swaps first; resume is fenced out", async () => {
    const { adapter } = buildFlowsBackedDb()
    const runId = "flows-case06-supervisor-first"
    const originalOwnerId = "pid:22222:engine-victim"
    const now = Date.now()
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now)
    const seen = await adapter.getRun(runId)
    const snapshot = { owner: seen?.runtimeOwnerId ?? null, heartbeat: seen?.heartbeatAtMs ?? null }

    const supervisorClaimed = await claimStale(adapter, runId, snapshot, "supervisor:case06b", now, now)
    const resumeClaimed = await claimStale(adapter, runId, snapshot, "resume-cli:case06b", now + 1, now)

    expect(supervisorClaimed).toBe(true)
    expect(resumeClaimed).toBe(false)

    const row = await adapter.getRun(runId)
    expect(row?.runtimeOwnerId).toBe("supervisor:case06b")
  })

  test("post-takeover writes are fenced: only the winning owner can heartbeat", async () => {
    const { adapter } = buildFlowsBackedDb()
    const runId = "flows-case06-fence"
    const originalOwnerId = "pid:33333:engine-victim"
    const now = Date.now()
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now)
    const seen = await adapter.getRun(runId)
    const snapshot = { owner: seen?.runtimeOwnerId ?? null, heartbeat: seen?.heartbeatAtMs ?? null }

    const resumerOwnerId = "resume-cli:case06c"
    const supervisorOwnerId = "supervisor:case06c"

    expect(await claimStale(adapter, runId, snapshot, resumerOwnerId, now, now)).toBe(true)
    expect(await claimStale(adapter, runId, snapshot, supervisorOwnerId, now + 1, now)).toBe(false)

    const afterClaim = await adapter.getRun(runId)
    expect(afterClaim?.runtimeOwnerId).toBe(resumerOwnerId)
    const heartbeatAfterClaim = afterClaim?.heartbeatAtMs ?? null

    await adapter.heartbeatRun(runId, supervisorOwnerId, now + 1_000)
    expect((await adapter.getRun(runId))?.heartbeatAtMs).toBe(heartbeatAfterClaim)

    await adapter.heartbeatRun(runId, originalOwnerId, now + 2_000)
    expect((await adapter.getRun(runId))?.heartbeatAtMs).toBe(heartbeatAfterClaim)

    const winnerBumpAtMs = now + 3_000
    await adapter.heartbeatRun(runId, resumerOwnerId, winnerBumpAtMs)
    const finalRow = await adapter.getRun(runId)
    expect(finalRow?.runtimeOwnerId).toBe(resumerOwnerId)
    expect(finalRow?.heartbeatAtMs).toBe(winnerBumpAtMs)
  })
})

describe("case 31 style (flows-backed): attempt terminal CAS survives kill+resume ownership change", () => {
  test("the deposed owner's terminal claim loses; the resumed owner's wins", async () => {
    const { adapter } = buildFlowsBackedDb()
    const runId = "flows-case31-run"
    const originalOwnerId = "pid:44444:engine-victim"
    const now = Date.now()
    await seedStaleRunningRun(adapter, runId, originalOwnerId, now)

    await adapter.insertAttempt({
      runId,
      nodeId: "task-1",
      iteration: 0,
      attempt: 1,
      state: "in-progress",
      startedAtMs: now - 5_000,
      heartbeatAtMs: now - 10 * STALE_THRESHOLD_MS,
      heartbeatDataJson: null,
      errorJson: null,
      jjPointer: null,
      responseText: null,
      jjCwd: null,
      cached: false,
      metaJson: JSON.stringify({ agentId: "claude", agentResume: "session-x" }),
      runtimeOwnerId: originalOwnerId
    })

    const resumeOwnerId = "pid:55555:engine-resumer"
    const claimed = await adapter.claimRunForResume({
      runId,
      expectedStatus: "running",
      expectedRuntimeOwnerId: originalOwnerId,
      expectedHeartbeatAtMs: now - 10 * STALE_THRESHOLD_MS,
      staleBeforeMs: now - STALE_THRESHOLD_MS,
      claimOwnerId: resumeOwnerId,
      claimHeartbeatAtMs: now,
      requireStale: true
    })
    expect(claimed).toBe(true)
    const activated = await adapter.updateClaimedRun({
      runId,
      expectedRuntimeOwnerId: resumeOwnerId,
      expectedHeartbeatAtMs: now,
      patch: { status: "running", runtimeOwnerId: resumeOwnerId, heartbeatAtMs: now }
    })
    expect(activated).toBe(true)

    // Deposed owner's in-flight terminal write loses the fence.
    expect(await adapter.claimAttemptTerminal(runId, "task-1", 0, 1, originalOwnerId, "finished", now + 1)).toBe(false)
    // The resumed owner claims the terminal exactly once.
    expect(await adapter.claimAttemptTerminal(runId, "task-1", 0, 1, resumeOwnerId, "failed", now + 2, "{\"killed\":true}")).toBe(true)
    expect(await adapter.claimAttemptTerminal(runId, "task-1", 0, 1, resumeOwnerId, "finished", now + 3)).toBe(false)

    const attempts = await adapter.listAttempts(runId, "task-1", 0)
    expect(attempts.length).toBe(1)
    expect(attempts[0].state).toBe("failed")
    expect(JSON.parse(attempts[0].metaJson).agentResume).toBe("session-x")

    // Journal events recorded by both owners keep one gapless seq clock.
    expect(await adapter.insertEventWithNextSeq({ runId, timestampMs: now - 100, type: "task_started", payloadJson: "{\"nodeId\":\"task-1\"}" })).toBe(0)
    expect(await adapter.insertEventWithNextSeq({ runId, timestampMs: now + 2, type: "task_finished", payloadJson: "{\"nodeId\":\"task-1\"}" })).toBe(1)
    expect((await adapter.listEventHistory(runId)).map((e) => e.seq)).toEqual([0, 1])
  })
})
