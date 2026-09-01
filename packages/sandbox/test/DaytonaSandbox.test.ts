import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as DaytonaSandbox from "../src/DaytonaSandbox/index.ts"
import type { Sdk } from "../src/DaytonaSandbox/Sdk.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type VendorSandbox = Awaited<ReturnType<Sdk["get"]>>
type CreateInput = NonNullable<Parameters<Sdk["create"]>[0]>

interface Machine {
  readonly id: string
  readonly name: string
  readonly files: Map<string, Uint8Array>
  readonly directories: Set<string>
  workdir: string | undefined
  running: boolean
}

interface ExecuteCall {
  readonly command: string
  readonly cwd: string | undefined
  readonly env: Record<string, string> | undefined
}

interface Plan {
  getFailure?: unknown
  createFailure?: unknown
  startFailure?: unknown
  deleteFailure?: unknown
  workdirFailure?: unknown
  downloadFailure?: unknown
  uploadFailure?: unknown
  execute?: ((call: ExecuteCall) => number | unknown | undefined) | undefined
}

interface Recorded {
  readonly gets: Array<string>
  readonly creates: Array<CreateInput | undefined>
  readonly starts: Array<{ readonly id: string; readonly timeout: number | undefined }>
  readonly deletes: Array<
    { readonly id: string; readonly timeout: number | undefined; readonly wait: boolean | undefined }
  >
  readonly executes: Array<ExecuteCall>
  readonly downloads: Array<string>
  readonly uploads: Array<{ readonly path: string; readonly content: Uint8Array }>
}

const vendorError = (message: string, fields: Record<string, unknown>): Error =>
  Object.assign(new Error(message), fields)

const addDirectory = (machine: Machine, path: string): void => {
  const parts = path.split("/").filter((part) => part !== "")
  let current = ""
  machine.directories.add("/")
  for (const part of parts) {
    current += `/${part}`
    machine.directories.add(current)
  }
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/"

const unquote = (token: string): string =>
  token.startsWith("'") && token.endsWith("'")
    ? token.slice(1, -1).replaceAll("'\\''", "'")
    : token

const shell = (call: ExecuteCall): { readonly exitCode: number; readonly result: string } => {
  if (call.command === "pwd") return { exitCode: 0, result: `${call.cwd}\n` }
  if (call.command === `printf '%s' "$SANDBOX_CONFORMANCE"`) {
    return { exitCode: 0, result: call.env?.["SANDBOX_CONFORMANCE"] ?? "" }
  }
  if (call.command === `printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`) {
    return { exitCode: 0, result: `${call.env?.["STATIC_PROOF"] ?? ""}:${call.env?.["SPAWN_PROOF"] ?? ""}` }
  }
  const printed = /^printf '([^']*)'$/.exec(call.command)
  if (printed !== null) return { exitCode: 0, result: printed[1] ?? "" }
  const exited = /^exit ([0-9]+)$/.exec(call.command)
  if (exited !== null) return { exitCode: Number(exited[1]), result: "" }
  return { exitCode: 0, result: "done" }
}

