/** State and cursor must commit together across real process death, not just Effect interruption. */
import { describe, expect, it } from "@effect/vitest"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/snapshot-consumer-child.ts", import.meta.url))
const timeoutMs = 30_000
const runId = "durable-snapshot-consumer"
const cursor = (afterSeq: number) => ({ generation: 0, runId, afterSeq })

const start = (phase: string, directory: string) => {
  const child = spawn(process.execPath, [fixture, phase, directory])
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
    child.once("error", () => resolve({ code: -1, signal: null }))
  })
  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${phase} barrier: ${stderr}\n${stdout}`)), timeoutMs)
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(error)
    }
    child.once("error", fail)
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const end = stdout.indexOf("\n")
      if (end < 0) return
      clearTimeout(timer)
      try {
        resolve(JSON.parse(stdout.slice(0, end)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    child.once("exit", (code, signal) => fail(new Error(`Child exited ${code ?? signal}: ${stderr}\n${stdout}`)))
  })
  return { child, message, exited, stderr: () => stderr }
}

const awaitExit = async (exited: ReturnType<typeof start>["exited"]) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Consumer did not exit within 5 seconds")), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const kill = async (child: ChildProcessWithoutNullStreams, exited: ReturnType<typeof start>["exited"]) => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  return await awaitExit(exited)
}

const readDurable = (directory: string) => {
  const db = new DatabaseSync(join(directory, "consumer.sqlite"))
  try {
    return {
      count: Number(db.prepare("SELECT count FROM projection WHERE id=1").get()!.count),
      seq: Number(db.prepare("SELECT seq FROM cursor WHERE id=1").get()!.seq),
      integrity: db.prepare("PRAGMA integrity_check").get()!.integrity_check
    }
  } finally {
    db.close()
  }
}

const retainedSequences = (directory: string) => {
  const db = new DatabaseSync(join(directory, "journal.sqlite"), { readOnly: true })
  try {
    return db.prepare("SELECT seq FROM flows_journal_events WHERE run_id=? ORDER BY seq").all(runId)
      .map((row) => Number(row.seq))
  } finally {
    db.close()
  }
}

describe("snapshot application survives consumer SIGKILL", () => {
  for (const phase of ["snapshot-state", "snapshot-cursor", "snapshot-committed", "suffix-committed"] as const) {
    it(`recovers without loss or duplicate application after ${phase}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "sync-snapshot-crash-"))
      const children: Array<ReturnType<typeof start>> = []
      try {
        const first = start(phase, directory)
        children.push(first)
        const barrier = await first.message
        const committed = phase === "snapshot-committed" || phase === "suffix-committed"
        const suffix = phase === "suffix-committed"
        expect(barrier).toEqual({
          phase,
          state: { count: suffix ? 28 : 17, seq: phase === "snapshot-state" ? -1 : suffix ? 4 : 3 },
          cursors: suffix ? [cursor(3)] : []
        })
        expect(await kill(first.child, first.exited)).toEqual({ code: null, signal: "SIGKILL" })
        const durable = { count: suffix ? 28 : committed ? 17 : 0, seq: suffix ? 4 : committed ? 3 : -1 }
        expect(readDurable(directory)).toEqual({ ...durable, integrity: "ok" })
        // Compaction deletes strictly below its checkpoint, retaining the
        // checkpoint entry as the allocation floor. The missing 0..2 prefix
        // cannot secretly supply the state needed on restart.
        expect(retainedSequences(directory)).toEqual([3, 4, 5])

        const restarted = start("finish", directory)
        children.push(restarted)
        const complete = await restarted.message
        expect(await awaitExit(restarted.exited), restarted.stderr()).toEqual({ code: 0, signal: null })
        // Independent full-history oracle: no snapshot or cursor arithmetic.
        const reference = [2, 3, 5, 7, 11, 13].reduce((sum, increment) => sum + increment, 0)
        expect(complete).toEqual({
          phase: "complete",
          initial: durable,
          state: { count: reference, seq: 5 },
          cursors: [cursor(5)],
          snapshots: committed ? 0 : 1,
          applied: suffix ? [5] : [4, 5],
          delivered: suffix ? [5] : [4, 5],
          retained: [4, 5],
          privateOnWire: false
        })
        expect(readDurable(directory)).toEqual({ count: reference, seq: 5, integrity: "ok" })
      } finally {
        await Promise.all(children.map(({ child, exited }) => kill(child, exited)))
        await rm(directory, { recursive: true, force: true })
      }
    }, timeoutMs * 2)
  }
})
