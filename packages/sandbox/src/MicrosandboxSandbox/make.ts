/**
 * Constructs the Microsandbox microVM provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { decodeBase64 } from "../internal/base64.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import type { ProviderErrorCode } from "../RemoteChildProcessSpawner/ProviderError.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"
import type { Sdk } from "./Sdk.ts"

const defaultImage = "oven/bun:1"
const defaultWorkdir = "/workspace"
const defaultShell = "/bin/sh"
const namePrefix = "smthrs-msb-"

interface Options {
  /** The injected Microsandbox SDK module. */
  readonly sdk: Sdk
  /** Boot from this image. Default `oven/bun:1`. */
  readonly image?: string | undefined
  /** Boot from a snapshot instead of an image. The two options are exclusive. */
  readonly snapshot?: string | undefined
  /** The guest workspace and default command directory. Default `/workspace`. */
  readonly workdir?: string | undefined
  /** The guest shell used for command lines. Default `/bin/sh`. */
  readonly shell?: string | undefined
  /** Static environment delivered to every command. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /**
   * `ephemeral` stops the microVM on release. `sticky` deliberately leaves it
   * running so the next acquire of the same session key can reconnect.
   */
  readonly persistence?: "ephemeral" | "sticky" | undefined
  /** Initial virtual CPU count. */
  readonly cpus?: number | undefined
  /** Maximum hotpluggable virtual CPU count. */
  readonly maxCpus?: number | undefined
  /** Initial memory in MiB. */
  readonly memoryMib?: number | undefined
  /** Maximum hotpluggable memory in MiB. */
  readonly maxMemoryMib?: number | undefined
  /** Maximum microVM lifetime in seconds. */
  readonly maxDurationSecs?: number | undefined
  /** Idle reclamation window in seconds. */
  readonly idleTimeoutSecs?: number | undefined
  /** Guest security profile. */
  readonly security?: "default" | "restricted" | undefined
  /** Vendor image pull policy. */
  readonly pullPolicy?: string | undefined
  /** Labels recorded on the microVM. */
  readonly labels?: Readonly<Record<string, string>> | undefined
  /** Named guest scripts planted at boot. */
  readonly scripts?: Readonly<Record<string, string>> | undefined
  /** Run detached from the host process. Sticky sessions default to detached. */
  readonly detached?: boolean | undefined
  /** Boot without guest networking. */
  readonly disableNetwork?: boolean | undefined
}

type Builder = ReturnType<Sdk["Sandbox"]["builder"]>
type VendorSandbox = Awaited<ReturnType<Builder["create"]>>
type ExecOutput = Awaited<ReturnType<Awaited<ReturnType<VendorSandbox["execStreamWith"]>>["collect"]>>

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

const failure = (code: ProviderErrorCode, message: string, cause: unknown): ProviderError =>
  new ProviderError({ code, message: `microsandbox: ${message}: ${messageOf(cause)}`, cause })

const attempt = <A>(
  thunk: () => Promise<A>,
  code: ProviderErrorCode,
  message: string
): Effect.Effect<A, ProviderError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => failure(code, message, cause)
  })

const configure = (builder: Builder, options: Options, sticky: boolean): Builder => {
  let configured = options.snapshot === undefined
    ? builder.image(options.image ?? defaultImage)
    : builder.fromSnapshot(options.snapshot)
  if (options.cpus !== undefined) configured = configured.cpus(options.cpus)
  if (options.maxCpus !== undefined) configured = configured.maxCpus(options.maxCpus)
  if (options.memoryMib !== undefined) configured = configured.memory(options.memoryMib)
  if (options.maxMemoryMib !== undefined) configured = configured.maxMemory(options.maxMemoryMib)
  if (options.security !== undefined) configured = configured.security(options.security)
  if (options.pullPolicy !== undefined) configured = configured.pullPolicy(options.pullPolicy)
  if (options.labels !== undefined) configured = configured.labels({ ...options.labels })
  if (options.scripts !== undefined) configured = configured.scripts({ ...options.scripts })
  if (options.maxDurationSecs !== undefined) configured = configured.maxDuration(options.maxDurationSecs)
  if (options.idleTimeoutSecs !== undefined) configured = configured.idleTimeout(options.idleTimeoutSecs)
  if (options.disableNetwork === true) configured = configured.disableNetwork()
  return configured.ephemeral(!sticky).detached(options.detached ?? sticky)
}

const isAlreadyExists = (cause: unknown): boolean => Reflect.get(Object(cause), "code") === "sandboxAlreadyExists"

const openMachine = (
  options: Options,
  name: string,
  sticky: boolean
): Effect.Effect<{ readonly sandbox: VendorSandbox; readonly created: boolean }, ProviderError> =>
  attempt(
    async () => {
      try {
        return {
          sandbox: await configure(options.sdk.Sandbox.builder(name), options, sticky).create(),
          created: true
        }
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause
        const handle = await options.sdk.Sandbox.get(name)
        const detached = options.detached ?? sticky
        return {
          sandbox: handle.status === "running"
            ? await handle.connect()
            : detached
            ? await handle.startDetached()
            : await handle.start(),
          created: false
        }
      }
    },
    "unavailable",
    `the microVM ${name} could not be opened`
  )

