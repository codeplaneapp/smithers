import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { deploy } from "./deploy.ts"

let directory: string

const script = (name: string): string => NodePath.join(directory, `${name}.mjs`)

const write = (name: string, body: string): Promise<void> =>
  writeFile(NodePath.join(directory, `${name}.mjs`), body, "utf8")

/** Runs `deploy` with only our own handler installed, then restores the rest. */
const withIsolatedSignals = async <A>(run: () => Promise<A>): Promise<A> => {
  const installed = ["SIGHUP", "SIGINT", "SIGTERM"].map(
    (signal) => [signal, process.listeners(signal as NodeJS.Signals)] as const
  )
  for (const [signal] of installed) process.removeAllListeners(signal)
  try {
    return await run()
  } finally {
    for (const [signal, listeners] of installed) {
      for (const listener of listeners) process.on(signal as NodeJS.Signals, listener)
    }
  }
}

beforeAll(async () => {
  directory = await mkdtemp(NodePath.join(tmpdir(), "smithers-deploy-"))
  await write("exit-zero", "process.exit(0)\n")
  await write("exit-seven", "process.exit(7)\n")
  // The wrapper spawns [cli, "deploy", "alchemy.run.ts", ...args], so the
  // marker path this stub reports through is argv[4].
  await write(
    "ignores-sigterm",
    `import { writeFileSync } from "node:fs"
const marker = process.argv[4]
process.on("SIGTERM", () => writeFileSync(marker + ".sigterm", "seen"))
process.on("SIGINT", () => writeFileSync(marker + ".sigint", "seen"))
setInterval(() => {}, 1000)
writeFileSync(marker + ".ready", "ready")
`
  )
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("deploy wrapper", () => {
  it("returns the command's exit code and redacts state afterwards", async () => {
    let redactions = 0
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const success = await deploy([], {
        cli: script("exit-zero"),
        cwd: directory,
        redact: async () => (redactions += 1, 3)
      })
      const failure = await deploy([], {
        cli: script("exit-seven"),
        cwd: directory,
        redact: async () => (redactions += 1, 0)
      })

      expect(success).toBe(0)
      expect(failure).toBe(7)
      // Redaction runs on the success path and on the failure path.
      expect(redactions).toBe(2)
      expect(stdout.mock.calls.map((call) => String(call[0]))).toContain(
        "Redacted 3 Alchemy Worker state file(s).\n"
      )
    } finally {
      stdout.mockRestore()
    }
  })

  it("fails the deployment when redaction fails, even after a successful command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await deploy([], {
        cli: script("exit-zero"),
        cwd: directory,
        redact: async () => {
          throw new Error("state directory is read-only")
        }
      })

      expect(code).toBe(1)
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "Alchemy state redaction failed: state directory is read-only"
      )
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("reports a command that could not be spawned without leaving redaction undone", async () => {
    let redactions = 0
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await deploy([], {
        cli: script("exit-zero"),
        cwd: NodePath.join(directory, "absent-directory"),
        redact: async () => (redactions += 1, 0)
      })

      expect(code).toBe(1)
      expect(redactions).toBe(1)
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("Alchemy deployment failed")
    } finally {
      stderr.mockRestore()
      stdout.mockRestore()
    }
  })

  it("escalates to SIGKILL when the command ignores the forwarded signal", async () => {
    const marker = NodePath.join(directory, "escalation")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    let redactions = 0
    try {
      const started = Date.now()
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          escalationDelayMs: 300,
          redact: async () => (redactions += 1, 0)
        })
        // Wait for the child to install its ignore handler. Signalling before
        // that would kill it outright and the assertions below would pass
        // without the escalation ever running.
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGTERM")
        return await running
      })

      // The child recorded the forwarded SIGTERM and stayed alive, so the only
      // thing that could have ended it is the SIGKILL escalation.
      expect(existsSync(`${marker}.sigterm`)).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(300)
      // 143 is the conventional 128 + SIGTERM, reported even though the
      // command itself died to the escalation.
      expect(code).toBe(143)
      expect(redactions).toBe(1)
      expect(process.listenerCount("SIGTERM")).toBe(0)
    } finally {
      stdout.mockRestore()
    }
  }, 30_000)

  it("maps SIGINT to its conventional exit code", async () => {
    const marker = NodePath.join(directory, "interrupt")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const code = await withIsolatedSignals(async () => {
        const running = deploy([marker], {
          cli: script("ignores-sigterm"),
          cwd: directory,
          escalationDelayMs: 300,
          redact: async () => 0
        })
        await vi.waitFor(() => expect(existsSync(`${marker}.ready`)).toBe(true), { timeout: 10_000 })
        process.emit("SIGINT")
        return await running
      })

      expect(existsSync(`${marker}.sigint`)).toBe(true)
      expect(code).toBe(130)
    } finally {
      stdout.mockRestore()
    }
  }, 30_000)
})
