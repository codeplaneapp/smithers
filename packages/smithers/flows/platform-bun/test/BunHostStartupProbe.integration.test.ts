import { describe, expect, it } from "@effect/vitest"
import { JjError } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunHost from "../src/BunHost.ts"

describe.skipIf(process.platform === "win32")("BunHost startup probe budget", () => {
  const contained = { graceMs: 20 }
  const factories = [
    ["default", () => BunHost.layer],
    ["layer", () => BunHost.layer],
    ["layerAt", (root: string) => BunHost.layerAt(root)],
    ["layerContained", () => BunHost.layerContained(contained)],
    ["layerContainedAt", (root: string) => BunHost.layerContainedAt(root, contained)]
  ] as const

  for (const [name, build] of factories) {
    it(`bounds ${name} startup before exposing FileSystem`, async () => {
      const root = mkdtempSync(join(tmpdir(), "bun-startup-budget-"))
      const binary = join(root, "jj")
      const pidFile = join(root, "pid")
      writeFileSync(binary, "#!/bin/sh\necho $$ > \"${0%/*}/pid\"\nexec /bin/sleep 300\n", { mode: 0o755 })
      const previous = process.env.SMITHERS_JJ_PATH
      process.env.SMITHERS_JJ_PATH = binary
      try {
        const budget = name === "default" ? 5_000 : 3_000
        const watchdog = budget + 3_000
        const host = build(root).pipe(
          Layer.provide(ProcessLedger.layerMemory({ hostId: `startup-${name}`, ownerPid: process.pid }))
        )
        const configured = name === "default"
          ? host
          : host.pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs)(budget)))
        const start = Date.now()
        const error = await Effect.runPromise(Effect.flip(
          Effect.provide(FileSystem.FileSystem, configured).pipe(Effect.timeout(watchdog))
        ))
        expect(error).toBeInstanceOf(JjError)
        expect(error).toMatchObject({ code: "unknown", method: "version", cause: { code: "ETIMEDOUT" } })
        expect(error).toMatchObject({ command: `${binary} --version` })
        expect(error.message).toContain(binary)
        expect(error.message).toContain(`${budget}ms`)
        expect(Date.now() - start).toBeGreaterThanOrEqual(budget - 100)
        expect(Date.now() - start).toBeLessThan(watchdog)
        const pid = Number(readFileSync(pidFile, "utf8").trim())
        expect(pid).toBeGreaterThan(0)
        await expect.poll(() => {
          try {
            process.kill(pid, 0)
            return false
          } catch (cause) {
            return (cause as NodeJS.ErrnoException).code === "ESRCH"
          }
        }, { timeout: 2_000 }).toBe(true)
      } finally {
        if (previous === undefined) delete process.env.SMITHERS_JJ_PATH
        else process.env.SMITHERS_JJ_PATH = previous
        try {
          const pid = Number(readFileSync(pidFile, "utf8").trim())
          if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGKILL")
        } catch {
          // Already reaped, or the shim never started.
        }
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
