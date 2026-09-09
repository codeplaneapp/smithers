import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cancelMarker, hostKillScript, killScript } from "../src/internal/killScript.ts"

/** Run the emitted script against inert stat files; never signal a real pid. */
const collect = (parents: ReadonlyArray<readonly [number, number]>, host: boolean) => {
  const directory = mkdtempSync(join(tmpdir(), "smthrs-kill-tree-"))
  try {
    const proc = join(directory, "proc")
    const pidfile = join(directory, "command.pid")
    const reads = join(directory, "reads")
    const signals = join(directory, "signals")
    const collected = join(directory, "collected")
    mkdirSync(proc)
    writeFileSync(pidfile, "1\n")
    writeFileSync(reads, "")
    for (const [pid, parent] of parents) {
      mkdirSync(join(proc, String(pid)))
      // The last closing parenthesis, not the first, ends the comm field.
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (worker ) with spaces) S ${parent} 0 0\n`)
    }
    const script = (host
      ? hostKillScript(1, "TERM").replace("command -v pgrep >/dev/null 2>&1", "false")
      : killScript(pidfile, "TERM")).replaceAll("/proc/", `${proc}/`)
    const result = spawnSync("/bin/sh", [
      "-c",
      // Count executed reads, including those inside command substitutions.
      // The kill stub records how many completed before the first signal.
      `read() { printf 'read\n' >> '${reads}'; command read "$@"; }; ` +
      `kill() { wc -l < '${reads}' > '${collected}'; printf '%s\n' "$@" >> '${signals}'; return 0; }; ` +
      script
    ], { encoding: "utf8", timeout: 30_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    expect(existsSync(cancelMarker(pidfile))).toBe(!host)
    const statReads = readFileSync(reads, "utf8").trim().split("\n").length
    expect(Number(readFileSync(collected, "utf8").trim())).toBe(statReads)
    const args = readFileSync(signals, "utf8").trim().split("\n")
    expect(args.slice(0, 2)).toEqual(["-s", "TERM"])
    return { statReads, pids: args.slice(2).map(Number) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe.each([false, true])("/proc collection (host fallback: %s)", (host) => {
  it.each([50, 100, 200])("reads each of %i visible processes only once", (count) => {
    const parents = Array.from({ length: count }, (_, index) => [index + 1, index === 0 ? 0 : 1] as const)
    const { pids, statReads } = collect(parents, host)
    expect(pids).toHaveLength(count)
    expect(new Set(pids)).toEqual(new Set(parents.map(([pid]) => pid)))
    expect(pids.at(-1)).toBe(1)
    expect(statReads).toBe(count)
  })

  it("walks a deep subtree without recursive shells", () => {
    const count = 1_000
    const parents = Array.from({ length: count }, (_, index) => [index + 1, index] as const)
    const { pids, statReads } = collect(parents, host)
    expect(pids).toEqual(Array.from({ length: count }, (_, index) => count - index))
    expect(statReads).toBe(count)
  }, 30_000)

  it("collects only the target subtree, with every child before its parent", () => {
    const parents = [[1, 0], [2, 1], [3, 2], [4, 2], [5, 1], [6, 5], [7, 0], [8, 7]] as const
    const { pids, statReads } = collect(parents, host)
    expect(pids).toHaveLength(6)
    expect(new Set(pids)).toEqual(new Set([1, 2, 3, 4, 5, 6]))
    for (const [pid, parent] of parents.slice(1, 6)) {
      expect(pids.indexOf(pid)).toBeLessThan(pids.indexOf(parent))
    }
    expect(statReads).toBe(parents.length)
  })
})
