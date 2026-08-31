import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Path, PlatformError, Stream } from "effect"
import * as Scope from "effect/Scope"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"

const decoder = new TextDecoder()

const withSession = <A, E>(
  provider: Sandbox.TestSessionProvider,
  body: (session: Sandbox.Session) => Effect.Effect<A, E>
): Effect.Effect<A, E | ProviderError> => Effect.scoped(Effect.flatMap(provider.acquire("probe"), body))

const platformReason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("Sandbox.TestSession", () => {
  it.effect("round-trips files through an isolated in-memory tree", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ files: { "/sandbox/seed.txt": "seeded" } })
      const written = new Uint8Array([1, 2, 3])
      const result = yield* withSession(provider, (session) =>
        Effect.gen(function*() {
          yield* session.writeFile("/sandbox/out.bin", written)
          const seed = yield* session.readFile("/sandbox/seed.txt")
          const out = yield* session.readFile("/sandbox/out.bin")
          return { seed: decoder.decode(seed), out }
        }))
      // Mutating what was written or read must not reach the stored tree.
      written[0] = 9
      result.out[1] = 9
      expect(result.seed).toBe("seeded")
      expect(Array.from(provider.state.files.get("/sandbox/out.bin")!)).toEqual([1, 2, 3])
      expect(provider.state.acquired).toEqual(["probe"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("reports an absent file with not_found and an unknown command with exit 127", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ files: { "/sandbox/bytes": new Uint8Array([7]) } })
      const outcome = yield* withSession(provider, (session) =>
        Effect.gen(function*() {
          const absent = yield* Effect.flip(session.readFile("/sandbox/missing"))
          const process = yield* Effect.scoped(session.spawn("unscripted", {}))
          const stderr = yield* Stream.mkString(Stream.decodeText(process.stderr))
          const code = yield* process.exitCode
          return { absent, stderr, code }
        }))
      expect(outcome.absent).toBeInstanceOf(ProviderError)
      expect((outcome.absent as ProviderError).code).toBe("not_found")
      expect(outcome.stderr).toContain("command not found")
      expect(outcome.code).toBe(127)
    }))

  it.effect("resolves scripts through the record, then the resolver, honoring failures and pings", () =>
    Effect.gen(function*() {
      const failure = new ProviderError({ code: "spawn_error", message: "refused" })
      const provider = Sandbox.TestSession.make({
        session: "named",
        remoteId: "vm-1",
        workdir: "/work",
        scripts: { direct: { stdout: "record" } },
        script: (command) => command === "resolved" ? { stdout: "resolver", exitCode: 3 } : { failure },
        ping: Effect.void
      })
      const outcome = yield* withSession(provider, (session) =>
        Effect.gen(function*() {
          const direct = yield* Effect.scoped(
            Effect.flatMap(session.spawn("direct", {}), (process) =>
              Stream.mkString(Stream.decodeText(process.stdout)))
          )
          const resolved = yield* Effect.scoped(
            Effect.flatMap(session.spawn("resolved", {}), (process) => process.exitCode)
          )
          const refused = yield* Effect.flip(Effect.scoped(Effect.asVoid(session.spawn("anything", {}))))
          yield* session.ping!
          return { direct, resolved, refused, id: session.id, remoteId: session.remoteId, workdir: session.workdir }
        }))
      expect(outcome).toMatchObject({
        direct: "record",
        resolved: 3,
        id: "named",
        remoteId: "vm-1",
        workdir: "/work"
      })
      expect(outcome.refused).toBe(failure)
      expect(provider.state.commands).toEqual(["direct", "resolved", "anything"])
    }))

  it.effect("fails acquisition when scripted to", () =>
    Effect.gen(function*() {
      const refusal = new ProviderError({ code: "unavailable", message: "no capacity" })
      const provider = Sandbox.TestSession.make({ acquireFailure: refusal })
      const outcome = yield* Effect.exit(Effect.scoped(provider.acquire("any")))
      expect(Exit.isFailure(outcome)).toBe(true)
      expect(provider.state.acquired).toEqual([])
    }))
})

