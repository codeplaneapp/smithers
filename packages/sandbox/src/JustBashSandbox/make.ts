/**
 * Constructs the in-process just-bash sandbox provider.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { providerFailure } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { JustBashLike } from "./JustBashLike.ts"

interface Options {
  /** The interpreter that runs every session command. */
  readonly bash: JustBashLike
  /** The filesystem mounted under the interpreter's own filesystem view. */
  readonly fs: FileSystem.FileSystem
  /** The absolute guest directory containing session workspaces. Default `/workspace`. */
  readonly root?: string | undefined
}

const encoder = new TextEncoder()
const failure = providerFailure

const captured = (text: string): Stream.Stream<Uint8Array, ProviderError> =>
  text === "" ? Stream.empty : Stream.make(encoder.encode(text))

const environment = (
  values: Readonly<Record<string, string | undefined>> | undefined
): Readonly<Record<string, string>> | undefined => {
  if (values === undefined) return undefined
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) resolved[key] = value
  }
  return resolved
}

/**
 * Builds a provider whose machines are just-bash workspaces in one virtual
 * filesystem.
 *
 * Each session key gets a subdirectory below `root`. Commands run through the
 * buffered interpreter, while reads, writes, and native file operations use
 * the injected `FileSystem`. The caller must mount the interpreter and that
 * service on the same tree. In a browser this normally means just-bash and
 * `BrowserFileSystem` both view the same ZenFS volume.
 *
 * This provider is a workspace boundary, not a security boundary. An
 * interpreted command can address anything its shared virtual filesystem
 * permits. Runs are serialized because just-bash has one mutable filesystem
 * view. A spawn completes before it returns, stdout and stderr each replay at
 * most one chunk, and `isRunning` is already false by the time a caller can
 * observe the adapted handle. There is no stdin, signal delivery, separately
 * spawned process pipeline, or incremental output. Consequently sessions
 * omit `kill`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Provider => {
  const root = (options.root ?? "/workspace").replace(/\/+$/, "")
  const gate = Semaphore.makeUnsafe(1)
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const workdir = `${root}/${sessionSlug(sessionKey)}`
        yield* Effect.acquireRelease(
          options.fs.makeDirectory(workdir, { recursive: true }).pipe(
            Effect.mapError(failure("unavailable", `the just-bash workspace ${workdir} could not be created`))
          ),
          () => Effect.ignore(options.fs.remove(workdir, { recursive: true, force: true }))
        )
        const resolve = (path: string): string => {
          if (path.startsWith("/")) return path
          const trimmed = path.replace(/^(\.\/)+/, "")
          return trimmed === "" || trimmed === "." ? workdir : `${workdir}/${trimmed}`
        }
        const session: Session = {
          id: sessionKey,
          remoteId: workdir,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            const env = environment(spawnOptions.env)
            const result = yield* gate.withPermit(
              Effect.uninterruptible(
                Effect.tryPromise({
                  try: () =>
                    options.bash.run(command, {
                      cwd: spawnOptions.cwd ?? workdir,
                      ...(env === undefined ? {} : { env })
                    }),
                  catch: failure("spawn_error", `\`${command}\` could not run through just-bash`)
                })
              )
            )
            return {
              stdout: captured(result.stdout),
              stderr: captured(result.stderr),
              exitCode: Effect.succeed(result.exitCode)
            }
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
          ping: Effect.void,
          files: {
            exists: (path) => options.fs.exists(resolve(path)),
            stat: (path) => options.fs.stat(resolve(path)),
            readDirectory: (path, directoryOptions) => options.fs.readDirectory(resolve(path), directoryOptions),
            makeDirectory: (path, directoryOptions) => options.fs.makeDirectory(resolve(path), directoryOptions),
            remove: (path, removeOptions) => options.fs.remove(resolve(path), removeOptions),
            rename: (oldPath, newPath) => options.fs.rename(resolve(oldPath), resolve(newPath)),
            realPath: (path) => options.fs.realPath(resolve(path)),
            readLink: (path) => options.fs.readLink(resolve(path))
          } satisfies Partial<FileSystem.FileSystem>
        }
        return session
      })
  }
}
