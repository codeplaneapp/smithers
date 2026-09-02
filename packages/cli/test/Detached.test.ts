/**
 * `smithers up -d`, driven against real child processes.
 *
 * The 0.x requirements carried forward
 * (`apps/cli/tests/detached-launch-admission.e2e.test.js` and
 * `detached-admission-timeout.test.js`): a launch returns only after the child
 * proves it persisted the run row, a child that dies first is reported as a
 * failed launch with its output attached, and a child that is alive but silent
 * past the grace window is terminated rather than left running.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"
import * as Project from "../src/Project.ts"

const staged: Array<string> = []

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-detached-"))
  staged.push(root)
  return root
}

/**
 * A stand-in for the `smithers run` child: a script that behaves the way one
 * behaves, without booting an engine. `entry` replaces the CLI entry point, so
 * `launch` still spawns a real detached process and still polls a real log.
 */
const child = (body: string): string => {
  const root = project()
  const file = join(root, "child.mjs")
  writeFileSync(file, body, "utf8")
  return file
}

const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as { readonly code?: string } | null)?.code === "ESRCH") return true
    throw error
  }
}

const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the admission line", () => {
  it("round-trips the nonce and the run id", () => {
    const line = Detached.admissionLine("nonce-1", "run-42")

    expect(line).toBe("SMITHERS_DETACHED_ADMISSION=run:nonce-1 runId=run-42")
    expect(Detached.admittedRunId(`noise\n${line}\nmore`, "nonce-1")).toBe("run-42")
  })

  it("ignores a line stamped with another launcher's nonce", () => {
    expect(Detached.admittedRunId(Detached.admissionLine("other", "run-42"), "nonce-1")).toBeUndefined()
    expect(Detached.admittedRunId("", "nonce-1")).toBeUndefined()
  })

  it("ignores a truncated line with no run id", () => {
    expect(Detached.admittedRunId("SMITHERS_DETACHED_ADMISSION=run:nonce-1 runId=", "nonce-1")).toBeUndefined()
  })

  it("reads a run id at the very end of the log", () => {
    expect(Detached.admittedRunId("SMITHERS_DETACHED_ADMISSION=run:n runId=run-9", "n")).toBe("run-9")
  })
})

describe("the log tail", () => {
  it("is empty for a file that is not there", () => {
    expect(Detached.logTail(join(project(), "absent.log"))).toBe("")
  })

  it("returns the last bytes of a long file", () => {
    const file = join(project(), "long.log")
    writeFileSync(file, "abcdefghij", "utf8")

    expect(Detached.logTail(file, 4)).toBe("ghij")
    expect(Detached.logTail(file)).toBe("abcdefghij")
  })
})

