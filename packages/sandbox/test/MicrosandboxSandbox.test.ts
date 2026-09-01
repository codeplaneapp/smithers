import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
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

interface Machine {
  readonly name: string
  readonly files: Map<string, Uint8Array>
  readonly directories: Set<string>
  readonly ephemeral: boolean
  running: boolean
}

interface Controls {
  readonly createFailure?: (() => unknown) | undefined
  readonly mkdirFailures?: ReadonlySet<string> | undefined
  readonly writeFailures?: ReadonlySet<string> | undefined
  readonly deniedReads?: ReadonlySet<string> | undefined
  readonly malformedBase64?: ReadonlySet<string> | undefined
  readonly execFailureCommand?: string | undefined
  readonly pingFailure?: boolean | undefined
  readonly stopFailure?: boolean | undefined
}

interface ExecCall {
  readonly name: string
  readonly shell: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

interface Recorded {
  readonly builds: Array<{ readonly name: string; readonly settings: Record<string, unknown> }>
  readonly execs: Array<ExecCall>
  readonly writes: Array<{ readonly path: string; readonly bytes: Uint8Array }>
  readonly textReads: Array<string>
  readonly mkdirs: Array<string>
  readonly stops: Array<string>
  readonly connects: Array<string>
  readonly starts: Array<{ readonly name: string; readonly detached: boolean }>
  collects: number
}

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator > 0 ? path.slice(0, separator) : undefined
}

const mkdirAll = (directories: Set<string>, path: string): void => {
  if (!path.startsWith("/")) throw new Error(`guest paths must be absolute: ${path}`)
  directories.add("/")
  let current = ""
  for (const part of path.split("/").filter((segment) => segment !== "")) {
    current += `/${part}`
    directories.add(current)
  }
}

const shellWord = (word: string): string =>
  word.startsWith("'") && word.endsWith("'")
    ? word.slice(1, -1).replaceAll("'\\''", "'")
    : word

const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const commandOutput = (
  machine: Machine,
  call: ExecCall,
  controls: Controls
): { readonly code: number; stdout(): string; stderr(): string } => {
  const command = call.args[1] ?? ""
  let code = 0
  let stdout = ""
  let stderr = ""

  if (!machine.directories.has(call.cwd)) {
    code = 1
    stderr = `sh: ${call.cwd}: no such directory`
  } else if (command === "pwd") {
    stdout = `${call.cwd}\n`
  } else {
    const environmentPrint = /^printf '%s' "\$([A-Za-z_][A-Za-z0-9_]*)"$/.exec(command)
    const literalPrint = /^printf '([^']*)'$/.exec(command)
    const exit = /^exit ([0-9]+)$/.exec(command)
    const readMarker = " || exit 9; base64 "
    if (environmentPrint !== null) {
      stdout = call.env[environmentPrint[1]!] ?? ""
    } else if (literalPrint !== null) {
      stdout = literalPrint[1]!
    } else if (exit !== null) {
      code = Number(exit[1])
    } else if (command.startsWith("test -e ") && command.includes(readMarker)) {
      const marker = command.indexOf(readMarker)
      const tested = shellWord(command.slice("test -e ".length, marker))
      const read = shellWord(command.slice(marker + readMarker.length))
      if (tested !== read) {
        code = 2
        stderr = "test and base64 paths differ"
      } else if (controls.deniedReads?.has(read) === true) {
        code = 1
        stderr = `base64: ${read}: permission denied`
      } else {
        const bytes = machine.files.get(read)
        if (bytes === undefined) {
          code = 9
        } else {
          stdout = controls.malformedBase64?.has(read) === true ? "%%%\n" : `${base64(bytes)}\n`
        }
      }
    } else {
      code = 127
      stderr = `sh: ${command}: not found`
    }
  }

  return {
    code,
    stdout: () => stdout,
    stderr: () => stderr
  }
}

