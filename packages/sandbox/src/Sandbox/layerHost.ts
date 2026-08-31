/**
 * Provides the host surface of one provisioned machine.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { make } from "../RemoteChildProcessSpawner/layer.ts"
import type { Provider as RemoteProvider } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { fileSystem } from "./fileSystem.ts"
import type { Provider } from "./Provider.ts"
import type { Session } from "./Session.ts"

/** A spawn-only view of a session something else already holds. */
const spawnerView = (session: Session): RemoteProvider => ({
  session: session.id,
  open: () => Effect.void,
  spawn: session.spawn,
  kill: session.kill,
  ping: session.ping
})

/**
 * Names the layer's session.
 *
 * @category models
 * @since 0.1.0
 */
export interface LayerHostOptions {
  /** The session key the machine is acquired under. */
  readonly session: string
}

/**
 * Acquires one machine for the layer's lifetime and serves the host surface
 * from it: Effect's `ChildProcessSpawner`, Effect's `FileSystem`, and the
 * pure `Path`.
 *
 * These are the same tags the local platform bundles provide and the standard
 * tools consume, so handing this layer's context to `StandardFlows.filesystem`
 * and `StandardFlows.shell` places every file operation and every spawned
 * command an agent performs on the provisioned machine — coherently, because
 * both surfaces are views of the one session. Closing the layer scope runs the
 * provider's teardown.
 *
 * This is the provisioning story the workspace transaction's documentation
 * calls future work: the machine boundary, not a path guard, is what denies
 * ambient host access here, which is why the sandbox-backed services are
 * served bare rather than kernel-decorated.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHost = (
  provider: Provider,
  options: LayerHostOptions
): Layer.Layer<
  ChildProcessSpawner | FileSystem.FileSystem | Path.Path,
  ProviderError
> =>
  Layer.effectContext(
    Effect.gen(function*() {
      const session = yield* provider.acquire(options.session)
      const spawner = yield* make(spawnerView(session))
      return Context.make(ChildProcessSpawner, spawner).pipe(
        Context.add(FileSystem.FileSystem, fileSystem(session))
      )
    })
  ).pipe(Layer.merge(Path.layer))
