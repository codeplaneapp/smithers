import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import * as CloudflareSandbox from "../src/CloudflareSandbox/index.ts"
import type { RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import type { Session } from "../src/Sandbox/Session.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

interface SandboxOptions {
  readonly enableDefaultSession?: boolean | undefined
  readonly keepAlive?: boolean | undefined
  readonly sleepAfter?: string | number | undefined
}

interface CommandOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

type ProcessExitMode = "wait" | "handle" | "fallback"

class CloudflareError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

interface Binding {
  readonly active: Map<string, FakeSandbox>
  readonly instances: Array<FakeSandbox>
  readonly resolutions: Array<{ readonly id: string; readonly options: SandboxOptions | undefined }>
  resolveFailure?: unknown
  processExitMode: ProcessExitMode
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const base64Of = (content: Uint8Array): string => {
  let binary = ""
  for (const byte of content) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const bytesOfBase64 = (content: string): Uint8Array =>
  Uint8Array.from(atob(content), (character) => character.charCodeAt(0))

const parentOf = (path: string): string | undefined => {
  const separator = path.lastIndexOf("/")
  return separator < 0 ? undefined : separator === 0 ? "/" : path.slice(0, separator)
}

const commandResult = (command: string, options: CommandOptions | undefined): CommandResult => {
  if (command === "true") return { stdout: "", stderr: "", exitCode: 0 }
  if (command === "pwd") return { stdout: `${options?.cwd ?? "/"}\n`, stderr: "", exitCode: 0 }
  if (command === `printf '%s' "$SANDBOX_CONFORMANCE"`) {
    return { stdout: options?.env?.SANDBOX_CONFORMANCE ?? "", stderr: "", exitCode: 0 }
  }
  const literal = /^printf '([^']*)'$/.exec(command)
  if (literal !== null) return { stdout: literal[1]!, stderr: "", exitCode: 0 }
  if (command.startsWith("exit ")) return { stdout: "", stderr: "", exitCode: Number(command.slice(5)) }
  if (command === "emit-both") return { stdout: "out", stderr: "err", exitCode: 4 }
  return { stdout: "", stderr: `sh: ${command}: not found\n`, exitCode: 127 }
}

class FakeSandbox {
  readonly binding: Binding
  readonly id: string
  readonly processExitMode: ProcessExitMode
  readonly directories = new Set(["/"])
  readonly files = new Map<string, Uint8Array>()
  readonly events: Array<string> = []
  readonly readFailures = new Map<string, unknown>()
  readonly readContents = new Map<string, string>()
  failMkdir: unknown | undefined
  failWrite: unknown | undefined
  failExec: unknown | undefined
  failStart: unknown | undefined
  failDestroy: unknown | undefined
  pingExitCode = 0
  destroyed = false

  constructor(binding: Binding, id: string, processExitMode: ProcessExitMode) {
    this.binding = binding
    this.id = id
    this.processExitMode = processExitMode
  }

  private assertLive(): void {
    if (this.destroyed) throw new CloudflareError("SESSION_DESTROYED", "sandbox destroyed")
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean | undefined }): Promise<{ path: string }> {
    this.assertLive()
    this.events.push(`mkdir:${path}:${String(options?.recursive)}`)
    if (this.failMkdir !== undefined) {
      const cause = this.failMkdir
      this.failMkdir = undefined
      throw cause
    }
    if (options?.recursive === true) {
      const pieces = path.split("/").filter((piece) => piece.length > 0)
      let current = path.startsWith("/") ? "" : "."
      for (const piece of pieces) {
        current = current === "" ? `/${piece}` : `${current}/${piece}`
        this.directories.add(current)
      }
    } else {
      const parent = parentOf(path)
      if (parent !== undefined && !this.directories.has(parent)) {
        throw new CloudflareError("FILE_NOT_FOUND", `missing ${parent}`)
      }
      this.directories.add(path)
    }
    return { path }
  }

  async writeFile(
    path: string,
    content: string,
    options?: { readonly encoding?: string | undefined }
  ): Promise<{ path: string; success: true }> {
    this.assertLive()
    this.events.push(`write:${path}:${String(options?.encoding)}`)
    if (this.failWrite !== undefined) {
      const cause = this.failWrite
      this.failWrite = undefined
      throw cause
    }
    const parent = parentOf(path)
    if (parent !== undefined && !this.directories.has(parent)) {
      throw new CloudflareError("FILE_NOT_FOUND", `missing ${parent}`)
    }
    this.files.set(path, options?.encoding === "base64" ? bytesOfBase64(content) : encoder.encode(content))
    return { path, success: true }
  }

  async readFile(
    path: string,
    options?: { readonly encoding?: string | undefined }
  ): Promise<{ content: string; path: string; success: true }> {
    this.assertLive()
    this.events.push(`read:${path}:${String(options?.encoding)}`)
    if (this.readFailures.has(path)) throw this.readFailures.get(path)
    if (this.readContents.has(path)) {
      return { path, success: true, content: this.readContents.get(path)! }
    }
    const content = this.files.get(path)
    if (content === undefined) throw new CloudflareError("FILE_NOT_FOUND", `missing ${path}`)
    return {
      path,
      success: true,
      content: options?.encoding === "base64" ? base64Of(content) : decoder.decode(content)
    }
  }

  async exec(command: string, options?: CommandOptions): Promise<CommandResult> {
    this.assertLive()
    this.events.push(`exec:${command}`)
    if (this.failExec !== undefined) {
      const cause = this.failExec
      this.failExec = undefined
      throw cause
    }
    const result = commandResult(command, options)
    return command === "true" ? { ...result, exitCode: this.pingExitCode } : result
  }

  async startProcess(command: string, options?: CommandOptions) {
    this.assertLive()
    this.events.push(`start:${command}`)
    if (this.failStart !== undefined) {
      const cause = this.failStart
      this.failStart = undefined
      throw cause
    }
    const result = commandResult(command, options)
    const mode = this.processExitMode
    return {
      ...(mode === "handle" ? { exitCode: result.exitCode } : {}),
      waitForExit: async () => {
        this.events.push(`wait:${command}`)
        return mode === "wait" ? { exitCode: result.exitCode } : { exitCode: undefined }
      },
      getLogs: async () => {
        this.events.push(`logs:${command}`)
        return { stdout: result.stdout, stderr: result.stderr }
      }
    }
  }

  async destroy(): Promise<void> {
    this.events.push("destroy")
    if (this.failDestroy !== undefined) throw this.failDestroy
    this.destroyed = true
    if (this.binding.active.get(this.id) === this) this.binding.active.delete(this.id)
  }
}

