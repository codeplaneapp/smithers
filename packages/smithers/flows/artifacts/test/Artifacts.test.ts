import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { runWithDeadline } from "./RunWithDeadline.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitUntilGone = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true
    await new Promise((resume) => setTimeout(resume, 50))
  }
  return !isRunning(pid)
}

describe("built artifacts", () => {
  it(
    "preserves constructor identity between root and subpath exports",
    async () => {
      // Every child carries its own deadline. The `it()` budget below is an
      // overall bound only: a synchronous child blocks the worker event loop,
      // so Vitest's timer cannot fire and a wedged build would hang the gate
      // rather than fail it. These deadlines sum under that budget.
      await runWithDeadline(process.execPath, ["scripts/build.mjs"], {
        cwd: packageRoot,
        timeoutMs: 120_000
      })
      await runWithDeadline(process.execPath, ["test/fixtures/artifact-esm.mjs"], {
        cwd: packageRoot,
        timeoutMs: 20_000
      })
      await runWithDeadline(process.execPath, ["test/fixtures/artifact-cjs.cjs"], {
        cwd: packageRoot,
        timeoutMs: 20_000
      })
    },
    // This case runs a real build and two cold Node processes. It is 2.8 s on
    // an idle machine but was measured at 33.8 s when the other workspaces
    // built concurrently — the same ~12x load multiplier the package
    // `testTimeout` budgets for. Still finite so a wedged build fails.
    180_000
  )

  it(
    "fails a wedged build within its deadline and kills the process tree",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "flows-artifacts-deadline-"))
      const pidFile = join(scratch, "grandchild.pid")
      try {
        // The fixture stays alive for two minutes, so only the deadline can
        // end this call — and it must end it, not the enclosing budget.
        await expect(
          runWithDeadline(process.execPath, ["test/fixtures/wedged-tree.mjs", pidFile], {
            cwd: packageRoot,
            timeoutMs: 10_000
          })
        ).rejects.toThrow(/exceeded its 10000 ms deadline/)

        const grandchild = Number(readFileSync(pidFile, "utf8"))
        expect(Number.isInteger(grandchild)).toBe(true)
        expect(await waitUntilGone(grandchild, 10_000)).toBe(true)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    60_000
  )
})
