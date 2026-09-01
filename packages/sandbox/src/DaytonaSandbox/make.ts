/**
 * Constructs the Daytona Sandbox provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { providerFailure } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Sdk } from "./Sdk.ts"

interface Options {
  /** A configured `Daytona` client instance. */
  readonly sdk: Sdk
  /** An explicit absolute guest workspace, otherwise `getWorkDir()` is used. */
  readonly workdir?: string | undefined
  /** Environment applied to every command before per-spawn overrides. */
  readonly commandEnv?: Readonly<Record<string, string>> | undefined
  /** Prefix for deterministic Daytona sandbox names. Default `smthrs-`. */
  readonly namePrefix?: string | undefined
  /** Timeout used when starting an attached sandbox, in seconds. */
  readonly startTimeoutSeconds?: number | undefined
  /** Timeout used by the blocking deletion finalizer, in seconds. */
  readonly deleteTimeoutSeconds?: number | undefined
}

type VendorSandbox = Awaited<ReturnType<Sdk["get"]>>
type ExecuteResponse = Awaited<ReturnType<VendorSandbox["process"]["executeCommand"]>>

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

const field = (cause: unknown, name: string): unknown =>
  typeof cause === "object" && cause !== null ? Reflect.get(cause, name) : undefined

const missingSandbox = (cause: unknown): boolean => field(cause, "statusCode") === 404

const missingFile = (cause: unknown): boolean => field(cause, "code") === "FILE_NOT_FOUND"

const attempt = <A>(
  thunk: () => Promise<A>,
  code: ProviderError["code"],
  message: string
): Effect.Effect<A, ProviderError> =>
  Effect.tryPromise({ try: thunk, catch: providerFailure(code, `daytona-sandbox: ${message}`) })

const checked = (
  result: ExecuteResponse,
  code: ProviderError["code"],
  message: string
): Effect.Effect<ExecuteResponse, ProviderError> =>
  result.exitCode === 0
    ? Effect.succeed(result)
    : Effect.fail(new ProviderError({ code, message: `${message}: command exited ${result.exitCode}` }))

const machineName = (prefix: string, session: string): string =>
  `${prefix}${sessionSlug(session)}`.toLowerCase().replaceAll(/[._]/g, "-")

/**
 * Builds a provider backed by Daytona sandboxes.
 *
 * A collision-proof name derived from the session key is looked up first. A
 * missing sandbox is created with that name, while an existing one is started
 * before use. Creation or attachment is registered as a scoped resource before
 * start and workspace preparation, so any later failure still runs the
 * blocking delete finalizer. Daytona's byte-native download and stream-upload
 * operations serve file transfer; shell execution creates missing parents.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Provider => ({
  acquire: (sessionKey) =>
    Effect.gen(function*() {
      if (options.workdir !== undefined && !options.workdir.startsWith("/")) {
        return yield* Effect.fail(
          new ProviderError({
            code: "spawn_error",
            message: `daytona-sandbox: workdir must be absolute: ${options.workdir}`
          })
        )
      }
      const name = machineName(options.namePrefix ?? "smthrs-", sessionKey)
      const held = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            try {
              return { sandbox: await options.sdk.get(name), attached: true }
            } catch (cause) {
              if (!missingSandbox(cause)) throw cause
              return { sandbox: await options.sdk.create({ name }), attached: false }
            }
          },
          catch: providerFailure("unavailable", `daytona-sandbox: could not acquire ${name}`)
        }),
        ({ sandbox }) =>
          Effect.ignore(
            attempt(
              () => options.sdk.delete(sandbox, options.deleteTimeoutSeconds ?? 60, true),
              "unknown",
              `could not delete ${name}`
            )
          )
      )
      if (held.attached) {
        yield* attempt(
          () => options.sdk.start(held.sandbox, options.startTimeoutSeconds),
          "unavailable",
          `could not start ${name}`
        )
      }
      const discovered = options.workdir === undefined
        ? yield* attempt(() => held.sandbox.getWorkDir(), "unavailable", `could not discover ${name}'s workdir`)
        : options.workdir
      if (discovered === undefined || !discovered.startsWith("/")) {
        return yield* Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: `daytona-sandbox: ${name} did not report an absolute workdir`
          })
        )
      }
      const workdir = discovered
      const execute = (
        command: string,
        cwd?: string,
        env?: Record<string, string>
      ): Effect.Effect<ExecuteResponse, ProviderError> =>
        attempt(
          () => held.sandbox.process.executeCommand(command, cwd, env),
          "spawn_error",
          `could not execute ${command}`
        )
      const prepare = yield* execute(`mkdir -p ${CommandLine.quote(workdir)}`)
      yield* checked(prepare, "unavailable", `daytona-sandbox: could not prepare ${workdir}`)

      const session: Session = {
        id: sessionKey,
        remoteId: held.sandbox.id,
        workdir,
        spawn: (command, spawnOptions) =>
          Effect.map(
            execute(
              command,
              spawnOptions.cwd ?? workdir,
              Object.fromEntries(
                [...Object.entries(options.commandEnv ?? {}), ...Object.entries(spawnOptions.env ?? {})].filter(
                  (entry): entry is [string, string] => entry[1] !== undefined
                )
              )
            ),
            (result) => ({
              stdout: Stream.make(new TextEncoder().encode(result.result)),
              stderr: Stream.empty,
              exitCode: Effect.succeed(result.exitCode)
            })
          ),
        readFile: (path) =>
          Effect.tryPromise({
            try: () => held.sandbox.fs.downloadFile(path).then((content) => new Uint8Array(content)),
            catch: (cause) =>
              missingFile(cause)
                ? new ProviderError({
                  code: "not_found",
                  message: `daytona-sandbox: no file exists at ${path}`,
                  cause
                })
                : providerFailure("unknown", `daytona-sandbox: could not download ${path}`)(cause)
          }),
        writeFile: (path, content) =>
          Effect.gen(function*() {
            const parent = parentOf(path)
            if (parent !== undefined) {
              const result = yield* execute(`mkdir -p ${CommandLine.quote(parent)}`)
              yield* checked(result, "unknown", `daytona-sandbox: could not create ${parent}`)
            }
            yield* attempt(
              () => held.sandbox.fs.uploadFileStream(content, path),
              "unknown",
              `could not upload ${path}`
            )
          }),
        ping: Effect.gen(function*() {
          const result = yield* execute("true", workdir)
          yield* checked(result, "unavailable", `daytona-sandbox: ${name} did not answer`)
        })
      }
      return session
    })
})
