import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
