import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as MicrosandboxSandbox from "../src/MicrosandboxSandbox/index.ts"
import type { Sdk } from "../src/MicrosandboxSandbox/Sdk.ts"
import type { RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Provider } from "../src/Sandbox/Provider.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Builder = ReturnType<Sdk["Sandbox"]["builder"]>
type VendorSandbox = Awaited<ReturnType<Builder["create"]>>
type VendorHandle = Awaited<ReturnType<Sdk["Sandbox"]["get"]>>
type ExecBuilder = Parameters<Parameters<VendorSandbox["execStreamWith"]>[1]>[0]
type ExecOutput = Awaited<ReturnType<Awaited<ReturnType<VendorSandbox["execStreamWith"]>>["collect"]>>

// -----------------------------------------------------------------------------
// The Microsandbox SDK as a fake: real shells and real files behind the
// vendor's builders and handles.
// -----------------------------------------------------------------------------

// The fake emulates only the vendor transport: the fluent builders and the
// single-drain command handle record what the SDK would carry, and underneath
// every command is a REAL `sh` running against a REAL directory, every guest
// file a real file. Guest-fixed absolute paths — the default `/workspace`, the
// image's `/etc/hostname` — live under the machine's own directory on this
// host, the way the AWS fake keeps guest pids under the test root.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-msb-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

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

interface Machine {
  readonly name: string
  /** The real directory guest-fixed absolute paths live under on this host. */
  readonly root: string
  readonly ephemeral: boolean
  running: boolean
}

interface ExecCall {
  readonly name: string
  readonly shell: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin: Uint8Array | undefined
}

interface Recorded {
  readonly builds: Array<{ readonly name: string; readonly settings: Record<string, unknown> }>
  readonly execs: Array<ExecCall>
  readonly mkdirs: Array<string>
  readonly stops: Array<string>
  readonly connects: Array<string>
  readonly starts: Array<{ readonly name: string; readonly detached: boolean }>
  collects: number
}

interface Controls {
  readonly createFailure?: (() => unknown) | undefined
  readonly stopFailure?: boolean | undefined
}

/** Every guest filesystem failure arrives as the SDK's one fs error kind. */
const fsFailure = (cause: unknown): Error => {
  const code = Reflect.get(Object(cause), "code")
  return Object.assign(
    new Error(
      code === "ENOENT"
        ? "sandbox fs error: open: No such file or directory (os error 2)"
        : `sandbox fs error: ${cause instanceof Error ? cause.message : String(cause)}`
    ),
    { code: "sandboxFsOps" }
  )
}

