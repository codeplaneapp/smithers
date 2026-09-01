import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Path, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

// -----------------------------------------------------------------------------
// The Vercel SDK as a fake: real programs behind the vendor's promise surface.
// -----------------------------------------------------------------------------

// The fake emulates only what `@vercel/sandbox` adds around a machine — the
// named-sandbox registry, the promise-shaped `runCommand` that resolves once
// the command finished with its output as strings, `readFile` answering a
// Node stream or `null`, and the vendor error shapes. Underneath, every
// command is the real program run by the platform spawner against a real
// directory tree, and the file surface reads and writes that same tree, so
// what the provider proves here is agreement with a machine, not with a
// script table.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-vercel-sandbox-")))
// The image's own working directory, which `/vercel/sandbox` is on the real
// machine: the default `cwd` of every command and the base of relative paths.
const home = join(root, "vercel-home")
mkdirSync(home)
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const dir = (label: string): string => mkdtempSync(join(root, `${label}-`))

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)
const local = Effect.runSync(
  Effect.gen(function*() {
    return yield* ChildProcessSpawner
  }).pipe(Effect.provide(platform))
)

interface FinishedRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const finishedRun = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>> | undefined
): Promise<FinishedRun> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        // The sandbox image gives commands its own base environment plus the
        // caller's variables, which on this host is the process environment
        // plus the request's.
        const child = yield* local.spawn(ChildProcess.make(file, [...args], { cwd, env: { ...env }, extendEnv: true }))
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            child.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, exitCode }
      })
    )
  )

interface Faults {
  /** The control plane refuses the acquire call. */
  acquireFailure?: unknown
  /** `extendTimeout` is refused (plan limit reached). */
  extendFailure?: unknown
  /** `stop` is refused (the session already ended). */
  stopFailure?: unknown
  /** `readFile` is refused before any stream is handed out. */
  readFailure?: unknown
  /** Every `runCommand` call is refused (the API is unreachable). */
  runFailure?: unknown
  /** Fetching a finished command's stdout fails. */
  stdoutFailure?: unknown
  /** Fetching a finished command's stderr fails. */
  stderrFailure?: unknown
  /** The machine reports every command finished with this status (a dying VM). */
  commandFailure?: { readonly exitCode: number } | undefined
  /** File reads arrive as UTF-8 text chunks rather than bytes. */
  textReads?: boolean
}

interface Recorded {
  readonly acquired: Array<CreateInput>
  readonly commands: Array<RunInput>
  readonly extended: Array<number>
  readonly stopped: Array<string>
}

const fakeSdk = (faults: Faults = {}): { readonly sdk: Sdk; readonly recorded: Recorded } => {
  const recorded: Recorded = { acquired: [], commands: [], extended: [], stopped: [] }
  const machines = new Map<string, { readonly name: string; running: boolean }>()
  const finished = (result: FinishedRun): CommandFinished => ({
    exitCode: result.exitCode,
    stdout: () =>
      faults.stdoutFailure === undefined ? Promise.resolve(result.stdout) : Promise.reject(faults.stdoutFailure),
    stderr: () =>
      faults.stderrFailure === undefined ? Promise.resolve(result.stderr) : Promise.reject(faults.stderrFailure)
  })
  // Relative paths resolve the way the vendor documents them: "Defaults to
  // writing to /vercel/sandbox unless an absolute path is specified."
  const resolve = (path: string): string => path.startsWith("/") ? path : join(home, path)
  const instance = (machine: { readonly name: string; running: boolean }): VendorSandbox => ({
    name: machine.name,
    runCommand: async (request) => {
      recorded.commands.push(request)
      if (faults.runFailure !== undefined) throw faults.runFailure
      // "A persistent sandbox still auto-resumes on the first SDK call that
      // needs a running session (such as `runCommand`)."
      machine.running = true
      if (faults.commandFailure !== undefined) {
        return finished({ stdout: "", stderr: "", exitCode: faults.commandFailure.exitCode })
      }
      return finished(await finishedRun(request.cmd, request.args ?? [], request.cwd ?? home, request.env))
    },
    readFile: async ({ path }) => {
      if (faults.readFailure !== undefined) throw faults.readFailure
      const at = resolve(path)
      if (!existsSync(at)) return null
      return faults.textReads === true ? createReadStream(at, "utf8") : createReadStream(at)
    },
    writeFiles: async (files) => {
      for (const file of files) writeFileSync(resolve(file.path), file.content)
    },
    extendTimeout: async (duration) => {
      recorded.extended.push(duration)
      if (faults.extendFailure !== undefined) throw faults.extendFailure
    },
    stop: async () => {
      recorded.stopped.push(machine.name)
      machine.running = false
      if (faults.stopFailure !== undefined) throw faults.stopFailure
    }
  })
  // The vendor's documented `getOrCreate` flow: try `get` first, and on
  // not_found create a sandbox with that name (sandbox.d.ts).
  const get = (name: string) => machines.get(name)
  const create = (name: string) => {
    const machine = { name, running: true }
    machines.set(name, machine)
    return machine
  }
  const getOrCreate: Sdk["Sandbox"]["getOrCreate"] = async (input) => {
    recorded.acquired.push(input)
    if (faults.acquireFailure !== undefined) throw faults.acquireFailure
    const machine = get(input.name) ?? create(input.name)
    if (input.resume === true) machine.running = true
    return instance(machine)
  }
  return { sdk: { Sandbox: { getOrCreate } }, recorded }
}

