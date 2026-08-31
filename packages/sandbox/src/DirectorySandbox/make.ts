/**
 * Constructs the scratch-directory sandbox provider.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * What the scratch-directory provider needs from its host.
 *
 * The services arrive as values, never as ambient imports, so the module
 * stays platform-neutral: a Node composition passes the platform bundle's
 * filesystem and spawner, and the package itself still owns no host access.
 *
 * @category models
 * @since 0.1.0
 */
export interface DirectorySandboxOptions {
  /** The host filesystem the scratch directories live on. */
  readonly fs: FileSystem.FileSystem
  /** The host spawner commands run through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The directory session workspaces are created under. */
  readonly root: string
}

const failure = providerFailure

/**
 * Builds a sandbox provider whose machines are directories on this host.
 *
 * `acquire` creates one scratch directory per session key and serves the
 * session contract from it: `spawn` runs the command line through the host
 * spawner's shell with the directory as its default working directory, file
 * transfer is the host filesystem, `kill` delivers real signals, and closing
 * the scope removes the directory.
 *
 * This is the trusted local backend — a workspace boundary, **not a security
 * boundary**. Nothing confines a spawned process to the directory; what the
 * provider gives you is the session shape itself, so a composition, a test,
 * or CI can run the placement machinery for real with no container runtime,
 * and the same composition swaps to `ContainerSandbox` or a vendor provider
 * where isolation matters.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: DirectorySandboxOptions): Provider => ({
  acquire: (sessionKey) =>
    Effect.gen(function*() {
      const workdir = `${options.root.replace(/\/+$/, "")}/${sessionSlug(sessionKey)}`
      yield* Effect.acquireRelease(
        options.fs.makeDirectory(workdir, { recursive: true }).pipe(
          Effect.mapError(failure("unavailable", `the scratch workspace ${workdir} could not be created`))
        ),
        () => Effect.ignore(options.fs.remove(workdir, { recursive: true, force: true }))
      )
      const started = new WeakMap<RemoteProcess, ChildProcessHandle>()
      const session: Session = {
        id: sessionKey,
        remoteId: workdir,
        workdir,
        spawn: Effect.fnUntraced(function*(command, spawnOptions) {
          const settings: ChildProcess.CommandOptions = {
            shell: true,
            cwd: spawnOptions.cwd ?? workdir,
            ...spawnOptions.env === undefined ? {} : { env: spawnOptions.env }
          }
          const handle = yield* options.spawner.spawn(ChildProcess.make(command, settings)).pipe(
            Effect.mapError(failure("spawn_error", `\`${command}\` could not start`))
          )
          const process = remoteProcessOf(handle, command)
          started.set(process, handle)
          return process
        }),
        readFile: (path) =>
          options.fs.readFile(path).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "NotFound"
                ? new ProviderError({ code: "not_found", message: `the sandbox holds nothing at ${path}` })
                : failure("unknown", `the sandbox could not read ${path}`)(error)
            )
          ),
        writeFile: (path, content) =>
          Effect.gen(function*() {
            const separator = path.lastIndexOf("/")
            if (separator > 0) {
              yield* options.fs.makeDirectory(path.slice(0, separator), { recursive: true })
            }
            yield* options.fs.writeFile(path, content)
          }).pipe(Effect.mapError(failure("unknown", `the sandbox could not write ${path}`))),
        kill: (process, signal) =>
          Effect.suspend(() => {
            const handle = started.get(process)
            /* v8 ignore next 3 -- `spawn` records every process it returns and a `RemoteProcess` has no other source, so the guard only discharges the optional a map read carries */
            if (handle === undefined) {
              return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
            }
            return handle.kill({ killSignal: signal }).pipe(
              Effect.mapError(failure("unknown", `the signal ${signal} could not be delivered`))
            )
          }),
        ping: Effect.void,
        // Native overrides mirror `Sandbox.fileSystem`'s rooting rule: a
        // relative path is the workspace's, never the host process's cwd.
        files: (() => {
          const resolve = (path: string): string => {
            if (path.startsWith("/")) return path
            const trimmed = path.replace(/^(\.\/)+/, "")
            return trimmed === "" || trimmed === "." ? workdir : `${workdir}/${trimmed}`
          }
          return {
            exists: (path) => options.fs.exists(resolve(path)),
            stat: (path) => options.fs.stat(resolve(path)),
            readDirectory: (path, directoryOptions) => options.fs.readDirectory(resolve(path), directoryOptions),
            makeDirectory: (path, directoryOptions) => options.fs.makeDirectory(resolve(path), directoryOptions),
            remove: (path, removeOptions) => options.fs.remove(resolve(path), removeOptions),
            rename: (oldPath, newPath) => options.fs.rename(resolve(oldPath), resolve(newPath)),
            realPath: (path) => options.fs.realPath(resolve(path)),
            readLink: (path) => options.fs.readLink(resolve(path))
          } satisfies Partial<FileSystem.FileSystem>
        })()
      }
      return session
    })
})