const binding = (processExitMode: ProcessExitMode = "wait"): Binding => ({
  active: new Map(),
  instances: [],
  resolutions: [],
  processExitMode
})

const sdk = {
  getSandbox(workerBinding: Binding, id: string, options?: SandboxOptions): FakeSandbox {
    workerBinding.resolutions.push({ id, options })
    if (workerBinding.resolveFailure !== undefined) throw workerBinding.resolveFailure
    const existing = workerBinding.active.get(id)
    if (existing !== undefined) return existing
    const sandbox = new FakeSandbox(workerBinding, id, workerBinding.processExitMode)
    workerBinding.active.set(id, sandbox)
    workerBinding.instances.push(sandbox)
    return sandbox
  }
} satisfies CloudflareSandbox.Sdk<Binding>

const acquired = <A, E>(
  provider: ReturnType<typeof CloudflareSandbox.make<Binding>>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("session/key"), body))

const output = (
  process: RemoteProcess
): Effect.Effect<{ stdout: string; stderr: string; code: number }, ProviderError> =>
  Effect.all({
    stdout: Stream.mkString(Stream.decodeText(process.stdout)),
    stderr: Stream.mkString(Stream.decodeText(process.stderr)),
    code: process.exitCode
  })

describe("CloudflareSandbox", () => {
  it.effect("conforms in exec mode and forwards only named resolver options", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const provider = CloudflareSandbox.make({
        sdk,
        binding: workerBinding,
        workdir: "/work dir",
        keepAlive: true,
        sleepAfter: "3m"
      })
      const violations = yield* SandboxConformance.check(provider, { provides: { ping: true } })
      expect(violations).toEqual([])
      expect(workerBinding.resolutions.length).toBeGreaterThan(1)
      expect(workerBinding.resolutions.every(({ options }) =>
        options?.enableDefaultSession === false && options.keepAlive === true && options.sleepAfter === "3m"
      )).toBe(true)
      expect(workerBinding.instances.every((instance) =>
        instance.destroyed
      )).toBe(true)
      expect(workerBinding.instances.some((instance) =>
        instance.events.includes("write:/work dir/conformance-bytes.bin:base64") &&
        instance.events.includes("read:/work dir/conformance-bytes.bin:base64")
      )).toBe(true)
    }))

  it.effect("conforms in process mode only after waiting and fetching logs", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const provider = CloudflareSandbox.make({ sdk, binding: workerBinding, execution: "process" })
      const violations = yield* SandboxConformance.check(provider, { provides: { ping: true } })
      expect(violations).toEqual([])
      const processEvents = workerBinding.instances.flatMap((instance) => instance.events).filter((event) =>
        /^(?:start|wait|logs):/.test(event)
      )
      for (let index = 0; index < processEvents.length; index += 3) {
        expect(processEvents.slice(index, index + 3).map((event) => event.slice(0, event.indexOf(":")))).toEqual([
          "start",
          "wait",
          "logs"
        ])
      }
    }))

  it.effect("covers process exit fallbacks and command option filtering", () =>
    Effect.gen(function*() {
      const handleBinding = binding("handle")
      const handleProvider = CloudflareSandbox.make({ sdk, binding: handleBinding, execution: "process" })
      const handleResult = yield* acquired(handleProvider, (session) =>
        Effect.scoped(Effect.flatMap(
          session.spawn("emit-both", { cwd: "/chosen", env: { KEEP: "yes", DROP: undefined } }),
          output
        )))
      expect(handleResult).toEqual({ stdout: "out", stderr: "err", code: 4 })

      const fallbackBinding = binding("fallback")
      const fallbackProvider = CloudflareSandbox.make({ sdk, binding: fallbackBinding, execution: "process" })
      const fallback = yield* acquired(fallbackProvider, (session) =>
        Effect.scoped(Effect.flatMap(session.spawn("emit-both", {}), (process) => process.exitCode)))
      expect(fallback).toBe(1)
      expect(fallbackBinding.resolutions[0]?.options).toEqual({ enableDefaultSession: false })
    }))

  it.effect("maps vendor failures and releases half-prepared sandboxes", () =>
    Effect.gen(function*() {
      const resolveBinding = binding()
      resolveBinding.resolveFailure = new Error("binding unavailable")
      const resolveProvider = CloudflareSandbox.make({ sdk, binding: resolveBinding })
      const resolveFailure = yield* Effect.flip(Effect.scoped(resolveProvider.acquire("key")))
      expect(resolveFailure).toMatchObject({ code: "unavailable" })

      const setupBinding = binding()
      const setupSdk = {
        getSandbox(workerBinding: Binding, id: string, options?: SandboxOptions) {
          const sandbox = sdk.getSandbox(workerBinding, id, options)
          sandbox.failMkdir = new Error("mkdir failed")
          return sandbox
        }
      } satisfies CloudflareSandbox.Sdk<Binding>
      const setupProvider = CloudflareSandbox.make({ sdk: setupSdk, binding: setupBinding })
      const setupFailure = yield* Effect.flip(Effect.scoped(setupProvider.acquire("key")))
      expect(setupFailure).toMatchObject({ code: "unavailable" })
      expect(setupBinding.instances[0]?.events).toContain("destroy")

      const workerBinding = binding()
      const provider = CloudflareSandbox.make({ sdk, binding: workerBinding })
      yield* Effect.scoped(
        Effect.flatMap(provider.acquire("key"), (session) =>
          Effect.sync(() => {
            workerBinding.instances.at(-1)!.failDestroy = new Error("destroy failed")
            expect(session.remoteId).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{1,8}$/)
          }))
      )
    }))

  it.effect("preserves detailed file and process failure codes", () =>
    Effect.gen(function*() {
      const workerBinding = binding()
      const provider = CloudflareSandbox.make({ sdk, binding: workerBinding })
      yield* Effect.scoped(
        Effect.flatMap(provider.acquire("edge"), (session) =>
          Effect.gen(function*() {
            const live = workerBinding.instances.at(-1)!
            yield* session.writeFile("leaf", new Uint8Array())
            yield* session.writeFile("/leaf", new Uint8Array([0, 255]))
            expect(yield* session.readFile("/leaf")).toEqual(new Uint8Array([0, 255]))

            live.readContents.set("/invalid", "not base64 %")
            expect(yield* Effect.flip(session.readFile("/invalid"))).toMatchObject({ code: "unknown" })

            live.readFailures.set("/without-code", new Error("read failed"))
            live.readFailures.set("/null", null)
            live.readFailures.set("/string", "read failed")
            for (const path of ["/without-code", "/null", "/string"]) {
              expect(yield* Effect.flip(session.readFile(path))).toMatchObject({ code: "unknown" })
            }

            live.failMkdir = new Error("parent failed")
            expect(yield* Effect.flip(session.writeFile("/new/leaf", new Uint8Array()))).toMatchObject({
              code: "unknown"
            })
            live.failWrite = new Error("write failed")
            expect(yield* Effect.flip(session.writeFile("/leaf", new Uint8Array()))).toMatchObject({
              code: "unknown"
            })

            live.failExec = new Error("exec failed")
            expect(yield* Effect.flip(Effect.scoped(session.spawn("pwd", {})))).toMatchObject({
              code: "spawn_error"
            })
            live.pingExitCode = 8
            expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "unavailable" })
            live.failExec = new Error("ping rejected")
            expect(yield* Effect.flip(session.ping!)).toMatchObject({ code: "unavailable" })
          }))
      )

      const processBinding = binding()
      const processProvider = CloudflareSandbox.make({
        sdk,
        binding: processBinding,
        execution: "process"
      })
      yield* Effect.scoped(
        Effect.flatMap(processProvider.acquire("edge"), (session) => {
          processBinding.instances.at(-1)!.failStart = new Error("start failed")
          return Effect.asVoid(Effect.flip(Effect.scoped(session.spawn("pwd", {}))))
        })
      )
    }))
})
