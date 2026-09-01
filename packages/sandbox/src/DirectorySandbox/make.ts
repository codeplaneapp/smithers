/**
 * Constructs the scratch-directory sandbox provider.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle, ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { hostKillScript } from "../internal/killScript.ts"
import { gather, providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
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
 * spawner's shell with the directory as its default working directory — a
 * relative `cwd` is taken under it, the caller's `env` extends the host's
 * rather than replacing it, and `stdin` bytes become the command's whole
 * standard input — file transfer is the host filesystem, `kill` delivers
 * real signals, and closing the scope removes the directory.
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
      // One rooting rule for every relative path the session sees, mirroring
      // `Sandbox.fileSystem`: a relative `cwd` or file path is the
      // workspace's, never the engine process's working directory.
      const resolve = (path: string): string => {
        if (path.startsWith("/")) return path
        const trimmed = path.replace(/^(\.\/)+/, "")
        return trimmed === "" || trimmed === "." ? workdir : `${workdir}/${trimmed}`
      }
      const started = new WeakMap<RemoteProcess, ChildProcessHandle>()
      // Commands run as `sh -c <line>`, so the handle's own kill reaches
      // only that shell — and a shell that forked the work (dash does, and
      // any pipeline or background job everywhere) leaves it running, the
      // exact silent no-op kill the conformance suite exists to catch. The
      // handle's pid is the real OS pid, so a walk through the injected
      // spawner collects the whole descendant set first and signals it and
      // the root in one `kill` invocation.
      const deliver = (handle: ChildProcessHandle, signal: string): Effect.Effect<void, ProviderError> => {
        const walk = ChildProcess.make(hostKillScript(handle.pid, signal.replace(/^SIG/, "")), { shell: true })
        return Effect.scoped(
          Effect.gen(function*() {
            const running = yield* options.spawner.spawn(walk).pipe(
              Effect.mapError(failure("unknown", `the signal ${signal} could not be delivered`))
            )
            const result = yield* gather(running, `kill -s ${signal}`)
            if (result.code !== 0) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unknown",
                  message: `the signal ${signal} could not be delivered: ${result.stderr.trim()}`
                })
              )
            }
          })
        )
      }
      const session: Session = {
        id: sessionKey,
        remoteId: workdir,
        workdir,
        spawn: Effect.fnUntraced(function*(command, spawnOptions) {
          const settings: ChildProcess.CommandOptions = {
            shell: true,
            cwd: resolve(spawnOptions.cwd ?? ""),
            // The caller's variables extend the host environment the way
            // `docker exec --env` extends a container's; replacing it would
            // strip PATH from every spawn that sets a single variable.
            ...spawnOptions.env === undefined ? {} : { env: spawnOptions.env, extendEnv: true },
            ...spawnOptions.stdin === undefined ? {} : { stdin: Stream.make(spawnOptions.stdin) }
          }
          const handle = yield* options.spawner.spawn(ChildProcess.make(command, settings)).pipe(
            Effect.mapError(failure("spawn_error", `\`${command}\` could not start`))
          )
          const raw = remoteProcessOf(handle, command)
          let ended = false
          const process: RemoteProcess = {
            ...raw,
            exitCode: Effect.tap(raw.exitCode, () =>
              Effect.sync(() => {
                ended = true
              }))
          }
          // The contract says a spawn's scope IS the process's lifetime.
          // Closing the scope tears down only the handle the host spawner
          // owns, which reaches the `sh -c` wrapper and nothing it forked, so
          // the finalizer runs the same whole-tree walk `kill` runs — unless
          // the command has already been seen to end, because the pid it named
          // may belong to someone else by now.
          yield* Effect.addFinalizer(() =>
            ended ? Effect.void : Effect.ignore(deliver(handle, "SIGTERM"), { log: "Warn" })
          )
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
            /* v8 ignore next 3 -- session paths are absolute under an absolute root, so only a write to the filesystem root itself could skip parent creation */
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
            return deliver(handle, signal)
          }),
        ping: Effect.void,
        // Native overrides for the derived filesystem. They take the path
        // they are handed: `Sandbox.fileSystem` installs an override THROUGH
        // its workdir resolver, so the rooting rule lives in one place rather
        // than being restated by every adapter that supplies overrides.
        files: {
          exists: options.fs.exists,
          stat: options.fs.stat,
          readDirectory: options.fs.readDirectory,
          makeDirectory: options.fs.makeDirectory,
          remove: options.fs.remove,
          rename: options.fs.rename,
          realPath: options.fs.realPath,
          readLink: options.fs.readLink
        } satisfies Partial<FileSystem.FileSystem>
      }
      return session
    })
})
