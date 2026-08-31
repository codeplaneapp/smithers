/**
 * Keep the durable engine here, and place one action body somewhere else.
 *
 * Placement decides which machine supplies the host services an action sees.
 * The engine still plans the flow, dispatches the action, and journals its
 * result through the local SQLite composition. Only the implementation layer
 * is given `Sandbox.layerHost`, so its file operations and child processes use
 * one provisioned session instead of the engine host.
 *
 * The body itself knows none of that. It asks for Effect's ordinary
 * `FileSystem` and `ChildProcessSpawner`, writes a relative path, and runs
 * `wc -c` against that path. `Sandbox.layerHost` projects both services from
 * the SAME session, which is why the process sees the file without either
 * operation naming a provider or a remote path.
 *
 * `DirectorySandbox` makes the provisioned machine a real scratch directory
 * for this runnable example. The scope around flow execution owns the host
 * layer; closing that scope releases the session and removes its workspace.
 * The engine and its journal close independently over the local database.
 */
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { DirectorySandbox, Sandbox } from "@smthrs/sandbox"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { durableEngine } from "./durable-layer.ts"

/** The bytes the placed action writes and asks the sandboxed process to count. */
export const contents = "the action body ran in its sandbox\n"

/** The declared atom whose implementation is placed on the sandbox machine. */
export const CountBytes = Action.make("examples/SandboxPlacement/CountBytes", {
  payload: { contents: Schema.String },
  success: Schema.Number
})

/** A durable flow whose graph is independent of the action's placement. */
export const SandboxPlacement = Flow.make("examples/SandboxPlacement", {
  payload: { contents: Schema.String },
  success: Schema.Number,
  body: (payload) => CountBytes.call(payload)
})

/** The unchanged host-shaped body that writes a file and executes a process. */
const writeAndCount = ({ contents }: { readonly contents: string }) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner
    yield* fs.writeFileString("placed.txt", contents)
    const printed = yield* spawner.string(ChildProcess.make("wc", ["-c", "placed.txt"]))
    const count = Number.parseInt(printed.trim(), 10)
    if (!Number.isSafeInteger(count)) {
      return yield* Effect.die(new Error(`wc printed an invalid byte count: ${printed}`))
    }
    return count
  }).pipe(Effect.orDie)

export interface MainOptions {
  /** The local SQLite file that holds the engine and journal. */
  readonly filename: string
  /** The local parent under which the provider provisions its scratch machine. */
  readonly root: string
}

/** Runs the placed action once and closes every acquired layer before resolving. */
export const main = (options: MainOptions): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner
      const placedHost = Sandbox.layerHost(
        DirectorySandbox.make({ fs, spawner, root: options.root }),
        { session: "examples/sandbox-placement" }
      )
      const stack = Layer.mergeAll(
        CountBytes.toLayer(writeAndCount).pipe(Layer.provide(placedHost)),
        Interpreter.layer(SandboxPlacement)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(durableEngine(options.filename, "examples-sandbox-placement"))
      )

      return yield* SandboxPlacement.execute(
        { contents },
        { executionId: "sandbox-placement" }
      ).pipe(
        Effect.provide(stack),
        Effect.scoped
      )
    }).pipe(
      Effect.provide(NodeHost.layer),
      Effect.orDie
    )
  )
