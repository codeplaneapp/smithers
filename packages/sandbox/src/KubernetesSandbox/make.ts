/**
 * Constructs the Kubernetes Pod sandbox provider.
 *
 * @since 0.1.0
 */
import * as CommandLine from "@smthrs/kernel/CommandLine"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { decodeBase64Bytes, encodeBase64Bytes } from "../internal/base64.ts"
import { cancelGuard, killScript } from "../internal/killScript.ts"
import { gather, type GatheredRun, providerFailure, remoteProcessOf } from "../internal/localProcess.ts"
import { sessionSlug } from "../internal/sessionSlug.ts"
import type { RemoteProcess } from "../RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../Sandbox/Provider.ts"
import type { Session } from "../Sandbox/Session.ts"

interface ResourceValues {
  readonly cpu?: string | undefined
  readonly memory?: string | undefined
}

/**
 * The Pod's CPU and memory requests and limits, as Kubernetes names them.
 *
 * @category models
 * @since 0.1.0
 */
export interface KubernetesSandboxResources {
  readonly requests?: ResourceValues | undefined
  readonly limits?: ResourceValues | undefined
}

/**
 * How the provider reaches its cluster and shapes each session's Pod.
 *
 * @category models
 * @since 0.1.0
 */
export interface KubernetesSandboxOptions {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly image: string
  readonly namespace?: string | undefined
  readonly program?: string | undefined
  readonly context?: string | undefined
  readonly kubeconfig?: string | undefined
  readonly workdir?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly labels?: Readonly<Record<string, string>> | undefined
  readonly resources?: KubernetesSandboxResources | undefined
  readonly serviceAccount?: string | undefined
  readonly nodeSelector?: Readonly<Record<string, string>> | undefined
  readonly createArgs?: ReadonlyArray<string> | undefined
  readonly namePrefix?: string | undefined
}

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

const decoder = new TextDecoder()
const pidDirectory = "/tmp/.smthrs-sbx"
const readyTimeout = "300s"
const maximumPodNameLength = 63

/**
 * The phases in which a Pod will never run another command. A leftover in one
 * of these is a corpse wearing the session's name, not a machine to reattach:
 * `kubectl wait --for=condition=Ready` would block on it for the full timeout
 * and `exec` would refuse it, so it is deleted and replaced instead.
 */
const terminalPhases = new Set(["Succeeded", "Failed"])

const podNameOf = (prefix: string, sessionKey: string): string => {
  const slug = sessionSlug(sessionKey).toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")
  const candidate = `${prefix.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}${slug}`
    .replaceAll(/^-+|-+$/g, "")
  if (candidate.length <= maximumPodNameLength) return candidate
  const digest = slug.slice(slug.lastIndexOf("-"))
  return `${candidate.slice(0, maximumPodNameLength - digest.length).replace(/-+$/, "")}${digest}`
}

const overrideArgs = (name: string, options: KubernetesSandboxOptions): ReadonlyArray<string> => {
  const spec = {
    ...options.serviceAccount === undefined ? {} : { serviceAccountName: options.serviceAccount },
    ...options.nodeSelector === undefined ? {} : { nodeSelector: options.nodeSelector },
    ...options.resources === undefined
      ? {}
      : {
        containers: [{
          name,
          resources: {
            ...options.resources.requests === undefined ? {} : { requests: options.resources.requests },
            ...options.resources.limits === undefined ? {} : { limits: options.resources.limits }
          }
        }]
      }
  }
  return Object.keys(spec).length === 0
    ? []
    : ["--override-type", "strategic", "--overrides", JSON.stringify({ apiVersion: "v1", spec })]
}