const fakeSdk = (plan: Plan = {}): {
  readonly sdk: Sdk
  readonly recorded: Recorded
  readonly machines: Map<string, Machine>
  readonly seed: (name: string, workdir?: string | undefined) => Machine
} => {
  const recorded: Recorded = {
    gets: [],
    creates: [],
    starts: [],
    deletes: [],
    executes: [],
    downloads: [],
    uploads: []
  }
  const machines = new Map<string, Machine>()
  let nextId = 1
  const seed = (name: string, workdir: string | undefined = "/home/daytona"): Machine => {
    const machine: Machine = {
      id: `sandbox-${nextId++}`,
      name,
      files: new Map(),
      directories: new Set(["/"]),
      workdir,
      running: false
    }
    if (workdir !== undefined && workdir.startsWith("/")) addDirectory(machine, workdir)
    machines.set(name, machine)
    machines.set(machine.id, machine)
    return machine
  }
  const instance = (machine: Machine): VendorSandbox => ({
    id: machine.id,
    name: machine.name,
    getWorkDir: () =>
      plan.workdirFailure === undefined ? Promise.resolve(machine.workdir) : Promise.reject(plan.workdirFailure),
    process: {
      executeCommand: async (command, cwd, env) => {
        if (!machine.running) throw new Error("sandbox is stopped")
        const call = { command, cwd, env }
        recorded.executes.push(call)
        const planned = plan.execute?.(call)
        if (planned !== undefined && typeof planned !== "number") throw planned
        if (typeof planned === "number") return { exitCode: planned, result: "" }
        const directory = /^mkdir -p (.+)$/.exec(command)
        if (directory !== null) {
          addDirectory(machine, unquote(directory[1] ?? ""))
          return { exitCode: 0, result: "" }
        }
        return shell(call)
      }
    },
    fs: {
      downloadFile: async (path) => {
        recorded.downloads.push(path)
        if (plan.downloadFailure !== undefined) throw plan.downloadFailure
        const content = machine.files.get(path)
        if (content === undefined) throw vendorError(`file not found: ${path}`, { code: "FILE_NOT_FOUND" })
        return new Uint8Array(content)
      },
      uploadFileStream: async (content, path) => {
        recorded.uploads.push({ path, content: new Uint8Array(content) })
        if (plan.uploadFailure !== undefined) throw plan.uploadFailure
        if (!machine.directories.has(parentOf(path))) throw new Error("parent directory does not exist")
        machine.files.set(path, new Uint8Array(content))
      }
    }
  })
  const sdk: Sdk = {
    get: async (idOrName) => {
      recorded.gets.push(idOrName)
      if (plan.getFailure !== undefined) throw plan.getFailure
      const machine = machines.get(idOrName)
      if (machine === undefined) throw vendorError(`sandbox not found: ${idOrName}`, { statusCode: 404 })
      return instance(machine)
    },
    create: async (input) => {
      recorded.creates.push(input)
      if (plan.createFailure !== undefined) throw plan.createFailure
      const machine = seed(input?.name ?? `generated-${nextId}`)
      machine.running = true
      return instance(machine)
    },
    start: async (sandbox, timeout) => {
      recorded.starts.push({ id: sandbox.id, timeout })
      if (plan.startFailure !== undefined) throw plan.startFailure
      const machine = machines.get(sandbox.id)
      if (machine === undefined) throw vendorError("sandbox not found", { statusCode: 404 })
      machine.running = true
    },
    delete: async (sandbox, timeout, wait) => {
      recorded.deletes.push({ id: sandbox.id, timeout, wait })
      if (plan.deleteFailure !== undefined) throw plan.deleteFailure
      const machine = machines.get(sandbox.id)
      if (machine === undefined) throw vendorError("sandbox not found", { statusCode: 404 })
      machine.running = false
      machines.delete(machine.id)
      machines.delete(machine.name)
    }
  }
  return { sdk, recorded, machines, seed }
}

const acquired = <A, E>(
  provider: ReturnType<typeof DaytonaSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("run-1"), body))

