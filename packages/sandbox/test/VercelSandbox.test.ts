import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import * as VercelSandbox from "../src/VercelSandbox/index.ts"
import type { Sdk } from "../src/VercelSandbox/Sdk.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type CreateInput = Parameters<Sdk["Sandbox"]["getOrCreate"]>[0]
type VendorSandbox = Awaited<ReturnType<Sdk["Sandbox"]["getOrCreate"]>>
type RunInput = Parameters<VendorSandbox["runCommand"]>[0]
type CommandFinished = Awaited<ReturnType<VendorSandbox["runCommand"]>>
type ReadableFile = NonNullable<Awaited<ReturnType<VendorSandbox["readFile"]>>>

interface Machine {
  readonly name: string
  readonly directories: Set<string>
  readonly files: Map<string, Uint8Array>
  running: boolean
}

interface Plan {
  acquireFailure?: unknown
  extendFailure?: unknown
  stopFailure?: unknown
  readFailure?: unknown
  writeFailure?: unknown
  stdoutFailure?: unknown
  stderrFailure?: unknown
  textReads?: boolean
  run?: ((input: RunInput) => number | unknown | undefined) | undefined
}

interface Recorded {
  readonly acquired: Array<CreateInput>
  readonly commands: Array<RunInput>
  readonly extended: Array<number>
  readonly stopped: Array<string>
}

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

const readable = (content: Uint8Array, asText: boolean): ReadableFile => ({
  async *[Symbol.asyncIterator]() {
    if (asText) {
      yield decoder.decode(content)
      return
    }
    const split = Math.min(4, content.length)
    yield content.slice(0, split)
    yield content.slice(split)
  }
})

const shell = (line: string, input: RunInput): { stdout: string; stderr: string; exitCode: number } => {
  if (line === "pwd") return { stdout: `${input.cwd}\n`, stderr: "", exitCode: 0 }
  if (line === `printf '%s' "$SANDBOX_CONFORMANCE"`) {
    return { stdout: input.env?.["SANDBOX_CONFORMANCE"] ?? "", stderr: "", exitCode: 0 }
  }
  if (line === `printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`) {
    return {
      stdout: `${input.env?.["STATIC_PROOF"] ?? ""}:${input.env?.["SPAWN_PROOF"] ?? ""}`,
      stderr: "",
      exitCode: 0
    }
  }
  const printed = /^printf '([^']*)'$/.exec(line)
  if (printed !== null) return { stdout: printed[1] ?? "", stderr: "", exitCode: 0 }
  const exited = /^exit ([0-9]+)$/.exec(line)
  if (exited !== null) return { stdout: "", stderr: "", exitCode: Number(exited[1]) }
  return { stdout: "done", stderr: "", exitCode: 0 }
}

const fakeSdk = (plan: Plan = {}): {
  readonly sdk: Sdk
  readonly recorded: Recorded
  readonly machines: Map<string, Machine>
} => {
  const recorded: Recorded = { acquired: [], commands: [], extended: [], stopped: [] }
  const machines = new Map<string, Machine>()
  const getOrCreate: Sdk["Sandbox"]["getOrCreate"] = async (input) => {
    recorded.acquired.push(input)
    if (plan.acquireFailure !== undefined) throw plan.acquireFailure
    let machine = machines.get(input.name)
    if (machine === undefined) {
      machine = { name: input.name, directories: new Set(), files: new Map(), running: true }
      addDirectory(machine, "/vercel/sandbox")
      machines.set(input.name, machine)
    } else if (input.resume === true) {
      machine.running = true
    }
    const command = (
      stdout: string,
      stderr: string,
      exitCode: number
    ): CommandFinished => ({
      exitCode,
      stdout: () => plan.stdoutFailure === undefined ? Promise.resolve(stdout) : Promise.reject(plan.stdoutFailure),
      stderr: () => plan.stderrFailure === undefined ? Promise.resolve(stderr) : Promise.reject(plan.stderrFailure)
    })
    return {
      name: machine.name,
      runCommand: async (request) => {
        recorded.commands.push(request)
        machine.running = true
        const planned = plan.run?.(request)
        if (planned !== undefined && typeof planned !== "number") throw planned
        if (typeof planned === "number") return command("", "", planned)
        if (request.cmd === "mkdir") {
          addDirectory(machine, request.args?.[1] ?? "")
          return command("", "", 0)
        }
        if (request.cmd === "true") return command("", "", 0)
        const result = shell(request.args?.[1] ?? "", request)
        return command(result.stdout, result.stderr, result.exitCode)
      },
      readFile: async ({ path }) => {
        if (plan.readFailure !== undefined) throw plan.readFailure
        const content = machine.files.get(path)
        return content === undefined ? null : readable(content, plan.textReads === true)
      },
      writeFiles: async (files) => {
        if (plan.writeFailure !== undefined) throw plan.writeFailure
        for (const file of files) {
          if (!machine.directories.has(parentOf(file.path))) throw new Error("parent directory does not exist")
          machine.files.set(
            file.path,
            typeof file.content === "string" ? encoder.encode(file.content) : new Uint8Array(file.content)
          )
        }
      },
      extendTimeout: (duration) => {
        recorded.extended.push(duration)
        return plan.extendFailure === undefined ? Promise.resolve() : Promise.reject(plan.extendFailure)
      },
      stop: () => {
        recorded.stopped.push(machine.name)
        machine.running = false
        return plan.stopFailure === undefined ? Promise.resolve() : Promise.reject(plan.stopFailure)
      }
    }
  }
  return { sdk: { Sandbox: { getOrCreate } }, recorded, machines }
}

