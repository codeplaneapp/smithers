import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const fixture = fileURLToPath(new URL("./fixtures/run-store-file-fence-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))
const timeoutMs = 120_000

interface ChildHarness {
  readonly child: ChildProcessWithoutNullStreams
  readonly next: () => Promise<Record<string, unknown>>
  readonly send: (command: string) => void
  readonly stderr: () => string
}

const startChild = (role: "a" | "b", filename: string, runId: string): ChildHarness => {
  const child = spawn(process.execPath, [fixture, role, filename, runId], { cwd: repositoryRoot })
  const queued: Array<Record<string, unknown>> = []
  const waiting: Array<{
    readonly resolve: (value: Record<string, unknown>) => void
    readonly reject: (cause: unknown) => void
    readonly timeout: ReturnType<typeof setTimeout>
  }> = []
  let stdout = ""
  let stderr = ""

  const rejectWaiting = (cause: unknown) => {
    for (const waiter of waiting.splice(0)) {
      clearTimeout(waiter.timeout)
      waiter.reject(cause)
    }
  }

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
    while (true) {
      const newline = stdout.indexOf("\n")
      if (newline < 0) return
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (!line.startsWith("{")) continue
      const value = JSON.parse(line) as Record<string, unknown>
      const waiter = waiting.shift()
      if (waiter === undefined) queued.push(value)
      else {
        clearTimeout(waiter.timeout)
        waiter.resolve(value)
      }
    }
  })
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  child.once("error", rejectWaiting)
  child.once("exit", (code, signal) => {
    if (code !== 0) {
      rejectWaiting(new Error(`child ${role} exited with ${code ?? signal}\n${stderr}\n${stdout}`))
    }
  })

  return {
    child,
    next: () => {
      const value = queued.shift()
      if (value !== undefined) return Promise.resolve(value)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`child ${role} timed out\n${stderr}\n${stdout}`))
        }, timeoutMs)
        waiting.push({ resolve, reject, timeout })
      })
    },
    send: (command) => child.stdin.write(`${command}\n`),
    stderr: () => stderr
  }
}

const stopChild = async (harness: ChildHarness): Promise<void> => {
  if (harness.child.exitCode === null && harness.child.signalCode === null) {
    harness.child.kill("SIGKILL")
    await once(harness.child, "exit")
  }
}

const awaitChildExit = async (harness: ChildHarness): Promise<number | null> => {
  if (harness.child.exitCode !== null) return harness.child.exitCode
  const [code] = await once(harness.child, "exit")
  return code as number | null
}

describe("RunStore durable file fencing", () => {
  it("admits exactly one stale-lease owner and refuses every fenced loser write across processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flows-run-store-fence-"))
    const filename = join(directory, "run-store.sqlite")
    const runId = "file-fence-run"
    const children: Array<ChildHarness> = []
    try {
      const left = startChild("a", filename, runId)
      children.push(left)
      expect(await left.next()).toMatchObject({
        phase: "ready",
        role: "a",
        admission: { _tag: "Activated" },
        put: { _tag: "Inserted" }
      })

      const right = startChild("b", filename, runId)
      children.push(right)
      expect(await right.next()).toMatchObject({
        phase: "ready",
        role: "b",
        snapshot: { status: "running", heartbeatAtMs: 0 }
      })

      left.send("go")
      right.send("go")
      const [leftRace, rightRace] = await Promise.all([left.next(), right.next()])
      expect(leftRace).toMatchObject({ phase: "race", role: "a" })
      expect(rightRace).toMatchObject({ phase: "race", role: "b" })

      left.send("verify")
      right.send("verify")
      const [leftVerified, rightVerified] = await Promise.all([left.next(), right.next()])
      const ownerNonces = [leftVerified, rightVerified].map((value) =>
        (value.row as { readonly owner: { readonly nonce: string } }).owner.nonce
      )
      expect(new Set(ownerNonces).size).toBe(1)
      expect(ownerNonces[0]).toMatch(/^owner-[ab]$/)

      const winnerRole = ownerNonces[0] === "owner-a" ? "a" : "b"
      const winner = winnerRole === "a" ? leftVerified : rightVerified
      const loser = winnerRole === "a" ? rightVerified : leftVerified
      expect(winner).toMatchObject({
        phase: "verified",
        role: winnerRole,
        heartbeat: { _tag: "Updated" },
        transition: { _tag: "Transitioned" },
        put: { _tag: "Inserted" },
        finish: { _tag: "Finished" },
        row: { status: "running", claim: null }
      })
      expect(loser).toMatchObject({
        phase: "verified",
        heartbeat: { _tag: "FenceLost" },
        transition: { _tag: "FenceLost" },
        put: { _tag: "FenceLost" },
        finish: { _tag: "FenceLost" }
      })

      if (winnerRole === "a") {
        expect(leftRace).toMatchObject({ heartbeat: { _tag: "Updated" } })
      } else {
        expect(leftRace).toMatchObject({ heartbeat: { _tag: "FenceLost" } })
        expect(rightRace).toMatchObject({
          steal: { _tag: "Claimed" },
          activate: { _tag: "Activated" }
        })
      }

      await Promise.all(children.map(async (harness) => {
        const code = await awaitChildExit(harness)
        expect(code, harness.stderr()).toBe(0)
      }))
    } finally {
      await Promise.all(children.map(stopChild))
      await rm(directory, { recursive: true, force: true })
    }
  }, timeoutMs)
})