describe("Sandbox.commandProvider", () => {
  it.effect("acquires on open, spawns through the held session, and releases with the scope", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ scripts: { greet: { stdout: "hello" } } })
      const projected = Sandbox.commandProvider(provider, { session: "cmd" })
      const output = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* projected.open("cmd")
          return yield* Effect.scoped(
            Effect.flatMap(projected.spawn("greet", {}), (process) =>
              Stream.mkString(Stream.decodeText(process.stdout)))
          )
        })
      )
      expect(output).toBe("hello")
      expect(provider.state.acquired).toEqual(["cmd"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("refuses to spawn, signal, or ping with no open session", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ ping: Effect.void })
      const projected = Sandbox.commandProvider(provider, {
        session: "cmd",
        provides: { kill: true, ping: true }
      })
      const spawn = yield* Effect.flip(Effect.scoped(Effect.asVoid(projected.spawn("greet", {}))))
      const kill = yield* Effect.flip(
        projected.kill!({ stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) }, "SIGTERM")
      )
      const ping = yield* Effect.flip(projected.ping!)
      for (const error of [spawn, kill, ping]) {
        expect(error).toBeInstanceOf(ProviderError)
        expect((error as ProviderError).code).toBe("unavailable")
      }
    }))

  it.effect("fails a declared capability the acquired session does not provide", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const projected = Sandbox.commandProvider(provider, {
        session: "cmd",
        provides: { kill: true, ping: true }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* projected.open("cmd")
          const kill = yield* Effect.flip(
            projected.kill!(
              { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.succeed(0) },
              "SIGTERM"
            )
          )
          const ping = yield* Effect.flip(projected.ping!)
          return { kill, ping }
        })
      )
      expect((outcome.kill as ProviderError).message).toContain("does not provide kill")
      expect((outcome.ping as ProviderError).message).toContain("does not provide ping")
    }))

  it.effect("declares no capability it was not told about", () =>
    Effect.gen(function*() {
      const projected = Sandbox.commandProvider(Sandbox.TestSession.make(), { session: "cmd" })
      expect(projected.kill).toBeUndefined()
      expect(projected.ping).toBeUndefined()
    }))

  it.effect("lets a stale generation's finalizer leave a newer session in place", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ scripts: { greet: { stdout: "still here" } } })
      const projected = Sandbox.commandProvider(provider, { session: "cmd" })
      const output = yield* Effect.gen(function*() {
        const first = yield* Scope.make()
        yield* Effect.provideService(projected.open("cmd"), Scope.Scope, first)
        const second = yield* Scope.make()
        yield* Effect.provideService(projected.open("cmd"), Scope.Scope, second)
        // Closing the FIRST generation must not clear the second's session.
        yield* Scope.close(first, Exit.void)
        const output = yield* Effect.scoped(
          Effect.flatMap(projected.spawn("greet", {}), (process) =>
            Stream.mkString(Stream.decodeText(process.stdout)))
        )
        yield* Scope.close(second, Exit.void)
        return output
      })
      expect(output).toBe("still here")
      expect(provider.state.released).toBe(2)
    }))
})