describe("DaytonaSandbox", () => {
  it.effect("passes SandboxConformance against the Daytona SDK fake", () =>
    Effect.gen(function*() {
      const { sdk } = fakeSdk()
      const violations = yield* SandboxConformance.check(DaytonaSandbox.make({ sdk }), {
        provides: { ping: true }
      })
      expect(violations).toEqual([])
    }), 30_000)

  it.effect("attaches, starts, discovers the workdir, and deletes synchronously", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const name = `lane-${sessionSlug("run-1")}`
      const machine = fake.seed(name, "/workspace with quote's")
      const provider = DaytonaSandbox.make({
        sdk: fake.sdk,
        namePrefix: "lane-",
        startTimeoutSeconds: 17,
        deleteTimeoutSeconds: 29,
        commandEnv: { STATIC_PROOF: "static" }
      })
      const answer = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect(session.id).toBe("run-1")
          expect(session.remoteId).toBe(machine.id)
          return yield* Effect.scoped(
            Effect.flatMap(
              session.spawn(`printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`, {
                cwd: "/tmp",
                env: { SPAWN_PROOF: "spawn", OMITTED: undefined }
              }),
              (process) => Stream.mkString(Stream.decodeText(process.stdout))
            )
          )
        }))

      expect(answer).toBe("static:spawn")
      expect(fake.recorded.gets).toEqual([name])
      expect(fake.recorded.creates).toEqual([])
      expect(fake.recorded.starts).toEqual([{ id: machine.id, timeout: 17 }])
      expect(fake.recorded.deletes).toEqual([{ id: machine.id, timeout: 29, wait: true }])
      expect(fake.recorded.executes[0]?.command).toBe("mkdir -p '/workspace with quote'\\''s'")
      expect(fake.recorded.executes[1]).toMatchObject({
        cwd: "/tmp",
        env: { STATIC_PROOF: "static", SPAWN_PROOF: "spawn" }
      })
      expect(fake.machines.size).toBe(0)
    }))

  it.effect("uses an explicit workspace and preserves file bytes", () =>
    Effect.gen(function*() {
      const fake = fakeSdk()
      const bytes = new Uint8Array([0, 255, 254, 1])
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk, workdir: "/explicit" }), (session) =>
        Effect.gen(function*() {
          expect(session.workdir).toBe("/explicit")
          yield* session.writeFile("/root-file", bytes)
          expect(yield* session.readFile("/root-file")).toEqual(bytes)
          const process = yield* Effect.scoped(session.spawn("printf 'ok'", {}))
          expect(yield* Stream.mkString(Stream.decodeText(process.stderr))).toBe("")
        }))
      expect(fake.recorded.deletes[0]).toMatchObject({ timeout: 60, wait: true })
    }))

  it.effect("rejects invalid and undiscoverable workdirs", () =>
    Effect.gen(function*() {
      const invalid = fakeSdk()
      const invalidFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: invalid.sdk, workdir: "relative" }), Effect.succeed)
      )
      expect((invalidFailure as ProviderError).code).toBe("spawn_error")
      expect(invalid.recorded.gets).toEqual([])

      for (const workdir of [undefined, "relative"] as const) {
        const fake = fakeSdk()
        const expected = `bad-${sessionSlug("run-1")}`
        fake.seed(expected).workdir = workdir
        const failure = yield* Effect.flip(
          acquired(DaytonaSandbox.make({ sdk: fake.sdk, namePrefix: "bad-" }), Effect.succeed)
        )
        expect((failure as ProviderError).code).toBe("unavailable")
        expect(fake.recorded.deletes).toHaveLength(1)
      }
    }))

  it.effect("maps acquisition and setup failures after registering teardown", () =>
    Effect.gen(function*() {
      const unavailable = fakeSdk({ getFailure: new Error("gateway offline") })
      const getFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: unavailable.sdk }), Effect.succeed)
      )
      expect((getFailure as ProviderError).code).toBe("unavailable")
      expect(unavailable.recorded.creates).toEqual([])

      const nullFailure = fakeSdk({ getFailure: null })
      const nullGetFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: nullFailure.sdk }), Effect.succeed)
      )
      expect((nullGetFailure as ProviderError).code).toBe("unavailable")

      const create = fakeSdk({ createFailure: new Error("quota reached") })
      const createFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: create.sdk }), Effect.succeed))
      expect((createFailure as ProviderError).code).toBe("unavailable")
      expect(create.recorded.deletes).toEqual([])

      const start = fakeSdk({ startFailure: new Error("cannot start") })
      start.seed(`smthrs-${sessionSlug("run-1")}`)
      const startFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: start.sdk }), Effect.succeed))
      expect((startFailure as ProviderError).code).toBe("unavailable")
      expect(start.recorded.deletes).toHaveLength(1)

      const discovery = fakeSdk({ workdirFailure: new Error("metadata unavailable") })
      const discoveryFailure = yield* Effect.flip(
        acquired(DaytonaSandbox.make({ sdk: discovery.sdk }), Effect.succeed)
      )
      expect((discoveryFailure as ProviderError).code).toBe("unavailable")
      expect(discovery.recorded.deletes).toHaveLength(1)

      const execute = fakeSdk({ execute: () => new Error("exec refused") })
      const executeFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: execute.sdk }), Effect.succeed))
      expect((executeFailure as ProviderError).code).toBe("spawn_error")
      expect(execute.recorded.deletes).toHaveLength(1)

      const prepare = fakeSdk({ execute: (call) => call.command.startsWith("mkdir -p ") ? 8 : undefined })
      const prepareFailure = yield* Effect.flip(acquired(DaytonaSandbox.make({ sdk: prepare.sdk }), Effect.succeed))
      expect((prepareFailure as ProviderError).code).toBe("unavailable")
      expect(prepare.recorded.deletes).toHaveLength(1)

      const ignoredDelete = fakeSdk({ deleteFailure: new Error("already gone") })
      yield* acquired(DaytonaSandbox.make({ sdk: ignoredDelete.sdk }), Effect.succeed)
      expect(ignoredDelete.recorded.deletes).toHaveLength(1)
    }))

  it.effect("maps file, spawn, and ping failures", () =>
    Effect.gen(function*() {
      const plan: Plan = {}
      const fake = fakeSdk(plan)
      yield* acquired(DaytonaSandbox.make({ sdk: fake.sdk }), (session) =>
        Effect.gen(function*() {
          plan.execute = (call) => call.command === "broken" ? new Error("exec failed") : undefined
          const spawnFailure = yield* Effect.flip(Effect.scoped(session.spawn("broken", {})))
          expect((spawnFailure as ProviderError).code).toBe("spawn_error")

          plan.execute = (call) => call.command.includes("/blocked") ? 3 : undefined
          const directoryFailure = yield* Effect.flip(session.writeFile("/blocked/file", new Uint8Array()))
          expect((directoryFailure as ProviderError).code).toBe("unknown")

          plan.execute = undefined
          plan.uploadFailure = new Error("upload failed")
          const uploadFailure = yield* Effect.flip(session.writeFile("/file", new Uint8Array()))
          expect((uploadFailure as ProviderError).code).toBe("unknown")

          plan.uploadFailure = undefined
          const absent = yield* Effect.flip(session.readFile("/absent"))
          expect((absent as ProviderError).code).toBe("not_found")

          plan.downloadFailure = vendorError("permission denied", { code: "PERMISSION_DENIED" })
          const downloadFailure = yield* Effect.flip(session.readFile("/private"))
          expect((downloadFailure as ProviderError).code).toBe("unknown")

          plan.downloadFailure = undefined
          plan.execute = (call) => call.command === "true" ? 9 : undefined
          const pingFailure = yield* Effect.flip(session.ping!)
          expect((pingFailure as ProviderError).code).toBe("unavailable")
        }))
    }))
})
