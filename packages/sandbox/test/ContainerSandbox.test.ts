import { describe, expect, it } from "@effect/vitest"
import { Effect, PlatformError, Sink, Stream } from "effect"
import type { ChildProcess } from "effect/unstable/process"
import {
  type ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/index.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

interface Call {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string | undefined
}

interface Response {
  readonly stdout?: string | Uint8Array | undefined
  readonly stderr?: string | undefined
  readonly exitCode?: number | undefined
  readonly failSpawn?: boolean | undefined
  readonly failObserve?: boolean | undefined
}

/** A container engine as a script: every CLI invocation answered from a table. */
const engine = (respond: (args: ReadonlyArray<string>) => Response) => {
  const calls: Array<Call> = []
  const chunk = (value: string | Uint8Array | undefined): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.fromArray([typeof value === "string" ? encoder.encode(value) : value])
  const spawner: ChildProcessSpawner["Service"] = makeSpawner((command: ChildProcess.Command) =>
    Effect.gen(function*() {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "no pipelines here" })
        )
      }
      const stdinOption = command.options.stdin
      const stdin = Stream.isStream(stdinOption)
        ? decoder.decode(
          (yield* Stream.runCollect(stdinOption as Stream.Stream<Uint8Array>))
            .reduce((whole, part) => {
              const next = new Uint8Array(whole.length + part.length)
              next.set(whole, 0)
              next.set(part, whole.length)
              return next
            }, new Uint8Array(0))
        )
        : undefined
      const response = respond(command.args)
      calls.push({ file: command.command, args: command.args, stdin })
      if (response.failSpawn === true) {
        return yield* Effect.fail(
          PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "engine gone" })
        )
      }
      return makeHandle({
        pid: ProcessId(1),
        exitCode: response.failObserve === true
          ? Effect.fail(
            PlatformError.badArgument({ module: "ChildProcess", method: "exitCode", description: "lost" })
          )
          : Effect.succeed(ExitCode(response.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
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
  return { spawner, calls }
}

const acquired = <A, E>(
  provider: ReturnType<typeof ContainerSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("run-1"), body))

describe("ContainerSandbox", () => {
  it.effect("drives the full container lifecycle through the engine CLI", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine(() => ({}))
      const provider = ContainerSandbox.make({
        spawner,
        image: "img:tag",
        program: "podman",
        workdir: "/w",
        env: { SEED: "1" },
        network: "none",
        createArgs: ["--memory", "1g"],
        namePrefix: "t-"
      })
      const session = yield* acquired(provider, (session) => Effect.succeed(session))
      expect(session.id).toBe("run-1")
      expect(session.remoteId.startsWith("t-run-1-")).toBe(true)
      expect(session.workdir).toBe("/w")
      expect(calls.map((call) => call.file)).toEqual(["podman", "podman", "podman", "podman"])
      expect(calls[0]!.args).toEqual([
        "create",
        "--name",
        session.remoteId,
        "--workdir",
        "/w",
        "--network",
        "none",
        "--env",
        "SEED=1",
        "--memory",
        "1g",
        "img:tag",
        "sleep",
        "infinity"
      ])
      expect(calls[1]!.args).toEqual(["start", session.remoteId])
      expect(calls[2]!.args).toEqual([
        "exec",
        session.remoteId,
        "sh",
        "-c",
        "mkdir -p /w && rm -rf /tmp/.smthrs-sbx && mkdir -p /tmp/.smthrs-sbx"
      ])
      expect(calls[3]!.args).toEqual(["rm", "--force", session.remoteId])
    }))

  it.effect("reattaches when the name is already in use and refuses other create failures", () =>
    Effect.gen(function*() {
      const reusing = engine((args) =>
        args[0] === "create"
          ? { exitCode: 125, stderr: `the container name is already in use by "abc"` }
          : {}
      )
      const reused = yield* acquired(
        ContainerSandbox.make({ spawner: reusing.spawner, image: "img" }),
        (session) => Effect.succeed(session.remoteId)
      )
      expect(reused.startsWith("smthrs-sbx-")).toBe(true)

      const refusing = engine((args) =>
        args[0] === "create" ? { exitCode: 125, stderr: "no such image" } : {}
      )
      const refusal = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: refusing.spawner, image: "img" }), Effect.succeed)
      )
      expect(refusal).toBeInstanceOf(ProviderError)
      expect((refusal as ProviderError).message).toContain("no such image")
    }))

  it.effect("fails acquisition when the container cannot start or be prepared", () =>
    Effect.gen(function*() {
      const unstartable = engine((args) => args[0] === "start" ? { exitCode: 1, stderr: "dead engine" } : {})
      const startFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: unstartable.spawner, image: "img" }), Effect.succeed)
      )
      expect((startFailure as ProviderError).message).toContain("could not be started")

      const unpreparable = engine((args) => args[1] !== undefined && args[0] === "exec" ? { exitCode: 1, stderr: "ro fs" } : {})
      const prepareFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: unpreparable.spawner, image: "img" }), Effect.succeed)
      )
      expect((prepareFailure as ProviderError).message).toContain("could not be prepared")
    }))

  it.effect("spawns through exec in the right directory with only defined environment", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine((args) => args.includes("sh") ? { stdout: "ran\n" } : {})
      const provider = ContainerSandbox.make({ spawner, image: "img" })
      const output = yield* acquired(provider, (session) =>
        Effect.scoped(
          Effect.flatMap(
            session.spawn("echo ran", { env: { KEPT: "yes", DROPPED: undefined } }),
            (process) => Stream.mkString(Stream.decodeText(process.stdout))
          )
        ).pipe(
          Effect.andThen((first) =>
            Effect.map(
              Effect.scoped(
                Effect.flatMap(session.spawn("pwd", { cwd: "/elsewhere" }), (process) => process.exitCode)
              ),
              (code) => ({ first, code })
            )
          )
        ))
      expect(output).toEqual({ first: "ran\n", code: 0 })
      const spawnCalls = calls.filter((call) => call.args[1] === "--workdir")
      expect(spawnCalls[0]!.args).toEqual([
        "exec",
        "--workdir",
        "/workspace",
        "--env",
        "KEPT=yes",
        spawnCalls[0]!.args[5]!,
        "sh",
        "-c",
        "echo $$ > /tmp/.smthrs-sbx/0.pid; exec sh -c 'echo ran'"
      ])
      expect(spawnCalls[1]!.args.slice(0, 3)).toEqual(["exec", "--workdir", "/elsewhere"])
    }))

  it.effect("reads files back as bytes, distinguishing absence from refusal", () =>
    Effect.gen(function*() {
      const binary = new Uint8Array([0, 200, 10, 0, 7])
      const { spawner } = engine((args) => {
        const script = args.at(-1) ?? ""
        if (args[0] !== "exec" || !args.includes("sh") || !script.includes("cat ")) return {}
        return script.includes("present.bin")
          ? { stdout: binary }
          : script.includes("absent.bin")
          ? { exitCode: 9 }
          : { exitCode: 1, stderr: "cat: permission denied" }
      })
      const provider = ContainerSandbox.make({ spawner, image: "img" })
      const outcome = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          const present = yield* session.readFile("/workspace/present.bin")
          const absent = yield* Effect.flip(session.readFile("/workspace/absent.bin"))
          const refused = yield* Effect.flip(session.readFile("/workspace/locked.bin"))
          return { present: Array.from(present), absent, refused }
        }))
      expect(outcome.present).toEqual([0, 200, 10, 0, 7])
      expect((outcome.absent as ProviderError).code).toBe("not_found")
      expect((outcome.refused as ProviderError).code).toBe("unknown")
      expect((outcome.refused as ProviderError).message).toContain("permission denied")
    }))

  it.effect("writes files through the exec's stdin, creating parents", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine((args) => args.at(-1)?.includes("refused") === true ? { exitCode: 1, stderr: "refused" } : {})
      const provider = ContainerSandbox.make({ spawner, image: "img" })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile("/workspace/deep/tree/out.bin", new Uint8Array([1, 2]))
          yield* session.writeFile("/rootfile", encoder.encode("top"))
          const refused = yield* Effect.flip(session.writeFile("/workspace/refused", new Uint8Array([3])))
          expect((refused as ProviderError).code).toBe("unknown")
        }))
      const writes = calls.filter((call) => call.args.includes("--interactive"))
      expect(writes[0]!.args.slice(0, 2)).toEqual(["exec", "--interactive"])
      expect(writes[0]!.args.at(-1)).toBe("mkdir -p /workspace/deep/tree && cat > /workspace/deep/tree/out.bin")
      expect(writes[0]!.stdin).toBe("")
      expect(writes[1]!.args.at(-1)).toBe("cat > /rootfile")
      expect(writes[1]!.stdin).toBe("top")
    }))

  it.effect("kills a spawned command by pid walk inside the container", () =>
    Effect.gen(function*() {
      const { calls, spawner } = engine(() => ({}))
      const provider = ContainerSandbox.make({ spawner, image: "img" })
      yield* acquired(provider, (session) =>
        Effect.scoped(
          Effect.gen(function*() {
            const process = yield* session.spawn("sleep 60", {})
            yield* session.kill!(process, "SIGTERM")
          })
        ))
      const killCall = calls.find((call) => call.args.at(-1)?.includes("kids()"))
      expect(killCall).toBeDefined()
      expect(killCall!.args.at(-1)).toContain("cat /tmp/.smthrs-sbx/0.pid")
      expect(killCall!.args.at(-1)).toContain("kill -s TERM")

      const refusing = engine((args) => args.at(-1)?.includes("kids()") === true ? { exitCode: 1, stderr: "no exec" } : {})
      const refusal = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: refusing.spawner, image: "img" }), (session) =>
          Effect.scoped(
            Effect.flatMap(session.spawn("sleep 60", {}), (process) => session.kill!(process, "SIGTERM"))
          ))
      )
      expect((refusal as ProviderError).code).toBe("unknown")
      expect((refusal as ProviderError).message).toContain("SIGTERM")
    }))

  it.effect("answers pings from the engine and reports a dead container", () =>
    Effect.gen(function*() {
      const { spawner } = engine((args) => args.includes("true") && args[0] === "exec" ? {} : {})
      const alive = ContainerSandbox.make({ spawner, image: "img" })
      yield* acquired(alive, (session) => session.ping!)

      const dead = engine((args) =>
        args.includes("true") && args[0] === "exec" ? { exitCode: 1, stderr: "not running" } : {}
      )
      const refusal = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: dead.spawner, image: "img" }), (session) => session.ping!)
      )
      expect((refusal as ProviderError).code).toBe("unavailable")
    }))

  it.effect("restates transport failures in the provider vocabulary", () =>
    Effect.gen(function*() {
      const broken = engine((args) => args[0] === "create" ? { failSpawn: true } : {})
      const spawnFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: broken.spawner, image: "img" }), Effect.succeed)
      )
      expect((spawnFailure as ProviderError).code).toBe("spawn_error")

      const lossy = engine((args) => args[0] === "create" ? { failObserve: true } : {})
      const observeFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: lossy.spawner, image: "img" }), Effect.succeed)
      )
      expect((observeFailure as ProviderError).code).toBe("unknown")

      const failingWrite = engine((args) => args.includes("--interactive") ? { failSpawn: true } : {})
      const writeFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: failingWrite.spawner, image: "img" }), (session) =>
          session.writeFile("/workspace/out", new Uint8Array([1])))
      )
      expect((writeFailure as ProviderError).code).toBe("spawn_error")

      const failingExec = engine((args) => args.includes("sh") ? { failSpawn: true } : {})
      const execFailure = yield* Effect.flip(
        acquired(ContainerSandbox.make({ spawner: failingExec.spawner, image: "img" }), (session) =>
          Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
      )
      expect((execFailure as ProviderError).code).toBe("spawn_error")
    }))
})