describe("Sandbox.fileSystem", () => {
  const probeSession = (
    provider: Sandbox.TestSessionProvider
  ): Effect.Effect<FileSystem.FileSystem, ProviderError, Scope.Scope> =>
    Effect.map(provider.acquire("probe"), Sandbox.fileSystem)

  it.effect("serves reads and writes natively from the session", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({ files: { "/sandbox/in.txt": "from the machine" } })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          const text = yield* files.readFileString("/sandbox/in.txt")
          yield* files.writeFileString("/sandbox/out.txt", "to the machine")
          yield* files.writeFile("/sandbox/out.bin", new Uint8Array([9, 8]))
          const bytes = yield* files.readFile("/sandbox/out.bin")
          const missing = yield* Effect.flip(files.readFile("/sandbox/none"))
          return { text, bytes: Array.from(bytes), missing: platformReason(missing) }
        })
      )
      expect(outcome).toEqual({ text: "from the machine", bytes: [9, 8], missing: "NotFound" })
      expect(decoder.decode(provider.state.files.get("/sandbox/out.txt"))).toBe("to the machine")
      expect(provider.state.commands).toEqual([])
    }))

  it.effect("answers exists from the probe's exit code and surfaces probe breakage", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.includes(' /there')
            ? { exitCode: 0 }
            : command.includes(' /absent')
            ? { exitCode: 1 }
            : { exitCode: 2, stderr: "sh: test: broken" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return {
            there: yield* files.exists("/there"),
            absent: yield* files.exists("/absent"),
            broken: platformReason(yield* Effect.flip(files.exists("/broken")))
          }
        })
      )
      expect(outcome).toEqual({ there: true, absent: false, broken: "Unknown" })
      expect(provider.state.commands[0]).toBe("test -e /there")
    }))

  it.effect("derives stat from the compound probe, in every shape", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.includes(' /file ')
            ? { stdout: "File 42" }
            : command.includes(' /dir ')
            ? { stdout: "Directory 0" }
            : command.includes(' /dangling ')
            ? { stdout: "SymbolicLink 0" }
            : command.includes(' /odd ')
            ? { stdout: "Fifo 0" }
            : command.includes(' /absent')
            ? { exitCode: 9 }
            : { exitCode: 2, stderr: "stat probe broke" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          const file = yield* files.stat("/file")
          const dir = yield* files.stat("/dir")
          const dangling = yield* files.stat("/dangling")
          const odd = yield* files.stat("/odd")
          const absent = platformReason(yield* Effect.flip(files.stat("/absent")))
          const broken = platformReason(yield* Effect.flip(files.stat("/broken")))
          return { file, dir, dangling, odd, absent, broken }
        })
      )
      expect(outcome.file.type).toBe("File")
      expect(outcome.file.size).toBe(42n)
      expect(outcome.dir.type).toBe("Directory")
      expect(outcome.dangling.type).toBe("SymbolicLink")
      expect(outcome.odd.type).toBe("Unknown")
      expect(outcome.absent).toBe("NotFound")
      expect(outcome.broken).toBe("Unknown")
    }))

  it.effect("lists directories flat and recursively, tolerating outlier lines", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command.startsWith('if [ -d /tree/ ]')
            ? { stdout: command.includes("find") ? "/tree/a\n/tree/a/b.txt\n/elsewhere/x\n" : "a\nz.txt\n" }
            : command.includes(' /gone ')
            ? { exitCode: 9 }
            : { exitCode: 2, stderr: "ls: exploded" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return {
            flat: yield* files.readDirectory("/tree/"),
            deep: yield* files.readDirectory("/tree/", { recursive: true }),
            gone: platformReason(yield* Effect.flip(files.readDirectory("/gone"))),
            broken: platformReason(yield* Effect.flip(files.readDirectory("/broken")))
          }
        })
      )
      expect(outcome.flat).toEqual(["a", "z.txt"])
      expect(outcome.deep).toEqual(["/elsewhere/x", "a", "a/b.txt"])
      expect(outcome.gone).toBe("NotFound")
      expect(outcome.broken).toBe("Unknown")
    }))

  it.effect("shapes directory making, removal, and renames as their POSIX lines", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) => command.includes("refused") ? { exitCode: 1, stderr: "refused" } : { exitCode: 0 }
      })
      yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          yield* files.makeDirectory("/deep/tree", { recursive: true })
          yield* files.makeDirectory("/flat")
          yield* files.remove("/old", { recursive: true, force: true })
          yield* files.remove("/single")
          yield* files.rename("/from", "/to")
          const failed = yield* Effect.flip(files.makeDirectory("/refused"))
          const unremoved = yield* Effect.flip(files.remove("/refused"))
          const unrenamed = yield* Effect.flip(files.rename("/refused", "/nowhere"))
          expect(platformReason(failed)).toBe("Unknown")
          expect(platformReason(unremoved)).toBe("Unknown")
          expect(platformReason(unrenamed)).toBe("Unknown")
        })
      )
      expect(provider.state.commands.slice(0, 5)).toEqual([
        "mkdir -p /deep/tree",
        "mkdir /flat",
        "rm -r -f /old",
        "rm /single",
        "mv /from /to"
      ])
    }))

  it.effect("resolves real paths and link targets, refusing what the probe refuses", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: (command) =>
          command === "readlink -f /link"
            ? { stdout: "/real/target\n" }
            : command === "readlink /link"
            ? { stdout: "/real/target\n" }
            : { exitCode: 1, stderr: "readlink: no" }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return {
            real: yield* files.realPath("/link"),
            target: yield* files.readLink("/link"),
            missing: platformReason(yield* Effect.flip(files.realPath("/missing"))),
            notLink: platformReason(yield* Effect.flip(files.readLink("/plain")))
          }
        })
      )
      expect(outcome).toEqual({
        real: "/real/target",
        target: "/real/target",
        missing: "NotFound",
        notLink: "BadArgument"
      })
    }))

  it.effect("roots relative paths at the session workdir", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        workdir: "/work",
        script: (command) => command === "test -e /work/probed.txt" ? { exitCode: 0 } : { exitCode: 1 }
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          yield* files.writeFileString("rel.txt", "rooted")
          yield* files.writeFileString("./dotted.txt", "rooted too")
          return {
            probed: yield* files.exists("probed.txt"),
            written: yield* files.readFileString("rel.txt")
          }
        })
      )
      expect(outcome).toEqual({ probed: true, written: "rooted" })
      expect(provider.state.files.has("/work/rel.txt")).toBe(true)
      expect(provider.state.files.has("/work/dotted.txt")).toBe(true)
    }))

  it.effect("prefers a session's native override to the probe", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make()
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* provider.acquire("probe")
          const files = Sandbox.fileSystem({ ...session, files: { exists: () => Effect.succeed(true) } })
          return yield* files.exists("/never-probed")
        })
      )
      expect(outcome).toBe(true)
      expect(provider.state.commands).toEqual([])
    }))

  it.effect("restates a probe transport failure in the platform vocabulary", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        script: () => ({ failure: new ProviderError({ code: "timeout", message: "the machine went away" }) })
      })
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const files = yield* probeSession(provider)
          return platformReason(yield* Effect.flip(files.exists("/anywhere")))
        })
      )
      expect(outcome).toBe("TimedOut")
    }))
})

