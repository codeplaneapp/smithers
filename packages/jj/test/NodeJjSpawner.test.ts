/**
 * `NodeJj.layerSpawner`, driven against the same stand-in `jj` on `PATH`.
 *
 * The layer exists so a host that contains what it spawns contains jj too: a
 * `jj` child started around the host's spawner leads no process group the host
 * recorded, is in no `ProcessLedger`, and is never reaped. What has to be true
 * of it is that routing jj through a spawner changes NOTHING a caller can
 * observe: the same commands, the same stdout, and the same classified errors
 * as the self-spawning layer. These cases run a real `jj` shim through a real
 * spawner adapter and check exactly that.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as EffectChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const script = `#!/bin/sh
case "$1" in
  status) echo "the working copy is clean"; exit 0 ;;
  root) echo "/scripted/root"; exit 0 ;;
  diff) echo "Error: Revision not found" 1>&2; exit 1 ;;
  *) exit 0 ;;
esac
`

/** A second binary, reachable only by name, for the override case. */
const overrideScript = `#!/bin/sh
echo "answered by the override"
exit 0
`

const directory = mkdtempSync(join(tmpdir(), "flows-jj-spawner-"))
writeFileSync(join(directory, "jj"), script)
chmodSync(join(directory, "jj"), 0o755)
const overrideBinary = join(directory, "override-jj")
writeFileSync(overrideBinary, overrideScript)
chmodSync(overrideBinary, 0o755)

// The adapter honours SMITHERS_JJ_PATH, so a developer who has one set would
// otherwise change which binary these cases spawn.
delete process.env.SMITHERS_JJ_PATH
delete process.env.FLOWS_JJ_PATH

const encode = (text: string) => Stream.make(new TextEncoder().encode(text))

/**
 * A `ChildProcessSpawner` over `node:child_process`.
 *
 * `@smthrs/jj` does not depend on a platform bundle, so the adapter is written
 * out here rather than imported. It is deliberately the smallest real one: it
 * starts the process, collects both streams, and reports the exit code.
 */
