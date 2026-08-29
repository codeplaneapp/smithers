import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

// On CI the real-binary suite is the only thing exercising the actual jj
// contract — the scripted-fake suite already keeps coverage green — so a
// silent skip would let a behavioural regression against real jj merge
// unnoticed (issue #163). Locally the skip stays quiet; on CI it fails loud.
describe.runIf(Boolean(process.env.CI) && !jjInstalled)("NodeJj (CI guard)", () => {
  it("fails loudly when CI has no jj on PATH", () => {
    throw new Error(
      "jj is not installed on this CI runner, so the real-binary NodeJj suite "
        + "silently skipped. Install jj in .github/workflows/ci.yml (see the "
        + "'Install jj' step) — do not let this suite no-op on CI."
    )
  })
})

/**
 * `NodeJj` spawns `jj` in `process.cwd()`, so every case runs against a real
 * throwaway repository that this suite chdirs into.
 */
// Every operation waits for the spawned process to close; elapsed time is not
// part of the contract, and the package-wide `testTimeout` budgets for the
// jj-lock contention several of these suites create for each other.
describe.skipIf(!jjInstalled)("NodeJj", () => {
  let repository: string
  let previousCwd: string

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, NodeJj.layer)

  beforeAll(async () => {
    previousCwd = process.cwd()
    repository = await mkdtemp(join(tmpdir(), "flows-node-jj-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
    // `jj describe` with no `-m` opens an editor; keep the non-interactive path.
    process.env.JJ_EDITOR = "true"
    process.chdir(repository)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await rm(repository, { recursive: true, force: true })
  })

  it.effect("snapshots the working copy and restores a file back out of it", () =>
    Effect.gen(function*() {
      const file = join(repository, "note.txt")
      yield* Effect.promise(() => writeFile(file, "first\n"))

      const { changeId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("first commit")))
      expect(changeId).toMatch(/^[a-z]+$/)

      yield* Effect.promise(() => writeFile(file, "second\n"))
      yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("second commit")))

      const diff = yield* run(Effect.flatMap(Jj, (jj) => jj.diff(changeId, "@-")))
      expect(diff).toContain("note.txt")
      expect(diff).toContain("+second")

      const status = yield* run(Effect.flatMap(Jj, (jj) => jj.status()))
      expect(status).toContain("Working copy")
    }))

  it.effect("snapshots without a message when none is supplied", () =>
    Effect.gen(function*() {
      yield* Effect.promise(() => writeFile(join(repository, "unnamed.txt"), "x\n"))
      const { changeId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot()))

      expect(changeId).not.toBe("")
      const log = execFileSync("jj", ["log", "-r", changeId, "--no-graph", "-T", "change_id.short()"], {
        cwd: repository,
        encoding: "utf8"
      })
      expect(log.trim()).toBe(changeId)
    }))

  it.effect("adds and forgets a named workspace lane", () =>
    Effect.gen(function*() {
      const lane = join(repository, "..", `lane-${process.pid}`)
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("lane", lane)))
      expect(existsSync(lane)).toBe(true)

      const workspaces = execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })
      expect(workspaces).toContain("lane")

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("lane")))
      expect(execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" }))
        .not.toContain("lane:")
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("pins a new workspace lane at the requested revision", () =>
    Effect.gen(function*() {
      const file = join(repository, "pinned.txt")
      yield* Effect.promise(() => writeFile(file, "first\n"))
      const { changeId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("pinned base")))
      yield* Effect.promise(() => writeFile(file, "second\n"))
      yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("after base")))

      const lane = join(repository, "..", `pinned-${process.pid}`)
      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("pinned", lane, changeId)))
      expect(readFileSync(join(lane, "pinned.txt"), "utf8")).toBe("first\n")

      yield* run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("pinned")))
      yield* Effect.promise(() => rm(lane, { recursive: true, force: true }))
    }))

  it.effect("classifies an empty workspace revision as `invalid_ref` without spawning jj", () =>
    Effect.gen(function*() {
      const lane = join(repository, "..", `empty-revision-${process.pid}`)
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("empty", lane, ""))))

      // The union member that carries `code` is JjFailure; a PlatformError
      // here would be a spawn, which this case asserts never happens.
      expect(error).toHaveProperty("code", "invalid_ref")
      expect(error.message).toContain("jj workspaceAdd")
      expect(existsSync(lane)).toBe(false)
    }))

  it.effect("classifies an unknown revision as `invalid_ref`", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore("nosuchchangeid"))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("jj restore")
    }))

  it.effect("classifies a malformed revset as `invalid_ref`, agreeing with BrowserJj", () =>
    Effect.gen(function*() {
      // "Failed to parse revset: Syntax error" — the browser layer resolves the
      // same string to invalid_ref, and the code is durable identity in
      // journals, so the two layers must agree.
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("@@@bad", "@"))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("jj diff")
    }))

  it.effect("classifies an empty revision as `invalid_ref` without spawning jj", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore(""))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toBe("jj restore: empty revision string")
    }))

  it.effect("classifies an unrecognized failure as `unknown`", () =>
    Effect.gen(function*() {
      // Running outside any repository is jj's plain "There is no jj repo"
      // error, which matches none of the classified vocabularies.
      const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-node-jj-norepo-")))
      process.chdir(outside)
      try {
        const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
        expect(error.code).toBe("unknown")
        expect(error.message).toContain("jj status")
      } finally {
        process.chdir(repository)
        yield* Effect.promise(() => rm(outside, { recursive: true, force: true }))
      }
    }))

  it.effect("reports `not_installed` when `jj` is not on PATH", () =>
    Effect.gen(function*() {
      const path = process.env.PATH
      process.env.PATH = join(repository, "empty-bin")
      try {
        const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
        expect(error.code).toBe("not_installed")
        expect(error.message).toBe("jj: command not found on PATH")
        // The spawn failure travels whole on `cause` rather than flattened away.
        expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT")
      } finally {
        process.env.PATH = path
      }
    }))
})