const acquired = <A, E>(
  provider: ReturnType<typeof VercelSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("run-1"), body))

describe("VercelSandbox", () => {
  it.effect("passes SandboxConformance against a persistent SDK fake", () =>
    Effect.gen(function*() {
      const { sdk } = fakeSdk()
      const violations = yield* SandboxConformance.check(VercelSandbox.make({ sdk }), {
        provides: { ping: true }
      })
      expect(violations).toEqual([])
    }), 30_000)

  it.effect("uses deterministic persistence, explicit credentials, and the timeout remainder", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      const provider = VercelSandbox.make({
        sdk,
        oidcToken: "explicit-oidc",
        token: "pat",
        teamId: "team",
        projectId: "project",
        env: { VERCEL_OIDC_TOKEN: "ambient-oidc" },
        timeoutMs: 15 * 60_000,
        maxDurationMs: 15 * 60_000,
        runtime: "node22",
        commandEnv: { STATIC_PROOF: "static" }
      })
      const first = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect(session.id).toBe("run-1")
          yield* session.writeFile("/vercel/sandbox/persisted.bin", new Uint8Array([0, 255]))
          return yield* Effect.scoped(
            Effect.flatMap(
              session.spawn(`printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`, {
                env: { SPAWN_PROOF: "spawn", OMITTED: undefined }
              }),
              (process) => Stream.mkString(Stream.decodeText(process.stdout))
            )
          )
        }))
      const second = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          return { remoteId: session.remoteId, content: yield* session.readFile("/vercel/sandbox/persisted.bin") }
        }))

      expect(first).toBe("static:spawn")
      expect(second.remoteId).toBe(recorded.acquired[0]?.name)
      expect(second.content).toEqual(new Uint8Array([0, 255]))
      expect(recorded.acquired).toHaveLength(2)
      expect(recorded.acquired[0]).toMatchObject({
        token: "explicit-oidc",
        timeout: 5 * 60_000,
        persistent: true,
        resume: true,
        runtime: "node22"
      })
      expect(recorded.acquired[0]?.name).toMatch(/^smthrs-run-1-/)
      expect(recorded.extended).toEqual([10 * 60_000, 10 * 60_000])
      expect(recorded.stopped).toHaveLength(2)
      const spawned = recorded.commands.find((command) => command.cmd === "sh")
      expect(spawned?.env).toEqual({ STATIC_PROOF: "static", SPAWN_PROOF: "spawn" })
    }))

  it.effect("resolves caller-supplied credential sources in precedence order", () =>
    Effect.gen(function*() {
      const ambient = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: ambient.sdk,
          token: "pat",
          teamId: "team",
          projectId: "project",
          env: { VERCEL_OIDC_TOKEN: "ambient" }
        }),
        Effect.succeed
      )
      expect(ambient.recorded.acquired[0]).toMatchObject({ token: "ambient" })
      expect(ambient.recorded.acquired[0]).not.toHaveProperty("teamId")

      const personal = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: personal.sdk,
          env: { VERCEL_TOKEN: "env-pat", VERCEL_TEAM_ID: "env-team", VERCEL_PROJECT_ID: "env-project" }
        }),
        Effect.succeed
      )
      expect(personal.recorded.acquired[0]).toMatchObject({
        token: "env-pat",
        teamId: "env-team",
        projectId: "env-project"
      })

      const incomplete = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: incomplete.sdk,
          oidcToken: "",
          token: "pat",
          teamId: "team",
          projectId: ""
        }),
        Effect.succeed
      )
      expect(incomplete.recorded.acquired[0]).not.toHaveProperty("token")
    }))

  it.effect("refuses invalid local configuration before acquiring a sandbox", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      for (
        const provider of [
          VercelSandbox.make({ sdk, timeoutMs: 0 }),
          VercelSandbox.make({ sdk, timeoutMs: Number.POSITIVE_INFINITY }),
          VercelSandbox.make({ sdk, timeoutMs: 60_000, maxDurationMs: 30_000 }),
          VercelSandbox.make({ sdk, workdir: "relative" })
        ]
      ) {
        const failure = yield* Effect.flip(acquired(provider, Effect.succeed))
        expect(failure).toBeInstanceOf(ProviderError)
      }
      expect(recorded.acquired).toEqual([])

      const capped = yield* Effect.flip(
        acquired(
          VercelSandbox.make({ sdk, timeoutMs: 60_000, maxDurationMs: 30_000 }),
          Effect.succeed
        )
      )
      expect((capped as ProviderError).message).toContain("60000ms")
      expect((capped as ProviderError).message).toContain("30000ms")
    }))

  it.effect("drains string streams, supports root files, and surfaces output failures", () =>
    Effect.gen(function*() {
      const plan: Plan = { textReads: true }
      const { sdk } = fakeSdk(plan)
      const provider = VercelSandbox.make({ sdk, timeoutMs: 60_000, workdir: "/custom" })
      yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile("/root-file", encoder.encode("plain text"))
          expect(decoder.decode(yield* session.readFile("/root-file"))).toBe("plain text")
          const process = yield* Effect.scoped(session.spawn("printf 'ok'", {}))
          plan.stdoutFailure = new Error("stdout unavailable")
          const stdout = yield* Effect.flip(Stream.runDrain(process.stdout))
          expect(stdout).toBeInstanceOf(ProviderError)
          plan.stdoutFailure = undefined
          plan.stderrFailure = new Error("stderr unavailable")
          const stderr = yield* Effect.flip(Stream.runDrain(process.stderr))
          expect(stderr).toBeInstanceOf(ProviderError)
        }))
    }))

  it.effect("maps vendor and command failures and still runs teardown", () =>
    Effect.gen(function*() {
      const unavailable = fakeSdk({ acquireFailure: new Error("service offline") })
      const acquireFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: unavailable.sdk }), Effect.succeed)
      )
      expect((acquireFailure as ProviderError).code).toBe("unavailable")

      const extend = fakeSdk({ extendFailure: new Error("limit") })
      const extendFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: extend.sdk, timeoutMs: 6 * 60_000 }), Effect.succeed)
      )
      expect((extendFailure as ProviderError).code).toBe("unavailable")
      expect(extend.recorded.stopped).toHaveLength(1)

      const prepare = fakeSdk({ run: (input) => input.cmd === "mkdir" ? 7 : undefined })
      const prepareFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: prepare.sdk }), Effect.succeed)
      )
      expect((prepareFailure as ProviderError).code).toBe("unavailable")
      expect(prepare.recorded.stopped).toHaveLength(1)

      const runtime: Plan = {}
      const active = fakeSdk(runtime)
      yield* acquired(VercelSandbox.make({ sdk: active.sdk }), (session) =>
        Effect.gen(function*() {
          runtime.run = (input) => input.cmd === "sh" ? new Error("command refused") : undefined
          const spawnFailure = yield* Effect.flip(Effect.scoped(session.spawn("true", {})))
          expect((spawnFailure as ProviderError).code).toBe("spawn_error")
          runtime.run = (input) =>
            input.cmd === "mkdir" && input.args?.[1]?.includes("blocked") === true
              ? 4
              : undefined
          const directoryFailure = yield* Effect.flip(session.writeFile("/blocked/file", new Uint8Array()))
          expect((directoryFailure as ProviderError).code).toBe("unknown")
          runtime.run = undefined
          runtime.writeFailure = new Error("upload refused")
          const writeFailure = yield* Effect.flip(session.writeFile("/file", new Uint8Array()))
          expect((writeFailure as ProviderError).code).toBe("unknown")
          runtime.writeFailure = undefined
          runtime.readFailure = new Error("read refused")
          const readFailure = yield* Effect.flip(session.readFile("/file"))
          expect((readFailure as ProviderError).code).toBe("unknown")
          runtime.readFailure = undefined
          runtime.run = (input) => input.cmd === "true" ? 9 : undefined
          const pingFailure = yield* Effect.flip(session.ping!)
          expect((pingFailure as ProviderError).code).toBe("unavailable")
        }))

      const ignoredStop = fakeSdk({ stopFailure: new Error("already stopped") })
      yield* acquired(VercelSandbox.make({ sdk: ignoredStop.sdk }), Effect.succeed)
      expect(ignoredStop.recorded.stopped).toHaveLength(1)
    }))
})
