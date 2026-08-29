/**
 * Run the same host program against two adapters.
 *
 * The host surface is a closed set of service tags: `FileSystem`, `Path`,
 * `ChildProcessSpawner`, `Jj`, and `HttpClient`. A program written against the
 * tags runs on any bundle that provides them. Note that `ChildProcessSpawner`
 * and `HttpClient` are Effect's own tags from `effect/unstable/process` and
 * `effect/unstable/http` — `flows` provides implementations of them rather
 * than a wrapper around them.
 *
 * This example runs one program twice:
 *
 * `TestHost.layer` supplies an in-memory filesystem and a scripted in-process
 * bash interpreter, so the assertions are deterministic and nothing touches the
 * machine.
 *
 * `NodeHost.layer` supplies the real Node adapters, so the same command spawns
 * a real process.
 *
 * Browser and Bun bundles implement the same tags and live at
 * `@smthrs/platform-browser`'s `BrowserHost` and `@smthrs/platform-bun`'s
 * `BunHost`.
 */
import * as TestHost from "@smthrs/kernel/test/TestHost"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export interface Summary {
  readonly scriptedRead: string
  readonly scriptedExec: string
  readonly nodeExec: string
}

/** The adapter-neutral program: read a file, then run a command. */
const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  const bytes = yield* fs.readFile("/workspace/input.txt")
  const executed = yield* spawner.string(ChildProcess.make("read-input"))
  return { read: new TextDecoder().decode(bytes), executed: executed.trim() }
})

export const main: Effect.Effect<Summary> = Effect.gen(function*() {
  const scripted = yield* program.pipe(
    Effect.provide(
      TestHost.layer({
        files: { "/workspace/input.txt": "hello from memory" },
        commands: { "read-input": { stdout: "hello from script\n", exitCode: 0 } }
      })
    )
  )

  const node = yield* Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    return yield* spawner.string(ChildProcess.make("printf", ["hello from node"]))
  }).pipe(Effect.provide(NodeHost.layer))

  return {
    scriptedRead: scripted.read,
    scriptedExec: scripted.executed,
    nodeExec: node
  }
}).pipe(Effect.orDie)
