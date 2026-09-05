import { expect, it } from "@effect/vitest"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

it("admits and reopens exact N-1/N/N+1 command, frame and snapshot bytes through JSON RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-disk-limits-"))
  try {
    for (const mode of ["seed", "reopen"]) {
      const result = await promisify(execFile)(process.execPath, [
        fileURLToPath(new URL("./fixtures/limits-recovery-child.ts", import.meta.url)),
        mode,
        directory
      ], { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
      expect(JSON.parse(result.stdout)).toEqual({
        mode,
        commandsTested: 12,
        framesTested: 6,
        snapshotsTested: 6,
        malformedRecordsTested: 5,
        node: process.version
      })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