describe("Sandbox.layerHost", () => {
  it.effect("serves the spawner, the filesystem, and the path from one held machine", () =>
    Effect.gen(function*() {
      const provider = Sandbox.TestSession.make({
        files: { "/sandbox/config.json": `{"ok":true}` },
        scripts: { "uname": { stdout: "ScriptedOS\n" } }
      })
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const files = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const uname = yield* spawner.string(ChildProcess.make("uname"))
        const config = yield* files.readFileString("/sandbox/config.json")
        return { uname, config, joined: path.join("/sandbox", "config.json") }
      }).pipe(Effect.provide(Sandbox.layerHost(provider, { session: "host" })))
      expect(outcome).toEqual({
        uname: "ScriptedOS\n",
        config: `{"ok":true}`,
        joined: "/sandbox/config.json"
      })
      expect(provider.state.acquired).toEqual(["host"])
      expect(provider.state.released).toBe(1)
    }))

  it.effect("fails to build when the machine cannot be acquired", () =>
    Effect.gen(function*() {
      const refusal = new ProviderError({ code: "unavailable", message: "no capacity" })
      const provider = Sandbox.TestSession.make({ acquireFailure: refusal })
      const outcome = yield* Effect.exit(
        Effect.provide(
          Effect.asVoid(Effect.flatMap(ChildProcessSpawner, () => Effect.void)),
          Sandbox.layerHost(provider, { session: "host" })
        )
      )
      expect(Exit.isFailure(outcome)).toBe(true)
    }))
})
