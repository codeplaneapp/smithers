import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { RunRecordSchema, TargetRunEventSchema } from "smithers-shared/TargetGraph"
import type { RunRecord, RunReplayResponse, TargetRunEvent } from "smithers-shared/TargetGraph"
import type { TargetRun } from "./Targets"

type HistoryLine = { readonly type: "record"; readonly record: RunRecord } | { readonly type: "event"; readonly event: TargetRunEvent }

interface StoredRun {
  record: RunRecord
  events: Array<TargetRunEvent>
  readonly path: string
  queue: Promise<void>
  /** Retained stdout/stderr characters, kept under MAX_RETAINED_LOG_CHARS. */
  logChars: number
}

export interface TargetRunHistory {
  readonly start: (run: TargetRun) => Promise<void>
  readonly event: (run: TargetRun, event: TargetRunEvent) => void
  readonly list: (repoId: string, repo: string) => Promise<ReadonlyArray<RunRecord>>
  readonly replay: (runId: string, repos?: ReadonlyArray<{ readonly id: string; readonly path: string }>) => Promise<RunReplayResponse | undefined>
}

/*
 * The in-memory cap on one run's retained stdout/stderr. The .jsonl journal on
 * disk keeps every byte; this bounds the heap, because `runs` holds every run
 * of the process and a chatty node emits megabytes. The TAIL is what a human
 * reads, so eviction drops the OLDEST log frames and never a structured frame
 * (started/node/summary/exit/error), which the timeline and overlay need whole.
 */
export const MAX_RETAINED_LOG_CHARS = 1_000_000

const runsDir = (repo: string): string => join(repo, ".flows", "ui", "runs")
const encode = (line: HistoryLine): string => `${JSON.stringify(line)}\n`

const logChars = (event: TargetRunEvent): number =>
  event.type === "stdout" || event.type === "stderr" ? event.data.length : 0

/**
 * Drops the OLDEST log frames until the retained tail fits the cap. Structured
 * frames survive whatever the volume: the timeline, the overlay and the
 * critical path are derived from them, so evicting one would silently change
 * what a replay shows. Returns the events kept and their character count.
 */
const capLogs = (events: Array<TargetRunEvent>): { events: Array<TargetRunEvent>; logChars: number } => {
  let total = events.reduce((sum, event) => sum + logChars(event), 0)
  if (total <= MAX_RETAINED_LOG_CHARS) return { events, logChars: total }
  const kept: Array<TargetRunEvent> = []
  for (const event of events) {
    const size = logChars(event)
    if (size > 0 && total > MAX_RETAINED_LOG_CHARS) {
      total -= size
      continue
    }
    kept.push(event)
  }
  return { events: kept, logChars: total }
}

export const createTargetRunHistory = (): TargetRunHistory => {
  const runs = new Map<string, StoredRun>()
  /*
   * One load per repository, INCLUDING the one still in flight: two requests
   * for the same repo can land together, and answering the second from the
   * half-loaded map shows an empty history and 404s a replay for runs that
   * are on disk.
   */
  const loading = new Map<string, Promise<void>>()

  const loadRepo = (repoId: string, repo: string): Promise<void> => {
    const inFlight = loading.get(repo)
    if (inFlight !== undefined) return inFlight
    const promise = readRepo(repoId, repo)
    loading.set(repo, promise)
    return promise
  }

  const readRepo = async (repoId: string, repo: string): Promise<void> => {
    const dir = runsDir(repo)
    let names: Array<string>
    try { names = await readdir(dir) } catch { return }
    await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map(async (name) => {
      const path = join(dir, name)
      let text: string
      try { text = await readFile(path, "utf8") } catch { return }
      let record: RunRecord | undefined
      const events: Array<TargetRunEvent> = []
      for (const line of text.split(/\r?\n/)) {
        if (line === "") continue
        try {
          const parsed = JSON.parse(line) as { type?: unknown; record?: unknown; event?: unknown }
          if (parsed.type === "record") {
            const checked = RunRecordSchema.safeParse(parsed.record)
            if (checked.success && checked.data.repoId === repoId) record = checked.data
          } else if (parsed.type === "event") {
            const checked = TargetRunEventSchema.safeParse(parsed.event)
            if (checked.success) events.push(checked.data)
          }
        } catch { /* A partial final line after a crash is ignored. */ }
      }
      // A record that never settled belongs to a run that died with the
      // previous process; after a restart it can never finish, so report it
      // as failed instead of leaving it "running" forever.
      if (record !== undefined) {
        if (record.status === "pending" || record.status === "running") record = { ...record, status: "failed" }
        /* A journal on disk can be arbitrarily large; the heap copy is capped. */
        const capped = capLogs(events)
        runs.set(record.runId, { record, events: capped.events, path, queue: Promise.resolve(), logChars: capped.logChars })
      }
    }))
  }

  return {
    start: async (run) => {
      const dir = runsDir(run.repo)
      await mkdir(dir, { recursive: true })
      const record: RunRecord = {
        runId: run.runId, repoId: run.repoId, label: run.label, labels: [...run.labels], status: "pending", startedAt: run.startedAt
      }
      const path = join(dir, `${run.runId}.jsonl`)
      await writeFile(path, encode({ type: "record", record }))
      runs.set(run.runId, { record, events: [], path, queue: Promise.resolve(), logChars: 0 })
      /* The run just written is in `runs`; nothing on disk is still unseen. */
      if (!loading.has(run.repo)) loading.set(run.repo, Promise.resolve())
    },
    event: (run, event) => {
      const stored = runs.get(run.runId)
      if (stored === undefined) return
      stored.events.push(event)
      stored.logChars += logChars(event)
      if (stored.logChars > MAX_RETAINED_LOG_CHARS) {
        const capped = capLogs(stored.events)
        stored.events = capped.events
        stored.logChars = capped.logChars
      }
      if (event.type === "started") stored.record = { ...stored.record, status: "running" }
      else if (event.type === "summary") stored.record = { ...stored.record, summary: event.summary }
      else if (event.type === "exit") stored.record = {
        ...stored.record,
        status: event.code === 0 ? "done" : "failed",
        endedAt: Date.now(),
        exitCode: event.code
      }
      const line = encode({ type: "event", event }) + (event.type === "exit" ? encode({ type: "record", record: stored.record }) : "")
      stored.queue = stored.queue.then(() => appendFile(stored.path, line)).catch(() => {})
    },
    list: async (repoId, repo) => {
      await loadRepo(repoId, repo)
      const selected = [...runs.values()].filter((stored) => stored.record.repoId === repoId)
      await Promise.all(selected.map((stored) => stored.queue))
      return selected.map((stored) => stored.record).sort((a, b) => b.startedAt - a.startedAt)
    },
    replay: async (runId, repos = []) => {
      for (const repo of repos) await loadRepo(repo.id, repo.path)
      const stored = runs.get(runId)
      if (stored === undefined) return undefined
      await stored.queue
      const events = stored.events.map((event, index) => ({ event, index }))
        .sort((a, b) => (a.event.seq ?? a.index) - (b.event.seq ?? b.index) || a.index - b.index)
        .map(({ event }) => event)
      return { run: stored.record, events }
    }
  }
}