const fakeSdk = (controls: Controls = {}) => {
  const machines = new Map<string, Machine>()
  const recorded: Recorded = {
    builds: [],
    execs: [],
    mkdirs: [],
    stops: [],
    connects: [],
    starts: [],
    collects: 0
  }

  const machineAt = (name: string): Machine => {
    const machine = machines.get(name)
    if (machine === undefined) throw new Error(`no such fake microVM: ${name}`)
    return machine
  }

  // A guest path the test placed under its own root is that real path; any
  // other absolute guest path is a guest-fixed location backed by a real file
  // under the machine's directory.
  const hostPath = (machine: Machine, path: string): string =>
    path === root || path.startsWith(`${root}/`) ? path : join(machine.root, path)

  const realFs = <A>(body: () => A): A => {
    try {
      return body()
    } catch (cause) {
      throw fsFailure(cause)
    }
  }

  const sandboxFor = (machine: Machine): VendorSandbox => ({
    name: machine.name,
    fs: () => ({
      write: async (path, data) => {
        const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)
        realFs(() => writeFileSync(hostPath(machine, path), bytes))
      },
      read: async (path) => realFs(() => new Uint8Array(readFileSync(hostPath(machine, path)))),
      readToString: async (path) => realFs(() => readFileSync(hostPath(machine, path), "utf8")),
      mkdir: async (path) => {
        recorded.mkdirs.push(path)
        realFs(() => mkdirSync(hostPath(machine, path), { recursive: true }))
      }
    }),
    execStreamWith: async (shell, configure) => {
      if (!machine.running) {
        throw Object.assign(new Error(`[SandboxNotRunning] microVM ${machine.name} is stopped`), {
          code: "sandboxNotRunning"
        })
      }
      let args: Array<string> = []
      let cwd = ""
      let env: Record<string, string> = {}
      let stdin: Uint8Array | undefined
      const builder: ExecBuilder = {
        args(value) {
          args = [...value]
          return this
        },
        cwd(value) {
          cwd = value
          return this
        },
        envs(value) {
          env = { ...value }
          return this
        },
        stdinBytes(value) {
          stdin = new Uint8Array(value)
          return this
        }
      }
      configure(builder)
      const call: ExecCall = { name: machine.name, shell, args, cwd, env, stdin }
      recorded.execs.push(call)
      let collected = false
      return {
        collect: async () => {
          if (collected) throw new Error("Microsandbox command handles can only be collected once")
          collected = true
          recorded.collects++
          return await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function*() {
                const child = yield* local.spawn(
                  ChildProcess.make(call.shell, [...call.args], {
                    cwd: hostPath(machine, call.cwd),
                    env: call.env,
                    extendEnv: true,
                    // The vendor default connects stdin to /dev/null; given
                    // bytes are sent and the channel closed.
                    stdin: Stream.make(call.stdin ?? new Uint8Array())
                  })
                )
                const [stdout, stderr, code] = yield* Effect.all(
                  [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
                  { concurrency: "unbounded" }
                )
                const stdoutBytes = concat(stdout)
                const stderrBytes = concat(stderr)
                const output: ExecOutput = {
                  code,
                  stdout: () => decoder.decode(stdoutBytes),
                  stderr: () => decoder.decode(stderrBytes),
                  stdoutBytes: () => stdoutBytes,
                  stderrBytes: () => stderrBytes
                }
                return output
              })
            )
          )
        }
      }
    },
    stop: async () => {
      recorded.stops.push(machine.name)
      if (controls.stopFailure === true) throw new Error(`could not stop ${machine.name}`)
      machine.running = false
      // An ephemeral microVM's filesystem dies with it.
      if (machine.ephemeral) {
        machines.delete(machine.name)
        rmSync(machine.root, { recursive: true, force: true })
      }
    }
  })

  const sdk: Sdk = {
    Sandbox: {
      builder: (name) => {
        const settings: Record<string, unknown> = {}
        const builder: Builder = {
          image(value) {
            settings["image"] = value
            return this
          },
          fromSnapshot(value) {
            settings["snapshot"] = value
            return this
          },
          cpus(value) {
            settings["cpus"] = value
            return this
          },
          maxCpus(value) {
            settings["maxCpus"] = value
            return this
          },
          memory(value) {
            settings["memory"] = value
            return this
          },
          maxMemory(value) {
            settings["maxMemory"] = value
            return this
          },
          security(value) {
            settings["security"] = value
            return this
          },
          pullPolicy(value) {
            settings["pullPolicy"] = value
            return this
          },
          labels(value) {
            settings["labels"] = { ...value }
            return this
          },
          scripts(value) {
            settings["scripts"] = { ...value }
            return this
          },
          maxDuration(value) {
            settings["maxDuration"] = value
            return this
          },
          idleTimeout(value) {
            settings["idleTimeout"] = value
            return this
          },
          ephemeral(value) {
            settings["ephemeral"] = value
            return this
          },
          detached(value) {
            settings["detached"] = value
            return this
          },
          disableNetwork() {
            settings["disableNetwork"] = true
            return this
          },
          create: async () => {
            recorded.builds.push({ name, settings: { ...settings } })
            if (controls.createFailure !== undefined) throw controls.createFailure()
            if (machines.has(name)) {
              throw Object.assign(new Error(`sandbox ${name} already exists`), {
                code: "sandboxAlreadyExists"
              })
            }
            const machine: Machine = {
              name,
              root: join(root, "machines", name),
              ephemeral: settings["ephemeral"] === true,
              running: true
            }
            // The image ships a hostname; the fake machine really holds one.
            mkdirSync(join(machine.root, "etc"), { recursive: true })
            writeFileSync(join(machine.root, "etc", "hostname"), name)
            machines.set(name, machine)
            return sandboxFor(machine)
          }
        }
        return builder
      },
      get: async (name) => {
        const machine = machineAt(name)
        const handle: VendorHandle = {
          status: machine.running ? "running" : "stopped",
          connect: async () => {
            if (!machine.running) throw new Error(`microVM ${name} is stopped`)
            recorded.connects.push(name)
            return sandboxFor(machine)
          },
          start: async () => {
            machine.running = true
            recorded.starts.push({ name, detached: false })
            return sandboxFor(machine)
          },
          startDetached: async () => {
            machine.running = true
            recorded.starts.push({ name, detached: true })
            return sandboxFor(machine)
          }
        }
        return handle
      }
    }
  }

  return {
    sdk,
    recorded,
    markStopped: (name: string): void => {
      machineAt(name).running = false
    },
    breakHostname: (name: string): void => {
      rmSync(join(machineAt(name).root, "etc", "hostname"), { force: true })
    },
    machineRoot: (name: string): string => machineAt(name).root
  }
}