const fakeSdk = (controls: Controls = {}) => {
  const machines = new Map<string, Machine>()
  const recorded: Recorded = {
    builds: [],
    execs: [],
    writes: [],
    textReads: [],
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

  const sandboxFor = (machine: Machine): VendorSandbox => ({
    name: machine.name,
    fs: () => ({
      write: async (path, data) => {
        if (controls.writeFailures?.has(path) === true) {
          throw new Error(`sandbox filesystem refused ${path}`)
        }
        const parent = parentOf(path)
        if (parent !== undefined && !machine.directories.has(parent)) {
          throw new Error(`sandbox filesystem has no directory ${parent}`)
        }
        const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data)
        machine.files.set(path, bytes)
        recorded.writes.push({ path, bytes: new Uint8Array(bytes) })
      },
      readToString: async (path) => {
        recorded.textReads.push(path)
        if (controls.pingFailure === true && path === "/etc/hostname") {
          throw new Error("sandbox agent is unavailable")
        }
        const bytes = machine.files.get(path)
        if (bytes === undefined) throw new Error(`sandbox filesystem has no such file ${path}`)
        return decoder.decode(bytes)
      },
      mkdir: async (path) => {
        recorded.mkdirs.push(path)
        if (controls.mkdirFailures?.has(path) === true) {
          throw new Error(`sandbox filesystem refused mkdir ${path}`)
        }
        mkdirAll(machine.directories, path)
      }
    }),
    execStreamWith: async (shell, configure) => {
      if (!machine.running) throw new Error(`microVM ${machine.name} is stopped`)
      let args: Array<string> = []
      let cwd = ""
      let env: Record<string, string> = {}
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
        }
      }
      configure(builder)
      const call: ExecCall = { name: machine.name, shell, args, cwd, env }
      recorded.execs.push(call)
      const command = args[1] ?? ""
      if (controls.execFailureCommand === command) {
        throw new Error(`transport failed for ${command}`)
      }
      let collected = false
      return {
        collect: async () => {
          if (collected) throw new Error("Microsandbox command handles can only be collected once")
          collected = true
          recorded.collects++
          return commandOutput(machine, call, controls)
        }
      }
    },
    stop: async () => {
      recorded.stops.push(machine.name)
      if (controls.stopFailure === true) throw new Error(`could not stop ${machine.name}`)
      machine.running = false
      if (machine.ephemeral) machines.delete(machine.name)
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
              files: new Map([["/etc/hostname", encoder.encode(name)]]),
              directories: new Set(["/", "/etc"]),
              ephemeral: settings["ephemeral"] === true,
              running: true
            }
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
    vendorText: (name: string, path: string): string => {
      const bytes = machineAt(name).files.get(path)
      if (bytes === undefined) throw new Error(`no such fake guest file: ${path}`)
      return decoder.decode(bytes)
    }
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
  it.effect("passes SandboxConformance against a byte-honest vendor fake", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk })

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
      const binaryWrite = fake.recorded.writes.find(({ bytes }) => bytes.includes(255))
      expect(binaryWrite).toBeDefined()
      expect(Array.from(encoder.encode(decoder.decode(binaryWrite!.bytes))))
        .not.toEqual(Array.from(binaryWrite!.bytes))
      expect(fake.recorded.textReads.some((path) => path.endsWith("conformance-bytes.bin"))).toBe(false)
      expect(fake.recorded.execs.some(({ args }) => args[1]?.includes("base64") === true)).toBe(true)
    }))

  it.effect("carries every builder option and command setting without a builder workdir", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        image: "alpine:3.22",
        workdir: "/work",
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
          yield* first.writeFile("/root.bin", new Uint8Array([1, 2]))
          const spaced = new Uint8Array([0, 255, 7])
          yield* first.writeFile("/work/a b.bin", spaced)
          expect(fake.vendorText(first.remoteId, "/work/a b.bin")).toContain("\uFFFD")
          expect(Array.from(yield* first.readFile("/work/a b.bin"))).toEqual(Array.from(spaced))
          const process = yield* first.spawn("pwd", {
            cwd: "/",
            env: { STATIC: undefined, DYNAMIC: "yes" }
          })
          return {
            names: [first.remoteId, second.remoteId],
            process: yield* output(process)
          }
        })
      )

      expect(result.names[0]).not.toBe(result.names[1])
      expect(result.names[0]).toMatch(/^smthrs-msb-lane-one-/)
      expect(result.process).toEqual(["/\n", "", 0])
      expect(fake.recorded.execs.at(-1)).toMatchObject({
        shell: "/bin/bash",
        cwd: "/",
        env: { KEPT: "base", DYNAMIC: "yes" }
      })
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
      const provider = MicrosandboxSandbox.make({
        sdk: fake.sdk,
        snapshot: "snapshot-7",
        persistence: "sticky",
        detached: false
      })
      const bytes = new Uint8Array([0, 254, 8])

      const name = yield* inSession(provider, "sticky", (session) =>
        Effect.as(session.writeFile(`${session.workdir}/kept.bin`, bytes), session.remoteId))
      expect(fake.recorded.stops).toEqual([])
      expect(fake.recorded.builds[0]?.settings).toEqual({
        snapshot: "snapshot-7",
        ephemeral: false,
        detached: false
      })

      fake.markStopped(name)
      const reopened = yield* inSession(provider, "sticky", (session) =>
        session.readFile(`${session.workdir}/kept.bin`))
      expect(Array.from(reopened)).toEqual(Array.from(bytes))
      expect(fake.recorded.starts).toEqual([{ name, detached: false }])

      yield* inSession(provider, "sticky", (session) =>
        session.ping!)
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

      const partialFake = fakeSdk({ mkdirFailures: new Set(["/broken"]) })
      const partial = yield* Effect.flip(
        inSession(
          MicrosandboxSandbox.make({
            sdk: partialFake.sdk,
            workdir: "/broken",
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
        MicrosandboxSandbox.make({ sdk: stopFailureFake.sdk }),
        "stop-failure",
        (session) => Effect.succeed(session.id)
      )
      expect(stopFailureFake.recorded.stops).toHaveLength(1)
    }))

  it.effect("maps guest filesystem, command, and ping failures", () =>
    Effect.gen(function*() {
      const locked = "/workspace/locked.bin"
      const malformed = "/workspace/malformed.bin"
      const refused = "/workspace/refused.bin"
      const fake = fakeSdk({
        mkdirFailures: new Set(["/workspace/blocked"]),
        writeFailures: new Set([refused]),
        deniedReads: new Set([locked]),
        malformedBase64: new Set([malformed]),
        execFailureCommand: "transport-down",
        pingFailure: true
      })
      const provider = MicrosandboxSandbox.make({ sdk: fake.sdk })

      const failures = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("failures")
          yield* session.writeFile(locked, new Uint8Array([1]))
          yield* session.writeFile(malformed, new Uint8Array([2]))
          const read = yield* Effect.flip(session.readFile(locked))
          const invalidBase64 = yield* Effect.flip(session.readFile(malformed))
          const write = yield* Effect.flip(session.writeFile(refused, new Uint8Array([3])))
          const mkdir = yield* Effect.flip(session.writeFile("/workspace/blocked/out.bin", new Uint8Array([4])))
          const ping = yield* Effect.flip(session.ping!)
          const unknown = yield* session.spawn("does-not-exist", {})
          const unknownOutput = yield* output(unknown)
          const spawn = yield* Effect.flip(Effect.asVoid(session.spawn("transport-down", {})))
          return { read, invalidBase64, write, mkdir, ping, spawn, unknownOutput }
        })
      )

      expect((failures.read as ProviderError).code).toBe("unknown")
      expect((failures.read as ProviderError).message).toContain("permission denied")
      expect((failures.invalidBase64 as ProviderError).code).toBe("unknown")
      expect((failures.write as ProviderError).code).toBe("unknown")
      expect((failures.mkdir as ProviderError).code).toBe("unknown")
      expect((failures.ping as ProviderError).code).toBe("unavailable")
      expect((failures.spawn as ProviderError).code).toBe("spawn_error")
      expect(failures.unknownOutput).toEqual(["", "sh: does-not-exist: not found", 127])
    }))
})
