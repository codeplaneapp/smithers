/**
 * The apply lock, against real files and real pids.
 *
 * The whole point of the lock is cross-process: a refusal decided by a mocked
 * clock or a faked pid proves the branch and nothing about the mechanism, so
 * the dead pid here is a process that really ran and really exited.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Lock from "@smthrs/migrate/flow/Lock"
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const platform = NodeServices.layer

const temporaries: Array<string> = []
const scratch = (): string => {
  const target = mkdtempSync(join(tmpdir(), "migrate-lock-"))
  temporaries.push(target)
  return target
}
process.on("exit", () => {
  for (const target of temporaries) rmSync(target, { recursive: true, force: true })
})

const acquire = (root: string) => Lock.acquire({ root, reportDir: ".smithers-migrate" }).pipe(Effect.provide(platform))

const release = (held: Lock.Held) => Lock.release(held).pipe(Effect.provide(platform))

const lockPath = (root: string) => join(root, ".smithers-migrate", "apply.lock")

/** A pid that is certainly dead: a process that already ran and exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid

describe("Lock.acquire", () => {
  it.effect("takes the lock, records who holds it, and gives it back", () =>
    Effect.gen(function*() {
      const root = scratch()

      const held = yield* acquire(root)

      const written = JSON.parse(readFileSync(lockPath(root), "utf8"))
      expect(written).toMatchObject({ pid: process.pid, root })
      expect(typeof written.startedAt).toBe("string")
      expect(held.reclaimed).toBeUndefined()

      yield* release(held)
      expect(existsSync(lockPath(root))).toBe(false)
    }))

  it.effect("refuses a concurrent apply while the first holds the lock", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)

      const failure = yield* Effect.flip(acquire(root))

      expect(failure.code).toBe("apply-in-progress")
      expect(failure.message).toContain("apply.lock")
      expect(failure.message).toContain(`pid ${process.pid}`)

      // Once it is given back, the next run takes it.
      yield* release(held)
      const next = yield* acquire(root)
      yield* release(next)
    }))

  it.effect("takes over a stale lock from a dead pid, remembering who held it", () =>
    Effect.gen(function*() {
      const root = scratch()
      mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
      const stale = { pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", root }
      writeFileSync(lockPath(root), `${JSON.stringify(stale)}\n`)

      const held = yield* acquire(root)

      expect(held.reclaimed).toEqual(stale)
      expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toMatchObject({ pid: process.pid, root })
      yield* release(held)
      expect(existsSync(lockPath(root))).toBe(false)
    }))

  it.effect("takes over a lock nothing can read back, which a crash mid-write leaves", () =>
    Effect.gen(function*() {
      const root = scratch()
      mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
      writeFileSync(lockPath(root), "{\"pid\":")

      const held = yield* acquire(root)

      expect(held.reclaimed).toBeUndefined()
      expect(JSON.parse(readFileSync(lockPath(root), "utf8")).pid).toBe(process.pid)
      yield* release(held)
    }))
})

describe("Lock.release", () => {
  it.effect("leaves a lock another run has since taken", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      // The file now carries another run's record. Removing it would reopen
      // the window the lock exists to close.
      const other = { pid: 424242, startedAt: "2026-02-02T00:00:00.000Z", root }
      writeFileSync(lockPath(root), `${JSON.stringify(other)}\n`)

      yield* release(held)

      expect(JSON.parse(readFileSync(lockPath(root), "utf8"))).toMatchObject(other)
    }))

  it.effect("is a no-op when the file is already gone", () =>
    Effect.gen(function*() {
      const root = scratch()
      const held = yield* acquire(root)
      rmSync(lockPath(root))

      yield* release(held)

      expect(existsSync(lockPath(root))).toBe(false)
    }))
})
