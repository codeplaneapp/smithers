/**
 * Run the same host program against two adapters.
 *
 * The host surface is a closed set of service tags: `FileSystem`, `Path`,
 * `ChildProcessSpawner`, `Jj`, and `HttpClient`. A program written against the
 * tags runs on any bundle that provides them. Note that `ChildProcessSpawner`
 * and `HttpClient` are Effect's own tags from `effect/unstable/process` and
 * `effect/unstable/http`. Smithers provides implementations of them rather
 * than a wrapper around them.
 *
 * This example runs one program on two bundles:
 *
 * `TestHost.layer` supplies an in-memory filesystem and a scripted in-process
 * bash interpreter, so the assertions are deterministic and nothing touches the
 * machine.
 *
 * `NodeHost.layer` supplies the real Node adapters, so the same program reads a
 * file off disk and spawns a real process.
 *
 * The fixtures differ, because a scripted command name and an in-memory path
 * exist only under the test adapter. The program that reads them does not: it
 * takes its file and command as arguments, so both hosts run the same function.
 *
 * Browser and Bun bundles implement the same tags and live at
 * `@smthrs/platform-browser`'s `BrowserHost` and `@smthrs/platform-bun`'s
 * `BunHost`.
 */
import * as TestHost from "@smthrs/testing/TestHost"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export interface Summary {
  readonly scriptedRead: string
  readonly scriptedExec: string
  readonly nodeRead: string
  readonly nodeExec: string
}

/** What a host hands the program: a file to read and a command to run. */
interface Fixture {
  readonly path: string
  readonly command: ChildProcess.Command
}

/** The adapter-neutral program: read a file, then run a command. */
const program = (fixture: Fixture) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    const bytes = yield* fs.readFile(fixture.path)
    const executed = yield* spawner.string(fixture.command)
    return { read: new TextDecoder().decode(bytes), executed: executed.trim() }
  })

export const main: Effect.Effect<Summary> = Effect.gen(function*() {
  const scripted = yield* program({
    path: "/workspace/input.txt",
    command: ChildProcess.make("read-input")
  }).pipe(
    Effect.provide(
      TestHost.layer({
        files: { "/workspace/input.txt": "hello from memory" },
        commands: { "read-input": { stdout: "hello from script\n", exitCode: 0 } }
      })
    )
  )

  // The same `program` on the real adapters. Its file goes in a temp directory
  // the scope removes, and its command is one a machine actually has.
  const node = yield* Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "host-adapters-" })
    const path = `${directory}/input.txt`
    yield* fs.writeFileString(path, "hello from disk")
    return yield* program({ path, command: ChildProcess.make("printf", ["hello from node"]) })
  }).pipe(Effect.scoped, Effect.provide(NodeHost.layer))

  return {
    scriptedRead: scripted.read,
    scriptedExec: scripted.executed,
    nodeRead: node.read,
    nodeExec: node.executed
  }
}).pipe(Effect.orDie)