const inSession = <A, E>(
  provider: Provider,
  key: string,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire(key), body))

const output = (process: RemoteProcess) =>
  Effect.all(
    [
      Stream.mkString(Stream.decodeText(process.stdout)),
      Stream.mkString(Stream.decodeText(process.stderr)),
      process.exitCode
    ],
    { concurrency: "unbounded" }
  )

describe("MicrosandboxSandbox", () => {
  it.effect("passes SandboxConformance running real shells against real files", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "conformance-ws")
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })

      const violations = yield* SandboxConformance.check(provider, {
        provides: { ping: true }
      })

      expect(violations).toEqual([])
      expect(fake.recorded.collects).toBe(fake.recorded.execs.length)
      expect(fake.recorded.builds.every(({ settings }) =>
        settings["image"] === "oven/bun:1" &&
        settings["ephemeral"] === true &&
        settings["detached"] === false
      )).toBe(true)
      // Commands run a plain shell, never a login shell, and never smuggle
      // file contents through the command line.
      expect(fake.recorded.execs.every(({ args, shell }) => shell === "/bin/sh" && args[0] === "-c")).toBe(true)
      expect(fake.recorded.execs.every(({ args }) => args[1]?.includes("base64") !== true)).toBe(true)
      // Standard input rode the exec builder's byte channel.
      expect(fake.recorded.execs.some(({ stdin }) => stdin !== undefined && stdin.includes(255))).toBe(true)
    }), 30_000)

  it.effect("carries every builder option and command setting without a builder workdir", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const workdir = join(root, "options-ws")
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        image: "alpine:3.22",
        workdir,
        shell: "/bin/bash",
        env: { STATIC: "base", KEPT: "base" },
        cpus: 2,
        maxCpus: 4,
        memoryMib: 1024,
        maxMemoryMib: 2048,
        maxDurationSecs: 900,
        idleTimeoutSecs: 120,
        security: "restricted",
        pullPolicy: "if-missing",
        labels: { owner: "smithers" },
        scripts: { prepare: "echo ready" },
        detached: true,
        disableNetwork: true
      })

      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const first = yield* provider.acquire("lane/one")
          const second = yield* provider.acquire("lane-one")
          // A path with no parent segment takes the bare write, backed by the
          // machine's own directory since it is not a test-root path.
          yield* first.writeFile("/root.bin", new Uint8Array([1, 2]))
          const spaced = new Uint8Array([0, 255, 7])
          yield* first.writeFile(`${workdir}/a b.bin`, spaced)
          expect(Array.from(yield* first.readFile(`${workdir}/a b.bin`))).toEqual(Array.from(spaced))
          const absolute = yield* first.spawn("pwd", {
            cwd: root,
            env: { STATIC: undefined, DYNAMIC: "yes" }
          })
          const printed = yield* output(absolute)
          yield* Effect.scoped(Effect.asVoid(first.spawn("mkdir -p sub", {})))
          const relative = yield* Effect.scoped(Effect.flatMap(first.spawn("pwd", { cwd: "./sub/" }), output))
          const emptied = yield* Effect.scoped(
            Effect.flatMap(first.spawn(`cat > ${workdir}/empty-stdin.bin`, { stdin: new Uint8Array() }), output)
          )
          const emptyCopy = yield* first.readFile(`${workdir}/empty-stdin.bin`)
          return {
            names: [first.remoteId, second.remoteId],
            printed,
            relative,
            emptied,
            emptyCopy
          }
        })
      )

      expect(result.names[0]).not.toBe(result.names[1])
      expect(result.names[0]).toMatch(/^smthrs-msb-lane-one-/)
      expect(result.printed).toEqual([`${root}\n`, "", 0])
      expect(result.relative).toEqual([`${workdir}/sub\n`, "", 0])
      expect(result.emptied[2]).toBe(0)
      expect(Array.from(result.emptyCopy)).toEqual([])
      const spawned = fake.recorded.execs.find(({ env }) => env["DYNAMIC"] === "yes")
      expect(spawned).toMatchObject({
        shell: "/bin/bash",
        cwd: root,
        env: { KEPT: "base", DYNAMIC: "yes" }
      })
      expect(spawned?.env["STATIC"]).toBeUndefined()
      expect(fake.recorded.builds[0]?.settings).toEqual({
        image: "alpine:3.22",
        cpus: 2,
        maxCpus: 4,
        memory: 1024,
        maxMemory: 2048,
        security: "restricted",
        pullPolicy: "if-missing",
        labels: { owner: "smithers" },
        scripts: { prepare: "echo ready" },
        maxDuration: 900,
        idleTimeout: 120,
        disableNetwork: true,
        ephemeral: true,
        detached: true
      })
      expect(fake.recorded.builds[0]?.settings["workdir"]).toBeUndefined()
      expect(fake.recorded.stops).toHaveLength(2)
    }))

  it.effect("keeps sticky machines and reconnects to running or stopped instances", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      // No workdir named: the default guest workspace lives under the
      // machine's directory and survives exactly as long as the machine.
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        snapshot: "snapshot-7",
        persistence: "sticky",
        detached: false
      })
      const bytes = new Uint8Array([0, 254, 8])

      const name = yield* inSession(provider, "sticky", (session) =>
        Effect.gen(function*() {
          expect(session.workdir).toBe("/workspace")
          yield* session.writeFile("/workspace/kept.bin", bytes)
          return session.remoteId
        }))
      expect(fake.recorded.stops).toEqual([])
      expect(fake.recorded.builds[0]?.settings).toEqual({
        snapshot: "snapshot-7",
        ephemeral: false,
        detached: false
      })

      fake.markStopped(name)
      const reopened = yield* inSession(
        provider,
        "sticky",
        (session) => session.readFile(`${session.workdir}/kept.bin`)
      )
      expect(Array.from(reopened)).toEqual(Array.from(bytes))
      expect(fake.recorded.starts).toEqual([{ name, detached: false }])

      yield* inSession(provider, "sticky", (session) => session.ping!)
      expect(fake.recorded.connects).toEqual([name])
      expect(fake.recorded.stops).toEqual([])

      const detachedFake = fakeSdk()
      const detached = MicrosandboxSandbox.make({
        sdk: detachedFake.sdk,
        persistence: "sticky"
      })
      const detachedName = yield* inSession(detached, "detached", (session) => Effect.succeed(session.remoteId))
      detachedFake.markStopped(detachedName)
      yield* inSession(detached, "detached", (session) => session.ping!)
      expect(detachedFake.recorded.starts).toEqual([{ name: detachedName, detached: true }])
    }))

  it.effect("rejects invalid configuration and cleans up partial provisioning", () =>
    Effect.gen(function*() {
      const invalidFake = fakeSdk()
      const invalid = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({
            sdk: invalidFake.sdk,
            image: "alpine",
            snapshot: "snapshot-7"
          }),
          "invalid",
          Effect.succeed
        )
      )
      expect((invalid as ProviderError).code).toBe("unavailable")
      expect((invalid as ProviderError).message).toContain("exclusive")
      expect(invalidFake.recorded.builds).toEqual([])

      const unavailableFake = fakeSdk({ createFailure: () => "no hypervisor" })
      const unavailable = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({ sdk: unavailableFake.sdk }),
          "unavailable",
          Effect.succeed
        )
      )
      expect((unavailable as ProviderError).code).toBe("unavailable")
      expect((unavailable as ProviderError).message).toContain("no hypervisor")

      // A real file where the workspace's parent should be refuses the mkdir.
      writeFileSync(join(root, "not-a-directory"), "occupied")
      const partialFake = fakeSdk()
      const partial = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({
            sdk: partialFake.sdk,
            workdir: join(root, "not-a-directory", "ws"),
            persistence: "sticky"
          }),
          "partial",
          Effect.succeed
        )
      )
      expect((partial as ProviderError).message).toContain("could not be prepared")
      expect(partialFake.recorded.stops).toHaveLength(1)

      const stopFailureFake = fakeSdk({ stopFailure: true })
      yield* inSession(
        MicrosandboxSandbox.make({ sdk: stopFailureFake.sdk, workdir: join(root, "stop-failure-ws") }),
        "stop-failure",
        (session) => Effect.succeed(session.id)
      )
      expect(stopFailureFake.recorded.stops).toHaveLength(1)
    }))

  it.effect("maps guest filesystem, command, and ping failures", () =>
    Effect.gen(function*() {
      const workdir = join(root, "failures-ws")
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk, workdir })

      const failures = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("failures")
          const locked = `${workdir}/locked.bin`
          yield* session.writeFile(locked, new Uint8Array([1]))
          chmodSync(locked, 0)
          const read = yield* Effect.flip(session.readFile(locked))
          // A real file where a parent directory should be refuses the parent
          // creation, and a real directory where the file should be refuses
          // the write itself.
          yield* session.writeFile(`${workdir}/occupied`, new Uint8Array([2]))
          const mkdir = yield* Effect.flip(session.writeFile(`${workdir}/occupied/out.bin`, new Uint8Array([3])))
          mkdirSync(join(workdir, "a-directory"), { recursive: true })
          const write = yield* Effect.flip(session.writeFile(`${workdir}/a-directory`, new Uint8Array([4])))
          fake.breakHostname(session.remoteId)
          const ping = yield* Effect.flip(session.ping!)
          const unknown = yield* session.spawn("definitely-not-a-command-9f2", {})
          const unknownOutput = yield* output(unknown)
          fake.markStopped(session.remoteId)
          const spawn = yield* Effect.flip(Effect.asVoid(session.spawn("printf late", {})))
          return { read, mkdir, write, ping, spawn, unknownOutput }
        })
      )

      expect((failures.read as ProviderError).code).toBe("unknown")
      expect((failures.mkdir as ProviderError).code).toBe("unknown")
      expect((failures.write as ProviderError).code).toBe("unknown")
      expect((failures.ping as ProviderError).code).toBe("unavailable")
      expect((failures.spawn as ProviderError).code).toBe("spawn_error")
      expect(failures.unknownOutput[2]).toBe(127)
      expect(failures.unknownOutput[1]).toContain("not found")
    }))
})
