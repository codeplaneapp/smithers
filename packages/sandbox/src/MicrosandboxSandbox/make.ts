/**
 * Constructs the Microsandbox microVM provider.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
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

/**
 * How the provider reaches its SDK and shapes each session's microVM.
 *
 * @category models
 * @since 0.1.0
 */
export interface MicrosandboxSandboxOptions {
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

const configure = (builder: Builder, options: MicrosandboxSandboxOptions, sticky: boolean): Builder => {
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
  options: MicrosandboxSandboxOptions,
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
  stdin: Uint8Array | undefined,
  code: ProviderErrorCode,
  message: string
): Effect.Effect<ExecOutput, ProviderError> =>
  attempt(
    async () => {
      // `-c`, not `-lc`: a login shell runs the image's profile scripts, and
      // anything those print lands ahead of the command's own output.
      const handle = await sandbox.execStreamWith(shell, (builder) => {
        const configured = builder.args(["-c", command]).cwd(cwd).envs(env)
        return stdin === undefined ? configured : configured.stdinBytes(stdin)
      })
      // Microsandbox exposes one drain for stdout, stderr, and status. Calling
      // collect more than once consumes an already-drained command handle.
      return await handle.collect()
    },
    code,
    message
  )

const processOf = (output: ExecOutput): RemoteProcess => ({
  stdout: Stream.make(output.stdoutBytes()),
  stderr: Stream.make(output.stderrBytes()),
  exitCode: Effect.succeed(output.code)
})

/**
 * The SDK wraps every guest filesystem failure in one error kind, so absence
 * is recognized by the guest's own ENOENT text riding in the message.
 */
const isMissingFile = (cause: unknown): boolean =>
  Reflect.get(Object(cause), "code") === "sandboxFsOps" &&
  /no such file or directory/i.test(messageOf(cause))

/**
 * Builds a sandbox provider backed by local Microsandbox microVMs.
 *
 * Machine creation is registered as a scoped resource before guest setup, so
 * a microVM that boots but cannot prepare its workspace is stopped. Commands
 * apply the workdir per execution because Microsandbox validates a builder
 * workdir before the selected image has booted; a relative `cwd` is rooted at
 * the session workdir and standard input rides the exec builder's own byte
 * channel. File transfer in both directions uses the SDK's byte-typed
 * operations, and process output is surfaced as the SDK's raw output bytes.
 *
 * Ephemeral persistence is the default and stops the machine when the scope
 * closes. Sticky persistence leaves a successfully prepared machine running
 * and reconnects to its deterministic name on the next acquire.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MicrosandboxSandboxOptions): Provider => ({
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
            ? Effect.ignore(
              attempt(() => sandbox.stop(), "unavailable", `the microVM ${name} could not be stopped`),
              { log: "Warn" }
            )
            : Effect.void
      )

      yield* attempt(
        () => opened.sandbox.fs().mkdir(workdir),
        "unavailable",
        `the workspace ${workdir} could not be prepared in ${name}`
      )
      prepared = true

      const resolveCwd = (cwd: string | undefined): string =>
        cwd === undefined || cwd.startsWith("/")
          ? cwd ?? workdir
          : `${workdir}/${cwd.replace(/^(\.\/)+/, "")}`.replace(/\/\.?$/, "")

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
              resolveCwd(spawnOptions.cwd),
              environment(options.env, spawnOptions.env),
              spawnOptions.stdin,
              "spawn_error",
              `\`${command}\` could not run in ${name}`
            ),
            processOf
          ),
        readFile: (path) =>
          Effect.tryPromise({
            try: () => opened.sandbox.fs().read(path),
            catch: (cause) =>
              isMissingFile(cause)
                ? new ProviderError({
                  code: "not_found",
                  message: `the microVM holds nothing at ${path}`,
                  cause
                })
                : failure("unknown", `the microVM could not read ${path}`, cause)
          }),
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