describe("launching", () => {
  it("returns the run id and renames the log onto it", async () => {
    const root = project()
    const entry = child(
      `process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-7\\n")
       setTimeout(() => {}, 200)`
    )

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    expect(Detached.isLaunched(result)).toBe(true)
    const launched = result as Detached.Launched
    expect(launched.runId).toBe("run-7")
    expect(launched.logFile).toBe(Project.logFile(root, "run-7"))
    expect(readFileSync(launched.logFile, "utf8")).toContain("runId=run-7")
    expect(typeof launched.pid).toBe("number")
  }, 30_000)

  it("reports a child that exited before admission, with its output", async () => {
    const root = project()
    const entry = child(`process.stderr.write("no seat configured\\n"); process.exit(3)`)

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    // A launcher that returned a run id here would report a run for a process
    // that is already dead, and the operator would find out from an empty `ps`.
    expect(Detached.isLaunched(result)).toBe(false)
    const rejected = result as Detached.Rejected
    expect(rejected.reason).toContain("exited before admission (exit 3)")
    expect(rejected.tail).toContain("no seat configured")
    expect(existsSync(rejected.logFile)).toBe(true)

    Detached.discard(rejected)
    expect(existsSync(rejected.logFile)).toBe(false)
    // Discarding a log that is already gone is not an error.
    expect(() => Detached.discard(rejected)).not.toThrow()
  }, 30_000)

  it("terminates a child that is alive but silent past the grace window", async () => {
    const root = project()
    const entry = child(`setInterval(() => {}, 1000)`)
    const notices: Array<string> = []

    const result = await Detached.launch({
      root,
      payload: "{}",
      entry,
      timeoutMs: 150,
      intervalMs: 10,
      onSlowBoot: (message) => notices.push(message)
    })

    expect(Detached.isLaunched(result)).toBe(false)
    const rejected = result as Detached.Rejected
    expect(rejected.reason).toContain("did not reach admission within 600ms")
    expect(rejected.reason).toContain("was still alive and was terminated")
    expect(rejected.reason).toContain("SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS")
    // The slow-boot notice fires once, when the grace window opens: a loaded
    // machine can spend the whole first window on module parse.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("still booting")
  }, 30_000)

  it.skipIf(process.platform === "win32")("kills a SIGTERM-trapping child and its descendant", async () => {
    const root = project()
    const entry = child(
      `import { spawn } from "node:child_process"
       process.on("SIGTERM", () => {})
       const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
       process.stderr.write("parent=" + process.pid + " descendant=" + descendant.pid + "\\n")
       setInterval(() => {}, 1000)`
    )

    const result = await Detached.launch({
      root,
      payload: "{}",
      entry,
      timeoutMs: 500,
      intervalMs: 10,
      terminationGraceMs: 150
    })

    expect(Detached.isLaunched(result)).toBe(false)
    const rejected = result as Detached.Rejected
    expect(rejected.reason).toContain("was terminated")
    expect(rejected.reason).not.toContain("could not be confirmed terminated")

    const tail = Detached.logTail(rejected.logFile)
    const pids = /parent=(\d+) descendant=(\d+)/.exec(tail)
    expect(pids).not.toBeNull()
    if (pids === null) throw new Error(`detached log did not contain both pids: ${tail}`)
    const parentPid = Number(pids[1])
    const descendantPid = Number(pids[2])

    const [parentGone, descendantGone, groupGone] = await Promise.all([
      until(() => processGone(parentPid), 2_000),
      until(() => processGone(descendantPid), 2_000),
      until(() => processGone(-parentPid), 2_000)
    ])
    expect(parentGone).toBe(true)
    expect(descendantGone).toBe(true)
    expect(groupGone).toBe(true)
  }, 30_000)

  it("passes the operator's extra arguments through to the child", async () => {
    const root = project()
    const entry = child(
      `process.stderr.write(process.argv.slice(2).join(" ") + "\\n")
       process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-8\\n")`
    )

    const result = await Detached.launch({
      root,
      payload: "{\"plan\":1}",
      passthrough: ["--remote", "https://control.test"],
      entry,
      intervalMs: 10
    })

    const launched = result as Detached.Launched
    expect(readFileSync(launched.logFile, "utf8")).toContain("run {\"plan\":1} --remote https://control.test")
  }, 30_000)

  it("supersedes a previous run's log instead of destroying it when the run id collides", async () => {
    const root = project()
    const previous = Project.logFile(root, "run-collision")
    const directory = Project.logDirectory(root)
    mkdirSync(directory, { recursive: true })
    writeFileSync(previous, "previous run output\n", "utf8")
    const entry = child(
      `process.stderr.write("new run output\\n")
       process.stderr.write("SMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-collision\\n")`
    )

    const result = await Detached.launch({ root, payload: "{}", entry, intervalMs: 10 })

    expect(Detached.isLaunched(result)).toBe(true)
    // The receipt still names the canonical path, so `up -d` reports the same
    // file it always did and the new run's output is the whole of it.
    const log = readFileSync(previous, "utf8")
    expect(log).toContain("new run output")
    expect(log).not.toContain("previous run output")
    // The earlier run's output survives beside it. Renaming over the path was
    // silent, unrecoverable evidence loss: the log of a run an operator is
    // still diagnosing is the one thing `up -d` writes that nothing else
    // holds a copy of.
    const superseded = readdirSync(directory).filter((name) => name.startsWith("run-collision.superseded-"))
    expect(superseded).toHaveLength(1)
    expect(readFileSync(join(directory, superseded[0]!), "utf8")).toContain("previous run output")
  }, 30_000)

  it("defaults the admission window to thirty seconds", () => {
    expect(Detached.defaultTimeoutMs).toBe(30_000)
    expect(Detached.admissionVariable).toBe("SMITHERS_INTERNAL_DETACHED_ADMISSION")
  })
})