const environment = (
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string | undefined>> | undefined
): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...base, ...override }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )

const execute = (
  sandbox: VendorSandbox,
  shell: string,
  command: string,
  cwd: string,
  env: Record<string, string>,
  code: ProviderErrorCode,
  message: string
): Effect.Effect<ExecOutput, ProviderError> =>
  attempt(
    async () => {
      const handle = await sandbox.execStreamWith(shell, (builder) => builder.args(["-lc", command]).cwd(cwd).envs(env))
      // Microsandbox exposes one drain for stdout, stderr, and status. Calling
      // collect more than once consumes an already-drained command handle.
      return await handle.collect()
    },
    code,
    message
  )

const processOf = (output: ExecOutput): RemoteProcess => ({
  stdout: Stream.make(new TextEncoder().encode(output.stdout())),
  stderr: Stream.make(new TextEncoder().encode(output.stderr())),
  exitCode: Effect.succeed(output.code)
})

/**
 * Builds a sandbox provider backed by local Microsandbox microVMs.
 *
 * Machine creation is registered as a scoped resource before guest setup, so
 * a microVM that boots but cannot prepare its workspace is stopped. Commands
 * apply the workdir per execution because Microsandbox validates a builder
 * workdir before the selected image has booted. Writes use the SDK's byte-safe
 * operation, while reads travel through guest `base64` because the required
 * SDK read operation is UTF-8 text only.
 *
 * Ephemeral persistence is the default and stops the machine when the scope
 * closes. Sticky persistence leaves a successfully prepared machine running
 * and reconnects to its deterministic name on the next acquire.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Provider => ({
  acquire: (sessionKey) =>
    Effect.gen(function*() {
      const name = `${namePrefix}${sessionSlug(sessionKey)}`
      const sticky = options.persistence === "sticky"
      const workdir = options.workdir ?? defaultWorkdir
      const shell = options.shell ?? defaultShell
      if (options.image !== undefined && options.snapshot !== undefined) {
        return yield* Effect.fail(
          new ProviderError({
            code: "unavailable",
            message: "microsandbox: image and snapshot are exclusive; name one"
          })
        )
      }

      let prepared = false
      const opened = yield* Effect.acquireRelease(
        openMachine(options, name, sticky),
        ({ created, sandbox }) =>
          !sticky || created && !prepared
            ? Effect.ignore(attempt(() => sandbox.stop(), "unavailable", `the microVM ${name} could not be stopped`))
            : Effect.void
      )

      yield* attempt(
        () => opened.sandbox.fs().mkdir(workdir),
        "unavailable",
        `the workspace ${workdir} could not be prepared in ${name}`
      )
      prepared = true

      const session: Session = {
        id: sessionKey,
        remoteId: opened.sandbox.name,
        workdir,
        spawn: (command, spawnOptions) =>
          Effect.map(
            execute(
              opened.sandbox,
              shell,
              command,
              spawnOptions.cwd ?? workdir,
              environment(options.env, spawnOptions.env),
              "spawn_error",
              `\`${command}\` could not run in ${name}`
            ),
            processOf
          ),
        readFile: (path) =>
          Effect.flatMap(
            execute(
              opened.sandbox,
              shell,
              `test -e ${CommandLine.quote(path)} || exit 9; base64 ${CommandLine.quote(path)}`,
              workdir,
              environment(options.env, undefined),
              "unknown",
              `the read from ${path} could not run in ${name}`
            ),
            (output) =>
              output.code === 0
                ? decodeBase64(output.stdout(), `while reading ${path}`)
                : output.code === 9
                ? Effect.fail(
                  new ProviderError({ code: "not_found", message: `the microVM holds nothing at ${path}` })
                )
                : Effect.fail(
                  new ProviderError({
                    code: "unknown",
                    message: `the microVM could not read ${path}: ${output.stderr().trim()}`
                  })
                )
          ),
        writeFile: (path, content) =>
          Effect.gen(function*() {
            const parent = parentOf(path)
            if (parent !== undefined) {
              yield* attempt(
                () => opened.sandbox.fs().mkdir(parent),
                "unknown",
                `the parent of ${path} could not be created in ${name}`
              )
            }
            yield* attempt(
              () => opened.sandbox.fs().write(path, content),
              "unknown",
              `the microVM could not write ${path}`
            )
          }),
        ping: Effect.asVoid(
          attempt(
            () => opened.sandbox.fs().readToString("/etc/hostname"),
            "unavailable",
            `the microVM ${name} did not answer`
          )
        )
      }
      return session
    })
})
