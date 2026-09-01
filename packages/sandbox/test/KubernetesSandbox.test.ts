import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Exit, PlatformError, Sink, Stream } from "effect"
import * as Scope from "effect/Scope"
import type { ChildProcess } from "effect/unstable/process"
import {
  type ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as KubernetesSandbox from "../src/KubernetesSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface Call {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly stdin: Uint8Array | undefined
}

interface Response {
  readonly stdout?: string | Uint8Array | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly failSpawn?: boolean | undefined
  readonly failObserve?: boolean | undefined
}

interface Pod {
  readonly files: Map<string, Uint8Array>
  readonly env: Map<string, string>
}

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const whole = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    whole.set(chunk, offset)
    offset += chunk.length
  }
  return whole
}

const chunk = (
  value: string | Uint8Array | undefined
): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
  value === undefined || value.length === 0
    ? Stream.empty
    : Stream.fromArray([typeof value === "string" ? encoder.encode(value) : value])

const unquote = (token: string): string =>
  token.startsWith("'") && token.endsWith("'")
    ? token.slice(1, -1).replaceAll("'\\''", "'")
    : token

const encodedBase64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const decodedBase64 = (text: Uint8Array): Uint8Array =>
  Uint8Array.from(atob(decoder.decode(text)), (byte) => byte.charCodeAt(0))

/**
 * A small in-memory Kubernetes API behind kubectl's real command shapes.
 *
 * It models server-side Pod uniqueness, deletion, exec exit propagation,
 * stdin transport, and the shell tools the provider requires. Fault hooks
 * replace an invocation before the API mutates, matching transport and server
 * failures rather than adapting the fake to the provider's desired outcome.
 */