const acquired = <A, E>(
  provider: ReturnType<typeof VercelSandbox.make>,
  body: (session: Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("run-1"), body))

const output = (session: Session, command: string, options: Parameters<Session["spawn"]>[1] = {}) =>
  Effect.scoped(
    Effect.gen(function*() {
      const process = yield* session.spawn(command, options)
      const stdout = yield* Stream.mkString(Stream.decodeText(process.stdout))
      const code = yield* process.exitCode
      return { stdout, code }
    })
  )

describe("VercelSandbox", () => {
  it.effect("passes SandboxConformance running real programs against a real tree", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      const violations = yield* SandboxConformance.check(
        VercelSandbox.make({ sdk, workdir: dir("conformance") }),
        { provides: { ping: true } }
      )
      expect(violations).toEqual([])
      // Every shell line reaches the machine as `sh -c`, never a login shell
      // whose profile output would land in parsed stdout.
      const shells = recorded.commands.filter((command) => command.cmd === "sh")
      expect(shells.length).toBeGreaterThan(0)
      expect(shells.every((command) => command.args?.[0] === "-c")).toBe(true)
    }), 60_000)

  it.effect("uses deterministic persistence, explicit credentials, and the timeout remainder", () =>
    Effect.gen(function*() {
      const { recorded, sdk } = fakeSdk()
      const work = dir("persist")
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
        commandEnv: { STATIC_PROOF: "static" },
        workdir: work
      })
      const first = yield* acquired(provider, (session) =>
        Effect.gen(function*() {
          expect(session.id).toBe("run-1")
          yield* session.writeFile(`${work}/persisted.bin`, new Uint8Array([0, 255]))
          return yield* Effect.scoped(
            Effect.flatMap(
              session.spawn(`printf '%s:%s' "$STATIC_PROOF" "$SPAWN_PROOF"`, {
                env: { SPAWN_PROOF: "spawn", OMITTED: undefined }
              }),
              (process) => Stream.mkString(Stream.decodeText(process.stdout))
            )
          )
        }))
      const second = yield* acquired(
        provider,
        (session) =>
          Effect.map(session.readFile(`${work}/persisted.bin`), (content) => ({
            remoteId: session.remoteId,
            content
          }))
      )

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
      expect(spawned?.args?.[0]).toBe("-c")
      expect(spawned?.env).toEqual({ STATIC_PROOF: "static", SPAWN_PROOF: "spawn" })
    }))

  it.effect("resolves caller-supplied credential sources in precedence order", () =>
    Effect.gen(function*() {
      const work = dir("credentials")
      const ambient = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: ambient.sdk,
          token: "pat",
          teamId: "team",
          projectId: "project",
          env: { VERCEL_OIDC_TOKEN: "ambient" },
          workdir: work
        }),
        Effect.succeed
      )
      expect(ambient.recorded.acquired[0]).toMatchObject({ token: "ambient" })
      expect(ambient.recorded.acquired[0]).not.toHaveProperty("teamId")

      const personal = fakeSdk()
      yield* acquired(
        VercelSandbox.make({
          sdk: personal.sdk,
          env: { VERCEL_TOKEN: "env-pat", VERCEL_TEAM_ID: "env-team", VERCEL_PROJECT_ID: "env-project" },
          workdir: work
        }),
        Effect.succeed
      )
      expect(personal.recorded.acquired[0]).toMatchObject({
        token: "env-pat",
        teamId: "env-team",
        projectId: "env-project"
      })

      // A personal token is used only when every identifier arrives with it.
      const incomplete: Array<VercelSandbox.Credentials> = [
        { oidcToken: "", token: "pat", teamId: "team", projectId: "" },
        { token: "", teamId: "team", projectId: "project" },
        { token: "pat", teamId: "", projectId: "project" },
        { token: "pat", teamId: "team" },
        { token: "pat", projectId: "project" },
        {}
      ]
      for (const credentials of incomplete) {
        const missing = fakeSdk()
        yield* acquired(VercelSandbox.make({ sdk: missing.sdk, workdir: work, ...credentials }), Effect.succeed)
        expect(missing.recorded.acquired[0]).not.toHaveProperty("token")
        expect(missing.recorded.acquired[0]).not.toHaveProperty("teamId")
        expect(missing.recorded.acquired[0]).not.toHaveProperty("projectId")
      }
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

  it.effect("delivers standard input, roots relative cwds, and drains text reads", () =>
    Effect.gen(function*() {
      const faults: Faults = {}
      const { sdk } = fakeSdk(faults)
      const work = dir("behavior")
      yield* acquired(VercelSandbox.make({ sdk, workdir: work }), (session) =>
        Effect.gen(function*() {
          const bytes = new Uint8Array([0, 1, 2, 255, 10, 13, 7])
          expect(yield* output(session, "cat > stdin-copy.bin", { stdin: bytes })).toEqual({ stdout: "", code: 0 })
          expect(yield* session.readFile(`${work}/stdin-copy.bin`)).toEqual(bytes)
          // The redirect's staged input is removed once the command ends.
          expect(yield* Effect.flip(session.readFile(`${work}/.smthrs-stdin-0`))).toMatchObject({ code: "not_found" })

          expect((yield* output(session, "mkdir -p nested/leaf")).code).toBe(0)
          expect((yield* output(session, "pwd", { cwd: "nested/leaf" })).stdout).toBe(`${work}/nested/leaf\n`)
          expect((yield* output(session, "pwd", { cwd: "./nested" })).stdout).toBe(`${work}/nested\n`)
          expect((yield* output(session, "pwd", { cwd: "" })).stdout).toBe(`${work}\n`)
          expect((yield* output(session, "pwd", { cwd: "." })).stdout).toBe(`${work}\n`)
          expect((yield* output(session, "pwd", { cwd: work })).stdout).toBe(`${work}\n`)

          // A path with no parent to create takes the bare write, and the
          // vendor roots it at the sandbox's own working directory.
          yield* session.writeFile("rooted.bin", new Uint8Array([42]))
          expect(Array.from(yield* session.readFile(join(home, "rooted.bin")))).toEqual([42])

          // A vendor stream may hand contents back as text chunks.
          faults.textReads = true
          yield* session.writeFile(`${work}/text-file`, encoder.encode("plain text"))
          expect(decoder.decode(yield* session.readFile(`${work}/text-file`))).toBe("plain text")
          faults.textReads = false

          const process = yield* Effect.scoped(session.spawn("printf 'ok'", {}))
          faults.stdoutFailure = new Error("stdout unavailable")
          expect(yield* Effect.flip(Stream.runDrain(process.stdout))).toBeInstanceOf(ProviderError)
          faults.stdoutFailure = undefined
          faults.stderrFailure = new Error("stderr unavailable")
          expect(yield* Effect.flip(Stream.runDrain(process.stderr))).toBeInstanceOf(ProviderError)
          faults.stderrFailure = undefined
        }))
    }), 30_000)

  it.effect("maps vendor and command failures and still runs teardown", () =>
    Effect.gen(function*() {
      // The default workdir is only reachable on the real machine; refusing
      // the acquire keeps the fake off the host's root filesystem.
      const unavailable = fakeSdk({ acquireFailure: new Error("service offline") })
      const acquireFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: unavailable.sdk }), Effect.succeed)
      )
      expect((acquireFailure as ProviderError).code).toBe("unavailable")

      const extend = fakeSdk({ extendFailure: new Error("limit") })
      const extendFailure = yield* Effect.flip(
        acquired(
          VercelSandbox.make({ sdk: extend.sdk, timeoutMs: 6 * 60_000, workdir: dir("extend") }),
          Effect.succeed
        )
      )
      expect((extendFailure as ProviderError).code).toBe("unavailable")
      expect(extend.recorded.stopped).toHaveLength(1)

      // The transport refusing every command stops acquisition at the
      // workspace preparation.
      const rejected = fakeSdk({ runFailure: new Error("api unreachable") })
      const rejectedFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: rejected.sdk, workdir: dir("rejected") }), Effect.succeed)
      )
      expect((rejectedFailure as ProviderError).code).toBe("unavailable")
      expect(rejected.recorded.stopped).toHaveLength(1)

      // A workspace that really cannot be created refuses the session.
      const blocked = fakeSdk()
      const blocker = join(dir("prepare"), "blocker")
      writeFileSync(blocker, "a file, not a directory")
      const prepareFailure = yield* Effect.flip(
        acquired(VercelSandbox.make({ sdk: blocked.sdk, workdir: `${blocker}/work` }), Effect.succeed)
      )
      expect((prepareFailure as ProviderError).code).toBe("unavailable")
      expect(blocked.recorded.stopped).toHaveLength(1)

      const faults: Faults = {}
      const active = fakeSdk(faults)
      const work = dir("runtime")
      yield* acquired(VercelSandbox.make({ sdk: active.sdk, workdir: work }), (session) =>
        Effect.gen(function*() {
          faults.runFailure = new Error("command refused")
          const spawnFailure = yield* Effect.flip(Effect.scoped(session.spawn("true", {})))
          expect((spawnFailure as ProviderError).code).toBe("spawn_error")
          faults.runFailure = undefined

          // A parent that is really a file cannot become a directory.
          writeFileSync(join(work, "occupied"), "a file, not a directory")
          const directoryFailure = yield* Effect.flip(
            session.writeFile(`${work}/occupied/child`, new Uint8Array([1]))
          )
          expect((directoryFailure as ProviderError).code).toBe("unknown")

          // A directory that refuses writes fails the upload itself.
          mkdirSync(join(work, "sealed-dir"))
          chmodSync(join(work, "sealed-dir"), 0o555)
          const writeFailure = yield* Effect.flip(
            session.writeFile(`${work}/sealed-dir/child`, new Uint8Array([1]))
          )
          expect((writeFailure as ProviderError).code).toBe("unknown")

          faults.readFailure = new Error("read refused")
          const readFailure = yield* Effect.flip(session.readFile(`${work}/anything`))
          expect((readFailure as ProviderError).code).toBe("unknown")
          faults.readFailure = undefined

          // A file that exists but cannot be opened fails while draining.
          writeFileSync(join(work, "sealed.bin"), "sealed")
          chmodSync(join(work, "sealed.bin"), 0)
          const sealed = yield* Effect.flip(session.readFile(join(work, "sealed.bin")))
          expect(sealed).toMatchObject({ code: "unknown" })

          // A dying machine reports commands as finished without running them.
          faults.commandFailure = { exitCode: 9 }
          const pingFailure = yield* Effect.flip(session.ping!)
          expect((pingFailure as ProviderError).code).toBe("unavailable")
          faults.commandFailure = undefined
        }))

      // A stop that fails is logged, and the acquisition still succeeds.
      const ignoredStop = fakeSdk({ stopFailure: new Error("already stopped") })
      yield* acquired(VercelSandbox.make({ sdk: ignoredStop.sdk, workdir: dir("stop") }), Effect.succeed)
      expect(ignoredStop.recorded.stopped).toHaveLength(1)
    }), 30_000)
})