/**
 * Builds a sandbox provider whose machines are Kubernetes Pods driven through
 * an injected `kubectl` spawner.
 *
 * The provider creates or reattaches a deterministically named Pod, waits for
 * it to become Ready, and registers forced deletion as the acquiring scope's
 * finalizer. A leftover Pod already in a terminal phase (Succeeded or Failed)
 * is not reattached: `kubectl wait` would block on it for its whole timeout,
 * so on `AlreadyExists` the provider inspects the phase and replaces a
 * terminal Pod with a fresh one. Commands and file transfers use
 * `kubectl exec`, so no host filesystem or platform module is required. File
 * contents cross the text boundary as base64 — written through the exec's
 * stdin, read back with `base64 < path`, a redirect every guest `base64`
 * accepts — and remain byte exact.
 *
 * `spawn` honors the whole session contract. A command's `stdin` bytes travel
 * on the exec's own input channel (`--stdin`), a relative `cwd` is rooted at
 * {@link Session.workdir} before the script's `cd`, and the environment is
 * applied with `env(1)` rather than `export`, because `export` refuses any
 * key that is not a shell identifier and would abort the whole command for an
 * env Node accepts. Closing a spawn's scope is the process's lifetime ending:
 * unless the command was already observed to end, the guest process is
 * signalled through the same pid-walk `kill` uses, so a scope cannot close on
 * a still-running guest.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: KubernetesSandboxOptions): Provider => {
  const program = options.program ?? "kubectl"
  const workdir = options.workdir ?? "/workspace"
  const prefix = options.namePrefix ?? "smthrs-sbx-"
  const labels = Object.entries(options.labels ?? {})
  const globals = [
    ...options.context === undefined ? [] : ["--context", options.context],
    ...options.namespace === undefined ? [] : ["--namespace", options.namespace],
    ...options.kubeconfig === undefined ? [] : ["--kubeconfig", options.kubeconfig]
  ]
  const run = (args: ReadonlyArray<string>): Effect.Effect<GatheredRun, ProviderError> =>
    Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* options.spawner.spawn(ChildProcess.make(program, [...globals, ...args])).pipe(
          Effect.mapError(providerFailure("spawn_error", `\`${program} ${args[0]}\` could not start`))
        )
        return yield* gather(handle, `${program} ${args[0]}`)
      })
    )
  const step = (what: string, args: ReadonlyArray<string>): Effect.Effect<GatheredRun, ProviderError> =>
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
        const name = podNameOf(prefix, sessionKey)
        const createArgs = [
          "run",
          name,
          "--image",
          options.image,
          "--restart",
          "Never",
          ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          ...labels.length === 0
            ? []
            : ["--labels", labels.map(([key, value]) => `${key}=${value}`).join(",")],
          ...overrideArgs(name, options),
          ...options.createArgs ?? [],
          "--command",
          "--",
          "sleep",
          "infinity"
        ]
        yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const created = yield* run(createArgs)
            if (created.code === 0) return
            if (!/(?:AlreadyExists|already exists)/i.test(created.stderr)) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be created from ${options.image}: ${created.stderr.trim()}`
                })
              )
            }
            // The name is held by a previous acquire's leftover. A live one
            // is reattached; one in a terminal phase is replaced, because the
            // Ready wait below would otherwise block on it until its timeout.
            // A phase that cannot be read leaves the reattach path as it was,
            // and the Ready wait decides whether the machine is usable.
            const phase = yield* run(["get", "pod", name, "-o", "jsonpath={.status.phase}"])
            if (phase.code !== 0 || !terminalPhases.has(decoder.decode(phase.stdout).trim())) return
            yield* step(`the finished pod ${name} could not be replaced`, [
              "delete",
              `pod/${name}`,
              "--force",
              "--grace-period=0"
            ])
            const recreated = yield* run(createArgs)
            if (recreated.code !== 0) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be recreated from ${options.image}: ${recreated.stderr.trim()}`
                })
              )
            }
          }),
          () => Effect.ignore(run(["delete", `pod/${name}`, "--force", "--grace-period=0"]), { log: "Warn" })
        )
        yield* step(`the pod ${name} did not become Ready`, [
          "wait",
          "--for=condition=Ready",
          `pod/${name}`,
          `--timeout=${readyTimeout}`
        ])
        yield* step(`the workspace ${workdir} could not be prepared in ${name}`, [
          "exec",
          name,
          "--",
          // The absolute path prevents a Pod-wide PATH override from
          // disabling the provider's own workspace-preparation shell.
          "/bin/sh",
          "-c",
          `mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`
        ])

        let nextPidfile = 0
        const pidfiles = new WeakMap<RemoteProcess, string>()
        const resolveCwd = (cwd: string | undefined): string =>
          cwd === undefined || cwd.startsWith("/")
            ? cwd ?? workdir
            : `${workdir}/${cwd.replace(/^(\.\/)+/, "")}`.replace(/\/\.?$/, "")
        const deliver = (pidfile: string, signal: string): Effect.Effect<void, ProviderError> =>
          Effect.flatMap(
            run([
              "exec",
              name,
              "--",
              // The absolute path prevents a Pod-wide PATH override from
              // disabling the provider's own signal-delivery shell.
              "/bin/sh",
              "-c",
              killScript(pidfile, signal.replace(/^SIG/, ""))
            ]),
            (result) =>
              result.code === 0 ? Effect.void : Effect.fail(
                new ProviderError({
                  code: "unknown",
                  message: `the signal ${signal} could not be delivered in ${name}: ${result.stderr.trim()}`
                })
              )
          )
        const session: Session = {
          id: sessionKey,
          remoteId: name,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            const pidfile = `${pidDirectory}/${nextPidfile++}.pid`
            const stdin = spawnOptions.stdin
            const entries = Object.entries(spawnOptions.env ?? {})
            const environment = [
              ...entries.flatMap(([key, value]) => value === undefined ? ["-u", CommandLine.quote(key)] : []),
              ...entries.flatMap(([key, value]) => value === undefined ? [] : [CommandLine.quote(`${key}=${value}`)])
            ]
            // `env(1)`, not `export`: export requires a shell identifier and
            // aborts the whole chain for a key Node accepts (`a-b=1`), while
            // env passes any name through. GNU coreutils, busybox, and BSD
            // `env` all support `-u`, so an undefined value deletes a variable
            // the Pod was created with instead of keeping it, which is what
            // `undefined` means for a local command too. Every `-u` precedes
            // every assignment, because `env` stops reading options at the
            // first operand and `env A=1 -u B prog` runs `-u` as the program.
            // The shell after the prefix is absolute for
            // the reason the prefix exists at all: `env` resolves its program
            // through the environment it just built, so a caller's `PATH`
            // override would keep a bare `sh` from ever starting. The pid
            // survives the whole chain: `exec` replaces the recorded shell
            // with env, env replaces itself with `/bin/sh`, and `sh -c` execs
            // a lone simple command.
            const script = [
              `cd ${CommandLine.quote(resolveCwd(spawnOptions.cwd))}`,
              `echo $$ > ${pidfile}`,
              cancelGuard(pidfile),
              `exec ${environment.length === 0 ? "" : `env ${environment.join(" ")} `}/bin/sh -c ${
                CommandLine.quote(command)
              }`
            ].join(" && ")
            const handle = yield* options.spawner.spawn(
              ChildProcess.make(program, [
                ...globals,
                "exec",
                // The exec has a real input channel; it is asked for only
                // when there is input to carry.
                ...stdin === undefined ? [] : ["--stdin"],
                name,
                "--",
                // The absolute path prevents a Pod-wide PATH override from
                // disabling the provider's own command-wrapper shell.
                "/bin/sh",
                "-c",
                script
              ], stdin === undefined ? {} : { stdin: Stream.make(stdin) })
            ).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${name}`))
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
            // Closing the process scope ends the local kubectl client, which
            // the guest does not notice. The contract says the scope IS the
            // process's lifetime, so the finalizer signals the guest side
            // too, unless the command has already been seen to end.
            yield* Effect.addFinalizer(() =>
              ended ? Effect.void : Effect.ignore(deliver(pidfile, "SIGTERM"), { log: "Warn" })
            )
            pidfiles.set(process, pidfile)
            return process
          }),
          kill: (process, signal) =>
            Effect.suspend(() => {
              const pidfile = pidfiles.get(process)
              /* v8 ignore next 3 -- every process returned by spawn is recorded and there is no other process source */
              if (pidfile === undefined) {
                return Effect.fail(new ProviderError({ code: "unknown", message: "unrecognized process" }))
              }
              return deliver(pidfile, signal)
            }),
          readFile: (path) =>
            Effect.flatMap(
              run([
                "exec",
                name,
                "--",
                // The absolute path prevents a Pod-wide PATH override from
                // disabling the provider's own file-read shell.
                "/bin/sh",
                "-c",
                // Redirected, not positional: BSD `base64` takes no file
                // operand, and the redirect reads the same on every guest.
                `test -e ${CommandLine.quote(path)} || exit 9; base64 < ${CommandLine.quote(path)}`
              ]),
              (result) =>
                result.code === 0
                  ? decodeBase64Bytes(result.stdout, `for ${path}`)
                  : result.code === 9
                  ? Effect.fail(new ProviderError({ code: "not_found", message: `the pod holds nothing at ${path}` }))
                  : Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the pod could not read ${path}: ${result.stderr.trim()}`
                    })
                  )
            ),
          writeFile: (path, content) =>
            Effect.scoped(
              Effect.gen(function*() {
                const parent = parentOf(path)
                const script = parent === undefined
                  ? `base64 -d > ${CommandLine.quote(path)}`
                  : `mkdir -p ${CommandLine.quote(parent)} && base64 -d > ${CommandLine.quote(path)}`
                const handle = yield* options.spawner.spawn(
                  ChildProcess.make(program, [
                    ...globals,
                    "exec",
                    "-i",
                    name,
                    "--",
                    // The absolute path prevents a Pod-wide PATH override
                    // from disabling the provider's own file-write shell.
                    "/bin/sh",
                    "-c",
                    script
                  ], {
                    stdin: Stream.make(encodeBase64Bytes(content))
                  })
                ).pipe(Effect.mapError(providerFailure("spawn_error", `the write to ${path} could not start`)))
                const result = yield* gather(handle, script)
                if (result.code !== 0) {
                  return yield* Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the pod could not write ${path}: ${result.stderr.trim()}`
                    })
                  )
                }
              })
            ),
          ping: Effect.flatMap(run(["exec", name, "--", "true"]), (result) =>
            result.code === 0 ? Effect.void : Effect.fail(
              new ProviderError({
                code: "unavailable",
                message: `the pod ${name} did not answer: ${result.stderr.trim()}`
              })
            ))
        }
        return session
      })
  }
}