const cluster = (
  fault: (args: ReadonlyArray<string>) => Response | undefined = () => undefined
) => {
  const calls: Array<Call> = []
  const pods = new Map<string, Pod>()
  const running = new Map<string, Deferred.Deferred<number>>()

  const spawner: ChildProcessSpawner["Service"] = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines here" })
        )
      }
      const stdinOption = command.options.stdin
      const stdin = Stream.isStream(stdinOption)
        ? concat(yield* Stream.runCollect(stdinOption as Stream.Stream<Uint8Array>))
        : undefined
      calls.push({ file: command.command, args: command.args, stdin })
      const injected = fault(command.args)
      if (injected?.failSpawn === true) {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "kubectl missing" })
        )
      }

      const args = [...command.args]
      while (["--context", "--namespace", "--kubeconfig"].includes(args[0] ?? "")) args.splice(0, 2)
      let response: Response = injected ?? {}
      let pending: Deferred.Deferred<number> | undefined

      if (injected === undefined && args[0] === "run") {
        const name = args[1]!
        if (pods.has(name)) {
          response = {
            exitCode: 1,
            stderr: `Error from server (AlreadyExists): pods "${name}" already exists\n`
          }
        } else {
          const env = new Map<string, string>()
          for (let index = 0; index < args.length; index++) {
            if (args[index] !== "--env") continue
            const assignment = args[index + 1]!
            const separator = assignment.indexOf("=")
            env.set(assignment.slice(0, separator), assignment.slice(separator + 1))
          }
          pods.set(name, { files: new Map(), env })
        }
      } else if (injected === undefined && args[0] === "wait") {
        const name = args.find((arg) => arg.startsWith("pod/"))?.slice(4)
        response = name !== undefined && pods.has(name)
          ? {}
          : { exitCode: 1, stderr: "Error from server (NotFound): pods not found\n" }
      } else if (injected === undefined && args[0] === "delete") {
        pods.delete(args[1]!.slice(4))
      } else if (injected === undefined && args[0] === "exec") {
        const interactive = args[1] === "-i"
        const name = args[interactive ? 2 : 1]!
        const pod = pods.get(name)
        if (pod === undefined) {
          response = { exitCode: 1, stderr: `Error from server (NotFound): pods "${name}" not found\n` }
        } else {
          const separator = args.indexOf("--")
          const guest = args.slice(separator + 1)
          if (guest[0] === "true") {
            response = {}
          } else {
            const script = guest[2]!
            if (script.includes("base64 -d > ")) {
              const path = unquote(script.slice(script.lastIndexOf("> ") + 2))
              pod.files.set(path, decodedBase64(stdin ?? new Uint8Array()))
            } else if (script.includes("; base64 ")) {
              const path = unquote(script.slice(script.lastIndexOf("; base64 ") + 9))
              const bytes = pod.files.get(path)
              response = bytes === undefined
                ? { exitCode: 9 }
                : { stdout: `${encodedBase64(bytes)}\n` }
            } else if (script.includes("kids()")) {
              const pidfile = script.match(/cat (\/tmp\/\.smthrs-sbx\/\d+\.pid)/)?.[1]
              const exit = pidfile === undefined ? undefined : running.get(pidfile)
              if (exit !== undefined) yield* Deferred.succeed(exit, 143)
            } else if (script.includes("exec sh -c ")) {
              const marker = "exec sh -c "
              const guestCommand = unquote(script.slice(script.lastIndexOf(marker) + marker.length))
              const setup = script.slice(0, script.lastIndexOf(" && echo $$"))
              const settings = setup.split(" && ")
              const cwd = unquote(settings[0]!.slice(3))
              const env = new Map(pod.env)
              for (const setting of settings.slice(1)) {
                const assignment = unquote(setting.slice("export ".length))
                const assignmentSeparator = assignment.indexOf("=")
                env.set(assignment.slice(0, assignmentSeparator), assignment.slice(assignmentSeparator + 1))
              }
              if (guestCommand === "pwd") {
                response = { stdout: `${cwd}\n` }
              } else if (guestCommand === `printf '%s' "$SANDBOX_CONFORMANCE"`) {
                response = { stdout: env.get("SANDBOX_CONFORMANCE") ?? "" }
              } else if (guestCommand.startsWith("printf '") && guestCommand.endsWith("'")) {
                response = { stdout: guestCommand.slice(8, -1) }
              } else if (guestCommand.startsWith("exit ")) {
                response = { exitCode: Number(guestCommand.slice(5)) }
              } else if (guestCommand === "sleep 60") {
                pending = yield* Deferred.make<number>()
                const pidfile = script.match(/echo \$\$ > (\/tmp\/\.smthrs-sbx\/\d+\.pid)/)![1]!
                running.set(pidfile, pending)
              } else {
                response = { exitCode: 127, stderr: `sh: ${guestCommand}: not found\n` }
              }
            }
          }
        }
      }

      return makeHandle({
        pid: ProcessId(1),
        exitCode: injected?.failObserve === true
          ? Effect.fail(
            PlatformError.badArgument({ module: "ChildProcess", method: "exitCode", description: "lost" })
          )
          : pending === undefined
          ? Effect.succeed(ExitCode(response.exitCode ?? 0))
          : Effect.map(Deferred.await(pending), ExitCode),
        isRunning: Effect.succeed(pending !== undefined),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: chunk(response.stdout),
        stderr: chunk(response.stderr),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  return { calls, pods, spawner }
}

const acquired = <A, E>(
  provider: ReturnType<typeof KubernetesSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("run-1"), body))

