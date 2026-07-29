import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFlowsBoundary } from "../src/index.js"
import { createRunOwnershipShim } from "../src/run-ownership-shim.js"
import { createAttemptShim, stepKeyDigestFor } from "../src/attempt-shim.js"

const OWNER_A = "pid:1111:nonce-a"
const OWNER_B = "pid:2222:nonce-b"

let dir
let sqlite
let boundary
let runs
let attempts

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "flows-poc-attempts-"))
  sqlite = new BunSqliteDatabase(join(dir, "smithers.db"))
  sqlite.run("PRAGMA journal_mode = WAL")
  sqlite.run("PRAGMA busy_timeout = 30000")
  sqlite.run("PRAGMA foreign_keys = ON")
  boundary = await createFlowsBoundary({ sqlite })
  runs = createRunOwnershipShim(boundary)
  attempts = createAttemptShim(boundary)
  await runs.insertRun({
    runId: "run-1",
    workflowName: "wf",
    status: "running",
    createdAtMs: 1000,
    startedAtMs: 1000,
    heartbeatAtMs: 1000,
    runtimeOwnerId: OWNER_A
  })
})

afterEach(async () => {
  await boundary.dispose()
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const insertInProgress = (nodeId = "task-a", attempt = 1, overrides = {}) =>
  attempts.insertAttempt({
    runId: "run-1",
    nodeId,
    iteration: 0,
    attempt,
    state: "in-progress",
    startedAtMs: 2000,
    heartbeatAtMs: 2000,
    heartbeatDataJson: null,
    errorJson: null,
    jjPointer: null,
    responseText: null,
    jjCwd: null,
    cached: false,
    metaJson: JSON.stringify({
      agentId: "claude",
      agentModel: "opus",
      agentEngine: "claude-code",
      agentResume: "session-123",
      agentConversation: [{ role: "user", content: "hi" }],
      prompt: "do the thing"
    }),
    runtimeOwnerId: OWNER_A,
    ...overrides
  })

describe("step 3: attempts shim on flows AttemptStore", () => {
  test("insertAttempt + getAttempt round-trips smithers fields, agent meta by name", async () => {
    await insertInProgress()
    const row = await attempts.getAttempt("run-1", "task-a", 0, 1)
    expect(row.nodeId).toBe("task-a")
    expect(row.iteration).toBe(0)
    expect(row.state).toBe("in-progress")
    expect(row.startedAtMs).toBe(2000)
    const meta = JSON.parse(row.metaJson)
    expect(meta.agentId).toBe("claude")
    expect(meta.agentResume).toBe("session-123")
    expect(meta.agentConversation).toEqual([{ role: "user", content: "hi" }])
    expect(meta.prompt).toBe("do the thing")
    expect(meta.smithers).toBeUndefined()
    const digest = stepKeyDigestFor("run-1", "task-a", 0)
    const raw = sqlite.query("SELECT step_key_digest FROM flows_attempts WHERE run_id = 'run-1'").get()
    expect(raw.step_key_digest).toBe(digest)
  })

  test("insertAttempt is fenced: a non-owner cannot admit an attempt", async () => {
    await expect(insertInProgress("task-x", 1, { runtimeOwnerId: OWNER_B })).rejects.toThrow(/fence lost/i)
  })

  test("conflicting re-insert of the same attempt is honestly rejected (flows first-writer-wins)", async () => {
    await insertInProgress()
    await expect(insertInProgress("task-a", 1, { startedAtMs: 9999 })).rejects.toThrow(/first-writer-wins/)
  })

  test("heartbeatAttempt carries the agent session checkpoint and is owner-fenced", async () => {
    await insertInProgress()
    const checkpoint = JSON.stringify({ agentEngine: "claude-code", agentResume: "session-123", turn: 3 })
    expect(await attempts.heartbeatAttempt("run-1", "task-a", 0, 1, 3000, checkpoint, OWNER_A)).toBe(true)
    expect(await attempts.heartbeatAttempt("run-1", "task-a", 0, 1, 3001, checkpoint, OWNER_B)).toBe(false)
    const row = await attempts.getAttempt("run-1", "task-a", 0, 1)
    expect(row.heartbeatAtMs).toBe(3000)
    expect(JSON.parse(row.heartbeatDataJson)).toEqual({ agentEngine: "claude-code", agentResume: "session-123", turn: 3 })
  })

  test("heartbeatAttempt refuses a terminal attempt (state guard)", async () => {
    await insertInProgress()
    expect(await attempts.claimAttemptTerminal("run-1", "task-a", 0, 1, OWNER_A, "finished", 4000)).toBe(true)
    expect(await attempts.heartbeatAttempt("run-1", "task-a", 0, 1, 5000, null, OWNER_A)).toBe(false)
  })

  test("claimAttemptTerminal CAS: first terminal wins, owner-fenced", async () => {
    await insertInProgress()
    expect(await attempts.claimAttemptTerminal("run-1", "task-a", 0, 1, OWNER_B, "failed", 4000, "{\"e\":1}")).toBe(false)
    expect(await attempts.claimAttemptTerminal("run-1", "task-a", 0, 1, OWNER_A, "failed", 4000, "{\"e\":1}")).toBe(true)
    expect(await attempts.claimAttemptTerminal("run-1", "task-a", 0, 1, OWNER_A, "finished", 4001)).toBe(false)
    const row = await attempts.getAttempt("run-1", "task-a", 0, 1)
    expect(row.state).toBe("failed")
    expect(row.finishedAtMs).toBe(4000)
    expect(row.errorJson).toBe("{\"e\":1}")
    expect(JSON.parse(row.metaJson).agentResume).toBe("session-123")
  })

  test("updateAttempt patches responseText/jj fields into meta without touching agent keys", async () => {
    await insertInProgress()
    expect(
      await attempts.updateAttempt("run-1", "task-a", 0, 1, {
        responseText: "the full agent response",
        jjPointer: "jj-op-abc",
        jjCwd: "/tmp/repo",
        cached: true
      })
    ).toBe(1)
    const row = await attempts.getAttempt("run-1", "task-a", 0, 1)
    expect(row.responseText).toBe("the full agent response")
    expect(row.jjPointer).toBe("jj-op-abc")
    expect(row.jjCwd).toBe("/tmp/repo")
    expect(row.cached).toBe(true)
    const meta = JSON.parse(row.metaJson)
    expect(meta.agentResume).toBe("session-123")
    expect(row.state).toBe("in-progress")
  })

  test("updateAttempt rejects unfenced terminal patching", async () => {
    await insertInProgress()
    await expect(attempts.updateAttempt("run-1", "task-a", 0, 1, { state: "failed" })).rejects.toThrow(
      /no unfenced path/
    )
  })

  test("listAttempts returns newest first across attempts and nodes", async () => {
    await insertInProgress("task-a", 1)
    await insertInProgress("task-a", 2, { startedAtMs: 2100 })
    await insertInProgress("task-b", 1)
    const list = await attempts.listAttempts("run-1", "task-a", 0)
    expect(list.map((r) => r.attempt)).toEqual([2, 1])
    expect((await attempts.listAttempts("run-1", "task-b", 0)).length).toBe(1)
    expect((await attempts.listAttempts("run-1", "task-c", 0)).length).toBe(0)
  })

  test("checkpoint cap: agent session payloads over 1 MiB cannot be durably recorded", async () => {
    await insertInProgress()
    const huge = JSON.stringify({ agentResume: "x".repeat(1024 * 1024 + 10) })
    await expect(attempts.heartbeatAttempt("run-1", "task-a", 0, 1, 3000, huge, OWNER_A)).rejects.toThrow(/1|checkpoint/i)
  })
})
