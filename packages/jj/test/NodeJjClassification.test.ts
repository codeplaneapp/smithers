/**
 * `NodeJj`'s error surface, driven against a stand-in `jj` on `PATH`.
 *
 * A real repository cannot produce every failure vocabulary on demand — jj
 * reports conflicts, missing revisions, and signal deaths under conditions a
 * test cannot reliably stage. The classification is the contract, so the binary
 * is scripted instead and the service is exercised end to end through it.
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schedule from "effect/Schedule"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const script = `#!/bin/sh
case "$FLOWS_FAKE_JJ" in
  conflict) echo "Error: would leave conflicts in note.txt" 1>&2; exit 1 ;;
  revision-not-found) echo "Error: Revision not found" 1>&2; exit 1 ;;
  doesnt-exist) echo "Error: Path doesn't exist" 1>&2; exit 1 ;;
  revset-parse) echo "Error: Failed to parse revset: Syntax error" 1>&2; exit 1 ;;
  stdout-only) echo "Error: reported on stdout"; exit 1 ;;
  signal) kill -9 $$ ;;
  slow) echo $$ > "$FLOWS_FAKE_JJ_MARKER.pid"; : > "$FLOWS_FAKE_JJ_MARKER.started"; /bin/sleep 1; : > "$FLOWS_FAKE_JJ_MARKER" ;;
  orphan) echo $$ > "$FLOWS_FAKE_JJ_MARKER.pid"
    (: > "$FLOWS_FAKE_JJ_MARKER.started"; /bin/sleep 1; : > "$FLOWS_FAKE_JJ_MARKER") & exit 0 ;;
  *) exit 0 ;;
esac
`

/**
 * Poll for a marker file rather than sleeping a fixed span: a fixed wait is
 * sized against an unloaded machine and turns spawn latency into a red suite
 * (issue #170).
 */
const waitFor = (path: string) =>
  Effect.retry(
    Effect.suspend(() => existsSync(path) ? Effect.void : Effect.fail("absent" as const)),
    { times: 300, schedule: Schedule.spaced(10) }
  )

/**
 * Poll until `pid` is no longer a live process.
 *
 * Process liveness is the positive signal that Node has reaped the direct child
 * and populated its exit state. It works for both an interrupted process and a
 * process whose descendant keeps the pipes open after the direct child exits.
 */
const waitForExit = (pid: number) =>
  Effect.retry(
    Effect.suspend(() => {
      try {
        process.kill(pid, 0)
        return Effect.fail("alive" as const)
      } catch {
        return Effect.void
      }
    }),
    { times: 500, schedule: Schedule.spaced(10) }
  )

const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.provide(effect, NodeJj.layer)

const status = (mode: string) => {
  process.env.FLOWS_FAKE_JJ = mode
  return run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
}