describe("KubernetesSandbox", () => {
  it.effect("threads shaping and global flags through the full Pod lifecycle", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "img:tag",
        namespace: "test-ns",
        program: "k",
        context: "test-context",
        kubeconfig: "/tmp/kube config",
        workdir: "/work dir",
        env: { SEED: "1" },
        labels: { app: "sandbox", tier: "test" },
        resources: {
          requests: { cpu: "10m", memory: "16Mi" },
          limits: { cpu: "100m", memory: "64Mi" }
        },
        serviceAccount: "runner",
        nodeSelector: { "kubernetes.io/os": "linux" },
        createArgs: ["--image-pull-policy", "IfNotPresent"],
        namePrefix: "T_"
      })
      const session = yield* acquired(provider, (session) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* session.writeFile("/work dir/file.bin", new Uint8Array([1, 2]))
            yield* session.readFile("/work dir/file.bin")
            const remote = yield* session.spawn("sleep 60", {})
            yield* session.kill!(remote, "SIGTERM")
            yield* remote.exitCode
            yield* session.ping!
            return session
          })
        ))
      expect(session).toMatchObject({ id: "run-1", workdir: "/work dir" })
      expect(session.remoteId.startsWith("t-run-1-")).toBe(true)
      const globals = [
        "--context",
        "test-context",
        "--namespace",
        "test-ns",
        "--kubeconfig",
        "/tmp/kube config"
      ]
      for (const call of fake.calls) {
        expect(call.file).toBe("k")
        expect(call.args.slice(0, globals.length)).toEqual(globals)
      }
      const localCalls = fake.calls.map((call) => call.args.slice(globals.length))
      const created = localCalls.find((args) => args[0] === "run")!
      expect(created.slice(0, 12)).toEqual([
        "run",
        session.remoteId,
        "--image",
        "img:tag",
        "--restart",
        "Never",
        "--env",
        "SEED=1",
        "--labels",
        "app=sandbox,tier=test",
        "--override-type",
        "strategic"
      ])
      const overrides = JSON.parse(created[13]!)
      expect(overrides).toEqual({
        apiVersion: "v1",
        spec: {
          serviceAccountName: "runner",
          nodeSelector: { "kubernetes.io/os": "linux" },
          containers: [{
            name: session.remoteId,
            resources: {
              requests: { cpu: "10m", memory: "16Mi" },
              limits: { cpu: "100m", memory: "64Mi" }
            }
          }]
        }
      })
      expect(created.slice(14)).toEqual([
        "--image-pull-policy",
        "IfNotPresent",
        "--command",
        "--",
        "sleep",
        "infinity"
      ])
      expect(localCalls.find((args) => args[0] === "wait")).toEqual([
        "wait",
        "--for=condition=Ready",
        `pod/${session.remoteId}`,
        "--timeout=300s"
      ])
      expect(localCalls.find((args) => args.at(-1)?.startsWith("mkdir -p") === true)!.at(-1)).toBe(
        "mkdir -p '/work dir' && rm -rf /tmp/.smthrs-sbx && mkdir -p /tmp/.smthrs-sbx"
      )
      expect(localCalls.find((args) => args[0] === "delete")).toEqual([
        "delete",
        `pod/${session.remoteId}`,
        "--force",
        "--grace-period=0"
      ])
    }))

  it.effect("reattaches an existing Pod and preserves its files", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine" })
      const leaked = yield* Scope.make()
      const first = yield* Effect.provideService(provider.acquire("resume"), Scope.Scope, leaked)
      yield* first.writeFile(`${first.workdir}/kept.bin`, new Uint8Array([0, 255, 1]))
      const resumed = yield* Effect.scoped(
        Effect.gen(function*() {
          const second = yield* provider.acquire("resume")
          const bytes = yield* second.readFile(`${second.workdir}/kept.bin`)
          return { remoteId: second.remoteId, bytes }
        })
      )
      expect(resumed.remoteId).toBe(first.remoteId)
      expect(Array.from(resumed.bytes)).toEqual([0, 255, 1])
      const createCalls = fake.calls.filter((call) => call.args[0] === "run")
      expect(createCalls).toHaveLength(2)
      expect(yield* Scope.close(leaked, Exit.void)).toBeUndefined()
    }))

  it.effect("deletes a newly created Pod when Ready or workspace setup fails", () =>
    Effect.gen(function*() {
      const notReady = cluster((args) => args[0] === "wait" ? { exitCode: 1, stderr: "timed out" } : undefined)
      const waitError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: notReady.spawner, image: "img" }), Effect.succeed)
      )
      expect((waitError as ProviderError).message).toContain("did not become Ready")
      expect(notReady.calls.some((call) => call.args[0] === "delete")).toBe(true)
      expect(notReady.pods.size).toBe(0)

      const noWorkspace = cluster((args) =>
        args[0] === "exec" && args.at(-1)?.startsWith("mkdir -p") === true
          ? { exitCode: 1, stderr: "read-only filesystem" }
          : undefined
      )
      const setupError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: noWorkspace.spawner, image: "img" }), Effect.succeed)
      )
      expect((setupError as ProviderError).message).toContain("could not be prepared")
      expect(noWorkspace.calls.some((call) => call.args[0] === "delete")).toBe(true)
      expect(noWorkspace.pods.size).toBe(0)
    }))

  it.effect("refuses create failures and restates transport failures", () =>
    Effect.gen(function*() {
      const denied = cluster((args) =>
        args[0] === "run" ? { exitCode: 1, stderr: "Error from server (Forbidden): denied" } : undefined
      )
      const deniedError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: denied.spawner, image: "private" }), Effect.succeed)
      )
      expect((deniedError as ProviderError).code).toBe("unavailable")
      expect((deniedError as ProviderError).message).toContain("Forbidden")
      expect(denied.calls.some((call) => call.args[0] === "delete")).toBe(false)

      const missing = cluster((args) => args[0] === "run" ? { failSpawn: true } : undefined)
      const spawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: missing.spawner, image: "img" }), Effect.succeed)
      )
      expect((spawnError as ProviderError).code).toBe("spawn_error")

      const lossy = cluster((args) => args[0] === "run" ? { failObserve: true } : undefined)
      const observeError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: lossy.spawner, image: "img" }), Effect.succeed)
      )
      expect((observeError as ProviderError).code).toBe("unknown")
    }))

  it.effect("spawns with guest cwd and environment and delivers real kill scripts", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img" })
      yield* acquired(provider, (session) =>
        Effect.scoped(
          Effect.gen(function*() {
            const first = yield* session.spawn("pwd", { env: { KEPT: "two words", DROPPED: undefined } })
            expect(yield* Stream.mkString(Stream.decodeText(first.stdout))).toBe("/workspace\n")
            const second = yield* session.spawn("sleep 60", { cwd: "/other place" })
            yield* session.kill!(second, "SIGTERM")
            expect(yield* second.exitCode).toBe(143)
          })
        ))
      const spawnCalls = fake.calls.filter((call) => call.args.at(-1)?.includes("exec sh -c") === true)
      expect(spawnCalls[0]!.args.slice(0, 2)).toEqual(["exec", spawnCalls[0]!.args[1]!])
      expect(spawnCalls[0]!.args.at(-1)).toContain("cd /workspace && export 'KEPT=two words'")
      expect(spawnCalls[0]!.args.at(-1)).not.toContain("DROPPED")
      expect(spawnCalls[1]!.args.at(-1)).toContain("cd '/other place'")
      const kill = fake.calls.find((call) => call.args.at(-1)?.includes("kids()") === true)
      expect(kill!.args.at(-1)).toContain("while [ ! -s /tmp/.smthrs-sbx/1.pid ]")
      expect(kill!.args.at(-1)).toContain("kill -s TERM")

      const refused = cluster((args) =>
        args.at(-1)?.includes("kids()") === true ? { exitCode: 1, stderr: "exec refused" } : undefined
      )
      const killError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refused.spawner, image: "img" }), (session) =>
          Effect.scoped(
            Effect.flatMap(session.spawn("sleep 60", {}), (process) => session.kill!(process, "SIGKILL"))
          ))
      )
      expect((killError as ProviderError).code).toBe("unknown")
      expect((killError as ProviderError).message).toContain("SIGKILL")
    }))

  it.effect("round-trips bytes through base64 and classifies read and write failures", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "img" })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const binary = new Uint8Array([0, 255, 254, 10, 13, 7])
          yield* session.writeFile("/workspace/deep/out.bin", binary)
          yield* session.writeFile("/root.bin", new Uint8Array())
          expect(Array.from(yield* session.readFile("/workspace/deep/out.bin"))).toEqual(Array.from(binary))
          expect(yield* session.readFile("/root.bin")).toEqual(new Uint8Array())
          const absent = yield* Effect.flip(session.readFile("/workspace/absent"))
          expect((absent as ProviderError).code).toBe("not_found")
        }))
      const writes = fake.calls.filter((call) => call.args.includes("-i"))
      expect(decoder.decode(writes[0]!.stdin)).toBe("AP/+Cg0H")
      expect(writes[0]!.args.at(-1)).toBe(
        "mkdir -p /workspace/deep && base64 -d > /workspace/deep/out.bin"
      )
      expect(writes[1]!.args.at(-1)).toBe("base64 -d > /root.bin")

      const badRead = cluster((args) =>
        args.at(-1)?.includes("base64 /workspace/bad") === true ? { stdout: "%%%" } : undefined
      )
      const badBase64 = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: badRead.spawner, image: "img" }), (session) =>
          session.readFile("/workspace/bad"))
      )
      expect((badBase64 as ProviderError).message).toContain("invalid base64")

      const refusedRead = cluster((args) =>
        args.at(-1)?.includes("base64 /workspace/locked") === true
          ? { exitCode: 1, stderr: "permission denied" }
          : undefined
      )
      const readError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refusedRead.spawner, image: "img" }), (session) =>
          session.readFile("/workspace/locked"))
      )
      expect((readError as ProviderError).code).toBe("unknown")
      expect((readError as ProviderError).message).toContain("permission denied")

      const refusedWrite = cluster((args) =>
        args.includes("-i") ? { exitCode: 1, stderr: "read-only filesystem" } : undefined
      )
      const writeError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: refusedWrite.spawner, image: "img" }), (session) =>
          session.writeFile("/workspace/out", new Uint8Array([1])))
      )
      expect((writeError as ProviderError).code).toBe("unknown")

      const missingExec = cluster((args) =>
        args.includes("-i") ? { failSpawn: true } : undefined
      )
      const writeSpawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: missingExec.spawner, image: "img" }), (session) =>
          session.writeFile("/workspace/out", new Uint8Array([1])))
      )
      expect((writeSpawnError as ProviderError).code).toBe("spawn_error")
    }))

  it.effect("answers ping and spawn failures honestly", () =>
    Effect.gen(function*() {
      const dead = cluster((args) => args.at(-1) === "true" ? { exitCode: 1, stderr: "pod gone" } : undefined)
      const pingError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: dead.spawner, image: "img" }), (session) => session.ping!)
      )
      expect((pingError as ProviderError).code).toBe("unavailable")

      const noExec = cluster((args) => args.at(-1)?.includes("exec sh -c") === true ? { failSpawn: true } : undefined)
      const spawnError = yield* Effect.flip(
        acquired(KubernetesSandbox.make({ spawner: noExec.spawner, image: "img" }), (session) =>
          Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
      )
      expect((spawnError as ProviderError).code).toBe("spawn_error")
    }))

  it.effect("handles empty resources and bounds sanitized Pod names", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({
        spawner: fake.spawner,
        image: "img",
        resources: {},
        namePrefix: "INVALID_PREFIX_THAT_IS_MUCH_TOO_LONG_TO_FIT_WITH_THE_COMPLETE_SESSION_SLUG_"
      })
      const session = yield* Effect.scoped(provider.acquire("UPPER_case.with/a/very/long/session/key"))
      expect(session.remoteId).toMatch(/^[a-z0-9-]+$/)
      expect(session.remoteId).toHaveLength(63)
      const create = fake.calls[0]!.args
      const overrides = JSON.parse(create[create.indexOf("--overrides") + 1]!)
      expect(overrides.spec.containers[0].resources).toEqual({})
    }))

  it.effect("passes SandboxConformance against the faithful kubectl fake", () =>
    Effect.gen(function*() {
      const fake = cluster()
      const provider = KubernetesSandbox.make({ spawner: fake.spawner, image: "alpine:3.20" })
      const violations = yield* SandboxConformance.check(provider, {
        provides: { kill: true, ping: true }
      })
      expect(violations).toEqual([])
    }))
})
