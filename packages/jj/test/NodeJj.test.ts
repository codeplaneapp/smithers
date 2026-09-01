import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isJjError, Jj } from "../src/Jj.ts"
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
  let editorDirectory: string
  let editorMarker: string

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, NodeJj.layer)

  beforeAll(async () => {
    previousCwd = process.cwd()
    repository = await mkdtemp(join(tmpdir(), "flows-node-jj-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })

    // The editor is a MARKER rather than the `true` that used to stand here.
    // `jj describe` with no `-m` starts `$JJ_EDITOR` (`nano` when unset) even
    // with stdout on a pipe and stdin on `/dev/null`, so `true` hid a real
    // interactive child behind a program that exits immediately. Recording the
    // fact instead lets a case assert that no jj this layer runs ever starts
    // one, which is the bound `NodeJj.layer`'s own documentation claims.
    editorDirectory = await mkdtemp(join(tmpdir(), "flows-node-jj-editor-"))
    editorMarker = join(editorDirectory, "editor-ran")
    const editor = join(editorDirectory, "editor")
    writeFileSync(editor, `#!/bin/sh\necho "editor-ran pid=$$" > ${editorMarker}\n`)
    chmodSync(editor, 0o755)
    process.env.JJ_EDITOR = editor

    process.chdir(repository)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await rm(repository, { recursive: true, force: true })
    await rm(editorDirectory, { recursive: true, force: true })
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

  it.effect("snapshots without a message without starting an editor", () =>
    Effect.gen(function*() {
      // `NodeJj.layer` starts its children outside any host spawner, and the
      // bound that makes that acceptable is that every command is short-lived
      // and starts no long-lived child of its own. An editor is the exact
      // opposite: `jj describe` with no `-m` runs `$JJ_EDITOR` and waits for
      // it, so a `snapshot()` with no message would hold an interactive
      // process that no `ProcessLedger` knows about and no cancel deadline
      // covers. The marker editor makes that observable instead of a hang.
      rmSync(editorMarker, { force: true })
      yield* Effect.promise(() => writeFile(join(repository, "no-editor.txt"), "x\n"))

      yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot()))

      expect(existsSync(editorMarker)).toBe(false)
    }))

  it.effect("keeps a bound layer in its repository when process.cwd points elsewhere", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const target = await mkdtemp(join(tmpdir(), "flows-node-jj-bound-"))
        execFileSync("jj", ["git", "init", target], { stdio: "ignore" })
        return target
      }),
      (target) =>
        Effect.gen(function*() {
          yield* Effect.promise(() => writeFile(join(repository, "caller-only.txt"), "caller\n"))
          yield* Effect.promise(() => writeFile(join(target, "target-only.txt"), "target\n"))
          const current = (cwd: string) =>
            execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"], {
              cwd,
              encoding: "utf8"
            }).trim()
          const callerBefore = current(repository)
          const targetBefore = current(target)

          yield* Effect.flatMap(Jj, (jj) => jj.snapshot("bound target")).pipe(
            Effect.provide(NodeJj.layerAt(target))
          )

          expect(current(repository)).toBe(callerBefore)
          expect(current(target)).not.toBe(targetBefore)
          expect(
            execFileSync("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id.short()"], {
              cwd: target,
              encoding: "utf8"
            }).trim()
          ).toBe(targetBefore)
        }),
      (target) => Effect.promise(() => rm(target, { recursive: true, force: true }))
    ))

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
      const failure = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("empty", lane, ""))))

      // `workspaceAdd` also carries `PlatformError` from the guarded
      // implementation's path canonicalization, so the code is only readable
      // after the failure is narrowed to jj's own.
      expect(isJjError(failure) && failure.code).toBe("invalid_ref")
      expect(failure.message).toContain("jj workspaceAdd")
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

  it.effect("answers the repository root from a directory inside it", () =>
    Effect.gen(function*() {
      const nested = join(repository, "deep", "nest")
      yield* Effect.promise(() => mkdir(nested, { recursive: true }))

      const root = yield* run(Effect.flatMap(Jj, (jj) => jj.root!(nested)))

      // `realpath` because a temp directory on macOS is reached through a
      // symlink and jj answers with the resolved path.
      expect(root).toBe(realpathSync(repository))
    }))

  it.effect("undoes one change and reports the paths it touched", () =>
    Effect.gen(function*() {
      const file = join(repository, "revert-me.txt")
      yield* Effect.promise(() => writeFile(file, "unwanted\n"))
      const { changeId } = yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("add revert-me")))
      yield* Effect.promise(() => writeFile(join(repository, "keep.txt"), "kept\n"))
      yield* run(Effect.flatMap(Jj, (jj) => jj.snapshot("add keep")))

      const result = yield* run(Effect.flatMap(Jj, (jj) => jj.revert!(changeId)))

      expect(result.reverted).toEqual(["revert-me.txt"])
      // The revert is in the WORKING COPY, not parked somewhere else in the
      // graph: the reverted file is gone and the later change survived.
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(repository, "keep.txt"))).toBe(true)
    }))

  it.effect("classifies an empty revert revision as `invalid_ref` without spawning jj", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.revert!(""))))

      expect(error.code).toBe("invalid_ref")
      expect(error.message).toContain("jj revert")
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