describe.skipIf(process.platform === "win32")("NodeJj failure classification", () => {
  let directory: string
  let previousPath: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-fake-jj-"))
    await writeFile(join(directory, "jj"), script)
    await chmod(join(directory, "jj"), 0o755)

    previousPath = process.env.PATH
    process.env.PATH = directory
  })

  afterAll(async () => {
    process.env.PATH = previousPath
    delete process.env.FLOWS_FAKE_JJ
    delete process.env.FLOWS_FAKE_JJ_MARKER
    await rm(directory, { recursive: true, force: true })
  })

  it.live("classifies conflict vocabulary as `conflict`", () =>
    Effect.gen(function*() {
      const error = yield* status("conflict")

      expect(error.code).toBe("conflict")
      expect(error.message).toBe("jj status: Error: would leave conflicts in note.txt")
    }))

  it.live("classifies `revision not found` as `invalid_ref`", () =>
    Effect.gen(function*() {
      expect((yield* status("revision-not-found")).code).toBe("invalid_ref")
    }))

  it.live("classifies `doesn't exist` as `invalid_ref`", () =>
    Effect.gen(function*() {
      expect((yield* status("doesnt-exist")).code).toBe("invalid_ref")
    }))

  it.live("classifies `failed to parse revset` as `invalid_ref`, agreeing with the wasm layer", () =>
    Effect.gen(function*() {
      expect((yield* status("revset-parse")).code).toBe("invalid_ref")
    }))

  it.live("classifies empty revisions as `invalid_ref` before any spawn", () =>
    Effect.gen(function*() {
      process.env.FLOWS_FAKE_JJ = "ok" // the fake would exit 0: proof no spawn happened
      const restoreError = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore(""))))
      expect(restoreError.code).toBe("invalid_ref")
      expect(restoreError.message).toBe("jj restore: empty revision string")
      const diffError = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("@", ""))))
      expect(diffError.code).toBe("invalid_ref")
      expect(diffError.message).toBe("jj diff: empty revision string")
    }))

  it.live("falls back to stdout for the message when stderr is empty", () =>
    Effect.gen(function*() {
      const error = yield* status("stdout-only")

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: Error: reported on stdout")
    }))

  it.live("treats a signal-killed `jj` as a failure with no reported text", () =>
    Effect.gen(function*() {
      const error = yield* status("signal")

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: ")
    }))

  it.live("succeeds and returns stdout when the command exits zero", () =>
    Effect.gen(function*() {
      process.env.FLOWS_FAKE_JJ = "ok"

      expect(yield* run(Effect.flatMap(Jj, (jj) => jj.status()))).toBe("")
    }))

  it.live("kills a still-running `jj` when the fiber is interrupted", () =>
    Effect.gen(function*() {
      const marker = join(directory, "escaped")
      const started = `${marker}.started`
      const pidFile = `${marker}.pid`
      process.env.FLOWS_FAKE_JJ = "slow"
      process.env.FLOWS_FAKE_JJ_MARKER = marker

      // The absence of `marker` only proves the kill worked if the child was
      // demonstrably alive when the interrupt was delivered. Without this
      // positive control a spawn failure or a spawn delayed past the interrupt
      // leaves `marker` trivially absent and the cell passes for the wrong
      // reason (issue #162), so wait for the child's own started marker and
      // assert it immediately before interrupting.
      yield* (
        Effect.gen(function*() {
          const jj = yield* Jj
          const fiber = yield* Effect.forkChild(jj.status(), { startImmediately: true })
          yield* waitFor(started)
          expect(existsSync(started)).toBe(true)
          expect(existsSync(marker)).toBe(false)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(NodeJj.layer))
      )
      // A fixed sleep sized the absence window against an unloaded machine, so a
      // delayed write from an unkilled child could land after the window closed
      // and the cell would pass for the wrong reason (issue #175). Wait for the
      // child process itself to disappear instead: the script writes `marker`
      // before exiting, so once the pid is gone the marker has either been
      // written or never will be, and the absence is a decided fact.
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
      expect(Number.isInteger(pid)).toBe(true)
      yield* (waitForExit(pid))

      expect(existsSync(marker)).toBe(false)
    }))

  it.live("does not signal a `jj` that already exited while its pipes are still held", () =>
    Effect.gen(function*() {
      const marker = join(directory, "orphan-finished")
      const started = `${marker}.started`
      const pidFile = `${marker}.pid`
      process.env.FLOWS_FAKE_JJ = "orphan"
      process.env.FLOWS_FAKE_JJ_MARKER = marker

      // `jj` exits immediately but a background descendant keeps stdout open, so
      // `close` never arrives and the call is still interruptible after the exit.
      //
      // A marker written immediately before shell exit still races Node's exit
      // observation. Wait for the recorded PID to disappear instead: once the
      // direct child has been reaped, `child.exitCode` is populated while the
      // descendant deliberately keeps the callback's pipes open (issue #170).
      yield* (
        Effect.gen(function*() {
          const jj = yield* Jj
          const fiber = yield* Effect.forkChild(jj.status(), { startImmediately: true })
          yield* waitFor(started)
          yield* waitFor(pidFile)
          const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)
          expect(Number.isInteger(pid)).toBe(true)
          yield* waitForExit(pid)
          expect(existsSync(started)).toBe(true)
          expect(existsSync(marker)).toBe(false)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(NodeJj.layer))
      )
      yield* (waitFor(marker))

      // Nothing was signalled, so the descendant ran to completion.
      expect(existsSync(marker)).toBe(true)
    }))
})

describe.skipIf(process.platform === "win32")("NodeJj spawn errors", () => {
  let directory: string
  let previousPath: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-unexecutable-jj-"))
    await writeFile(join(directory, "jj"), script)
    await chmod(join(directory, "jj"), 0o644)
    previousPath = process.env.PATH
    process.env.PATH = directory
  })

  afterAll(async () => {
    process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  })

  it.live("reports a non-ENOENT spawn failure as `unknown` rather than `not_installed`", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))

      expect(error.code).toBe("unknown")
      expect(error.message).toMatch(/^jj status: /)
    }))
})
