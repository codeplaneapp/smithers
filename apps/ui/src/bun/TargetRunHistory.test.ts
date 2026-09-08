import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunHistoryResponseSchema, RunReplayResponseSchema } from "@smthrs/rpc/TargetGraph"
import { createTargetRunHistory } from "./TargetRunHistory"
import type { TargetRun } from "./Targets"

test("run history persists and reloads ordered events", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-1", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
  history.event(run, { type: "node", node: { label: "//:test", status: "ran", durationMs: 10 }, at: 110 })
  history.event(run, { type: "summary", summary: { total: 1, hit: 0, ran: 1, failed: 0, skipped: 0, durationMs: 10, ok: true, criticalPath: ["//:test"] }, at: 110 })
  history.event(run, { type: "exit", code: 0 })
  expect((await history.list("repo-1", repo))[0]).toMatchObject({ runId: "run-1", status: "done", exitCode: 0 })

  const reloaded = createTargetRunHistory()
  const listed = await reloaded.list("repo-1", repo)
  expect(listed).toHaveLength(1)
  const replay = await reloaded.replay("run-1")
  expect(replay?.events.map((event) => event.type)).toEqual(["started", "node", "summary", "exit"])
  expect(replay?.run.summary?.criticalPath).toEqual(["//:test"])
  await rm(repo, { recursive: true, force: true })
})

test("a run interrupted by a restart reloads as failed, not stuck running", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-2", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
  await history.list("repo-1", repo) // flush the event queue; no exit frame follows (crash)

  const reloaded = createTargetRunHistory()
  const listed = await reloaded.list("repo-1", repo)
  expect(listed).toHaveLength(1)
  expect(listed[0]).toMatchObject({ runId: "run-2", status: "failed" })
  const replay = await reloaded.replay("run-2")
  expect(replay?.run.status).toBe("failed")
  expect(replay?.events.map((event) => event.type)).toEqual(["started"])
  await rm(repo, { recursive: true, force: true })
})

test("replay orders every frame by its run-local sequence", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  const run: TargetRun = { runId: "run-seq", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
  const history = createTargetRunHistory()
  await history.start(run)
  history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100, seq: 0 })
  history.event(run, { type: "exit", code: 0, seq: 2 })
  history.event(run, { type: "stdout", data: "hello", seq: 1 })
  const replay = await history.replay(run.runId)
  expect(replay?.events.map((event) => event.seq)).toEqual([0, 1, 2])
  await rm(repo, { recursive: true, force: true })
})

test("a failed terminal append reports degraded durability and agrees with the durable bytes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "append-failure", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const logs: Array<string> = []
    const history = createTargetRunHistory({ log: (line) => logs.push(line) })
    await history.start(run)
    const path = join(repo, ".flows", "ui", "runs", `${run.runId}.jsonl`)
    await rename(path, `${path}.saved`)
    await mkdir(path) // EISDIR, even when tests run with elevated permissions.
    history.event(run, { type: "exit", code: 0 })
    const replay = RunReplayResponseSchema.parse(await history.replay(run.runId))
    expect(replay.run.journal).toMatchObject({ state: "degraded", error: expect.stringContaining("EISDIR") })
    expect(replay.run.status).toBe("failed")
    expect(replay.run.exitCode).toBeUndefined()
    expect(replay.events).toEqual([])
    const listed = RunHistoryResponseSchema.parse({ runs: await history.list(run.repoId, repo) })
    expect(listed.runs[0]).toEqual(replay.run)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain(run.runId)
    expect(logs[0]).toContain("EISDIR")
    await expect(history.flush()).rejects.toThrow("Target run journal append failed")

    await rm(path, { recursive: true })
    await rename(`${path}.saved`, path)
    const restored = await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: repo }])
    expect(restored?.run.journal?.state).toBe("degraded")
    expect(restored?.run.status).toBe(replay.run.status)
    expect(restored?.run.exitCode).toBeUndefined()
    expect(restored?.events).toEqual(replay.events)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test("the first failed append stops durable acknowledgements without blocking other runs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "smithers-history-"))
  try {
    const run: TargetRun = { runId: "gap", repoId: "repo-1", repo, workspace: ".", label: "//:test", labels: ["//:test"], status: "running", exitCode: null, startedAt: 100 }
    const other = { ...run, runId: "healthy" }
    const logs: Array<string> = []
    const history = createTargetRunHistory({ log: (line) => logs.push(line) })
    await history.start(run)
    await history.start(other)
    history.event(run, { type: "started", runId: run.runId, label: run.label, labels: [...run.labels], at: 100 })
    history.event(run, { type: "summary", summary: { total: 1, hit: 0, ran: 1, failed: 0, skipped: 0, durationMs: 10, ok: true, criticalPath: [run.label] }, at: 110 })
    await history.flush()
    const path = join(repo, ".flows", "ui", "runs", `${run.runId}.jsonl`)
    const durable = await readFile(path, "utf8")
    await rename(path, `${path}.saved`)
    await mkdir(path)
    history.event(run, { type: "stdout", data: "lost" })
    history.event(run, { type: "exit", code: 0 })
    const degraded = RunReplayResponseSchema.parse(await history.replay(run.runId))
    await rm(path, { recursive: true })
    await rename(`${path}.saved`, path)
    // Repairing the path must not allow later frames to conceal the gap.
    history.event(run, { type: "exit", code: 0 })
    history.event(other, { type: "exit", code: 0 })
    await expect(history.flush()).rejects.toThrow("Target run journal append failed")
    expect(await history.replay(run.runId)).toEqual(degraded)
    expect(await readFile(path, "utf8")).toBe(durable)
    expect(logs).toHaveLength(1)
    const restored = await createTargetRunHistory().replay(run.runId, [{ id: run.repoId, path: repo }])
    expect(restored?.events).toEqual(degraded?.events)
    expect(restored?.run).toEqual({ ...degraded.run, journal: { state: "degraded", error: expect.any(String) } })
    expect((await history.replay(other.runId))?.run.status).toBe("done")
    expect((await createTargetRunHistory().replay(other.runId, [{ id: run.repoId, path: repo }]))?.run.status).toBe("done")
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