const realSpawner = Layer.succeed(ChildProcessSpawner)(
  makeSpawner((command: EffectChildProcess.Command) =>
    Effect.sync(() => {
      const standard = command as EffectChildProcess.StandardCommand
      const child = spawn(standard.command, [...standard.args], {
        cwd: standard.options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: directory }
      })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })
      const finished = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)))
      const settled = Effect.promise(() => finished)
      return makeHandle({
        pid: ProcessId(child.pid ?? 0),
        exitCode: Effect.map(settled, (code) => ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.unwrap(Effect.map(settled, () => encode(stdout))),
        stderr: Stream.unwrap(Effect.map(settled, () => encode(stderr))),
        all: Stream.unwrap(Effect.map(settled, () => encode(stdout + stderr))),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
)

/**
 * A spawner whose child never stops talking.
 *
 * No process is started: the ceiling is a property of how the adapter reads a
 * handle's streams, and eighty mebibytes of scripted output reaches it faster
 * than a real child could produce them.
 */
const flood = Layer.succeed(ChildProcessSpawner)(
  makeSpawner(() =>
    Effect.sync(() => {
      const chunk = new Uint8Array(1024 * 1024).fill("x".charCodeAt(0))
      return makeHandle({
        pid: ProcessId(0),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.fromIterable(Array.from({ length: 80 }, () => chunk)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
)

/** A spawner that reports what a host reports for a binary that is not there. */
const missingBinary = Layer.succeed(ChildProcessSpawner)(
  makeSpawner(() =>
    Effect.fail(
      PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn", description: "jj" })
    )
  )
)

const run = <A, E>(effect: Effect.Effect<A, E, Jj>, spawner: Layer.Layer<ChildProcessSpawner>) =>
  Effect.provide(effect, Layer.provide(NodeJj.layerSpawner, spawner))

process.on("exit", () => rmSync(directory, { recursive: true, force: true }))

describe.skipIf(process.platform === "win32")("NodeJj.layerSpawner", () => {
  it.live("runs jj through the host spawner and returns its stdout", () =>
    Effect.gen(function*() {
      const output = yield* run(Effect.flatMap(Jj, (jj) => jj.status()), realSpawner)
      expect(output).toBe("the working copy is clean\n")
    }))

  it.live("passes the working directory through to the spawned command", () =>
    Effect.gen(function*() {
      const root = yield* run(Effect.flatMap(Jj, (jj) => jj.root!(directory)), realSpawner)
      // Trimmed, exactly as the self-spawning layer trims it.
      expect(root).toBe("/scripted/root")
    }))

  it.live("builds a repository-bound adapter over the host spawner", () =>
    Effect.gen(function*() {
      const output = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(
        Effect.provide(Layer.provide(NodeJj.layerSpawnerAt(directory), realSpawner))
      )

      expect(output).toBe("the working copy is clean\n")
    }))

  it.live("classifies a nonzero exit from jj's own stderr vocabulary", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("a", "b"))), realSpawner)
      expect(error.code).toBe("invalid_ref")
      expect(error.message).toBe("jj diff: Error: Revision not found")
    }))

  it.effect("reports a jj the host cannot find as `not_installed`", () =>
    Effect.gen(function*() {
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())), missingBinary)
      expect(error.code).toBe("not_installed")
      expect(error.message).toBe("jj: command not found on PATH")
    }))

  it.live("spawns the binary SMITHERS_JJ_PATH names, through the spawner too", () =>
    Effect.gen(function*() {
      // The spawner hands the child `PATH=directory`, where the scripted `jj`
      // lives, so the only way this answer can come back is the override being
      // the command that was spawned.
      process.env.SMITHERS_JJ_PATH = overrideBinary
      try {
        expect(yield* run(Effect.flatMap(Jj, (jj) => jj.status()), realSpawner))
          .toBe("answered by the override\n")
      } finally {
        delete process.env.SMITHERS_JJ_PATH
      }
    }))

  it.effect("names a bound repository root that is not a directory", () =>
    Effect.gen(function*() {
      // A spawner reports a missing binary and an unusable working directory
      // the same way, so without the directory probe a bound layer pointed at a
      // directory that is gone answers `not_installed` with jj on PATH.
      const missing = join(directory, "absent-root")
      const error = yield* Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())).pipe(
        Effect.provide(Layer.provide(NodeJj.layerSpawnerAt(missing), missingBinary))
      )

      expect(error.code).toBe("unknown")
      expect(error.message).toBe(`jj status: cannot run in ${missing}: not a directory`)
    }))

  it.effect("refuses output past the same ceiling the self-spawning layer applies", () =>
    Effect.gen(function*() {
      // `Stream.mkString` is as unbounded as string concatenation, so without a
      // bound this layer would buffer what `NodeJj.layer` refuses — a behavior
      // difference bought by the containment routing, which is the one thing
      // routing through a spawner must not cost.
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())), flood)

      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: output exceeded the 67108864-character ceiling")
      expect(error).toMatchObject({ module: "NodeJj", method: "status", command: "jj status" })
    }))

  it.effect("reports any other spawn failure as `unknown`", () =>
    Effect.gen(function*() {
      const refused = Layer.succeed(ChildProcessSpawner)(
        makeSpawner(() =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
              description: "jj"
            })
          )
        )
      )
      const error = yield* run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())), refused)
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("jj status:")
    }))
})

describe("NodeJj repository-root validation", () => {
  it("refuses relative roots for both process ownership modes", () => {
    expect(() => NodeJj.layerAt("relative/repository")).toThrow(
      "NodeJj.layerAt requires an absolute repository root"
    )
    expect(() => NodeJj.layerSpawnerAt("relative/repository")).toThrow(
      "NodeJj.layerSpawnerAt requires an absolute repository root"
    )
  })
})
