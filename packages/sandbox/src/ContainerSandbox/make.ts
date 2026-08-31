/**
 * Constructs the container-lifecycle sandbox provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { gather, type GatheredRun, providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"

/**
 * How the provider reaches and shapes its containers.
 *
 * The container CLI runs through the injected spawner, so the module owns no
 * host access: a Node composition passes the platform spawner, and pointing
 * `program` at `podman` or a wrapper script changes the engine without
 * changing the provider.
 *
 * @category models
 * @since 0.1.0
 */
export interface ContainerSandboxOptions {
  /** The spawner the container CLI runs through. */
  readonly spawner: ChildProcessSpawner["Service"]
  /** The image every session's container is created from. */
  readonly image: string
  /** The container CLI. Default `docker`; `podman` speaks the same verbs. */
  readonly program?: string | undefined
  /** The guest workspace path. Default `/workspace`. */
  readonly workdir?: string | undefined
  /** Container-wide environment, applied at creation. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** The engine's network mode for the container, passed verbatim (`none` isolates). */
  readonly network?: string | undefined
  /** Extra `create` arguments, an escape hatch for engine-specific shaping. */
  readonly createArgs?: ReadonlyArray<string> | undefined
  /** The container-name prefix. Default `smthrs-sbx-`. */
  readonly namePrefix?: string | undefined
}

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

/**
 * Builds a sandbox provider whose machines are containers this host's
 * container engine runs.
 *
 * `acquire` creates a deterministically named container from the configured
 * image (`create` then `start`, holding it on `sleep infinity`) and serves
 * the session contract over `exec`: commands run under the guest's `sh`,
 * reads stream bytes out through `cat`, writes stream bytes in through the
 * exec's stdin, and closing the scope removes the container with force,
 * which also ends everything running inside it. A container the name already
 * holds — a crashed run's leftover — is reattached rather than refused, so
 * resuming a session key lands in the machine it had.
 *
 * Per-command `kill` is deliberately absent: signalling the local CLI client
 * does not reliably reach the guest process, and pretending otherwise is the
 * failure the conformance suite exists to catch. Teardown is the kill.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: ContainerSandboxOptions): Provider => {
  const program = options.program ?? "docker"
  const workdir = options.workdir ?? "/workspace"
  const prefix = options.namePrefix ?? "smthrs-sbx-"
  const run = (args: ReadonlyArray<string>): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* options.spawner.spawn(ChildProcess.make(program, [...args])).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${program} ${args[0]}\` could not start`))
        )
        return yield* gather(handle, `${program} ${args[0]}`)
      })
    )
  const step = (
    what: string,
    args: ReadonlyArray<string>
  ): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.flatMap(run(args), (result) =>
      result.code === 0 ? Effect.succeed(result) : Effect.fail(
        new ProviderError({
          code: "unavailable",
          message: `${what}: \`${program} ${args[0]}\` exited ${result.code}: ${result.stderr.trim()}`
        })
      ))
  return {
    acquire: (sessionKey) =>
      Effect.gen(function*() {
        const name = `${prefix}${sessionSlug(sessionKey)}`
        yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const created = yield* run([
              "create",
              "--name",
              name,
              "--workdir",
              workdir,
              ...options.network === undefined ? [] : ["--network", options.network],
              ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
              ...options.createArgs ?? [],
              options.image,
              "sleep",
              "infinity"
            ])
            if (created.code !== 0 && !created.stderr.includes("already in use")) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the container ${name} could not be created from ${options.image}: ${
                    created.stderr.trim()
                  }`
                })
              )
            }
            yield* step(`the container ${name} could not be started`, ["start", name])
            yield* step(`the workspace ${workdir} could not be prepared in ${name}`, [
              "exec",
              name,
              "mkdir",
              "-p",
              workdir
            ])
          }),
          () => Effect.ignore(run(["rm", "--force", name]))
        )
        const session: Session = {
          id: sessionKey,
          remoteId: name,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            const args = [
              "exec",
              "--workdir",
              spawnOptions.cwd ?? workdir,
              ...Object.entries(spawnOptions.env ?? {}).flatMap(([key, value]) =>
                value === undefined ? [] : ["--env", `${key}=${value}`]
              ),
              name,
              "sh",
              "-c",
              command
            ]
            const handle = yield* options.spawner.spawn(ChildProcess.make(program, args)).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${name}`))
            )
            return remoteProcessOf(handle, command)
          }),
          readFile: (path) =>
            Effect.flatMap(
              run([
                "exec",
                name,
                "sh",
                "-c",
                `test -e ${CommandLine.quote(path)} || exit 9; cat ${CommandLine.quote(path)}`
              ]),
              (result) =>
                result.code === 0
                  ? Effect.succeed(result.stdout)
                  : result.code === 9
                  ? Effect.fail(
                    new ProviderError({ code: "not_found", message: `the container holds nothing at ${path}` })
                  )
                  : Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the container could not read ${path}: ${result.stderr.trim()}`
                    })
                  )
            ),
          writeFile: (path, content) =>
            Effect.scoped(
              Effect.gen(function*() {
                const parent = parentOf(path)
                const script = parent === undefined
                  ? `cat > ${CommandLine.quote(path)}`
                  : `mkdir -p ${CommandLine.quote(parent)} && cat > ${CommandLine.quote(path)}`
                const handle = yield* options.spawner.spawn(
                  ChildProcess.make(program, ["exec", "--interactive", name, "sh", "-c", script], {
                    stdin: Stream.make(content)
                  })
                ).pipe(Effect.mapError(providerFailure("spawn_error", `the write to ${path} could not start`)))
                const result = yield* gather(handle, script)
                if (result.code !== 0) {
                  return yield* Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the container could not write ${path}: ${result.stderr.trim()}`
                    })
                  )
                }
              })
            ),
          ping: Effect.flatMap(run(["exec", name, "true"]), (result) =>
            result.code === 0 ? Effect.void : Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `the container ${name} did not answer: ${result.stderr.trim()}`
              })
            ))
        }
        return session
      })
  }
}
