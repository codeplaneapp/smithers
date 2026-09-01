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
import { killScript } from "../internal/killScript.ts"
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

interface Resources {
  readonly requests?: ResourceValues | undefined
  readonly limits?: ResourceValues | undefined
}

interface Options {
  readonly spawner: ChildProcessSpawner["Service"]
  readonly image: string
  readonly namespace?: string | undefined
  readonly program?: string | undefined
  readonly context?: string | undefined
  readonly kubeconfig?: string | undefined
  readonly workdir?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly labels?: Readonly<Record<string, string>> | undefined
  readonly resources?: Resources | undefined
  readonly serviceAccount?: string | undefined
  readonly nodeSelector?: Readonly<Record<string, string>> | undefined
  readonly createArgs?: ReadonlyArray<string> | undefined
  readonly namePrefix?: string | undefined
}

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

const pidDirectory = "/tmp/.smthrs-sbx"
const readyTimeout = "300s"
const maximumPodNameLength = 63

const podNameOf = (prefix: string, sessionKey: string): string => {
  const slug = sessionSlug(sessionKey).toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")
  const candidate = `${prefix.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}${slug}`
    .replaceAll(/^-+|-+$/g, "")
  if (candidate.length <= maximumPodNameLength) return candidate
  const digest = slug.slice(slug.lastIndexOf("-"))
  return `${candidate.slice(0, maximumPodNameLength - digest.length).replace(/-+$/, "")}${digest}`
}

const overrideArgs = (name: string, options: Options): ReadonlyArray<string> => {
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
 * finalizer. Commands and file transfers use `kubectl exec`, so no host
 * filesystem or platform module is required. File contents cross the text
 * boundary as base64 and remain byte exact.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Provider => {
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
        yield* Effect.acquireRelease(
          Effect.gen(function*() {
            const created = yield* run([
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
            ])
            if (created.code !== 0 && !/(?:AlreadyExists|already exists)/i.test(created.stderr)) {
              return yield* Effect.fail(
                new ProviderError({
                  code: "unavailable",
                  message: `the pod ${name} could not be created from ${options.image}: ${created.stderr.trim()}`
                })
              )
            }
          }),
          () => Effect.ignore(run(["delete", `pod/${name}`, "--force", "--grace-period=0"]))
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
          "sh",
          "-c",
          `mkdir -p ${CommandLine.quote(workdir)} && rm -rf ${pidDirectory} && mkdir -p ${pidDirectory}`
        ])

        let nextPidfile = 0
        const pidfiles = new WeakMap<RemoteProcess, string>()
        const session: Session = {
          id: sessionKey,
          remoteId: name,
          workdir,
          spawn: Effect.fnUntraced(function*(command, spawnOptions) {
            const pidfile = `${pidDirectory}/${nextPidfile++}.pid`
            const script = [
              `cd ${CommandLine.quote(spawnOptions.cwd ?? workdir)}`,
              ...Object.entries(spawnOptions.env ?? {}).flatMap(([key, value]) =>
                value === undefined ? [] : [`export ${CommandLine.quote(`${key}=${value}`)}`]
              ),
              `echo $$ > ${pidfile}`,
              `exec sh -c ${CommandLine.quote(command)}`
            ].join(" && ")
            const handle = yield* options.spawner.spawn(
              ChildProcess.make(program, [...globals, "exec", name, "--", "sh", "-c", script])
            ).pipe(
              Effect.mapError(providerFailure("spawn_error", `\`${command}\` could not start in ${name}`))
            )
            const process = remoteProcessOf(handle, command)
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
              return Effect.flatMap(
                run(["exec", name, "--", "sh", "-c", killScript(pidfile, signal.replace(/^SIG/, ""))]),
                (result) =>
                  result.code === 0 ? Effect.void : Effect.fail(
                    new ProviderError({
                      code: "unknown",
                      message: `the signal ${signal} could not be delivered in ${name}: ${result.stderr.trim()}`
                    })
                  )
              )
            }),
          readFile: (path) =>
            Effect.flatMap(
              run([
                "exec",
                name,
                "--",
                "sh",
                "-c",
                `test -e ${CommandLine.quote(path)} || exit 9; base64 ${CommandLine.quote(path)}`
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
                  ChildProcess.make(program, [...globals, "exec", "-i", name, "--", "sh", "-c", script], {
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
