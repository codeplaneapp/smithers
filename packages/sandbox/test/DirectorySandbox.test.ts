import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Effect, Exit, FileSystem, Layer, Option, Path, PlatformError, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import type { RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

/** Whether the host still knows the pid: `kill -0`, so a zombie counts until it is reaped. */
const processIsAlive = (pid: number): boolean => {
  try {
    globalThis.process.kill(pid, 0)
    return true
  } catch (cause) {
    return !isErrno(cause, "ESRCH")
  }
}

/**
 * Whether the pid's work has ended. A killed orphan lingers as a zombie until
 * pid 1 reaps it — longer than any polite wait on a loaded machine — and a
 * zombie's work is over, so `Z` counts as ended while a live state is a real
 * survivor.
 */
const processHasEnded = (pid: number): boolean => {
  if (!processIsAlive(pid)) return true
  const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)]).stdout?.toString().trim() ?? ""
  return state === "" || state.startsWith("Z")
}

/** Polls a host-visible condition in real time; the delay only spaces bounded retries. */
const waitFor = (condition: () => boolean, description: string, timeoutMs = 5_000): Effect.Effect<void> =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
  })

/** Whether any host process matches; the caller's bracketed pattern keeps the probe from matching itself. */
const anyProcessMatching = (pattern: string): boolean => spawnSync("pgrep", ["-f", pattern]).status === 0

const firstLine = (process: RemoteProcess): Effect.Effect<string, ProviderError> =>
  Effect.map(
    Stream.runHead(Stream.splitLines(Stream.decodeText(process.stdout))),
    (line) => Option.getOrElse(line, () => "")
  )

const stdoutOf = (process: RemoteProcess): Effect.Effect<string, ProviderError> =>
  Stream.mkString(Stream.decodeText(process.stdout))

// Real directories and real processes; the resolved root keeps macOS's
// symlinked temp tree from making `pwd` disagree with the session workdir.
const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-directory-sandbox-")))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const services = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return { fs, spawner }
}).pipe(Effect.provide(platform))

const provider = Effect.map(services, ({ fs, spawner }) => DirectorySandbox.make({ fs, spawner, root }))

// The suite spawns real `sleep` processes; a loaded machine still fits this.
const budget = 30_000

describe("DirectorySandbox", () => {
  it.effect(
    "passes the sandbox conformance suite against real directories and processes",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const violations = yield* SandboxConformance.check(directory, {
          provides: { kill: true, ping: true }
        })
        expect(violations).toEqual([])
      }),
    budget
  )

  it.effect(
    "serves the whole probe dialect against a real tree when native overrides are stripped",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("probe-dialect")
            const { fs } = yield* services
            // Stripping the native overrides forces every derived operation
            // through the POSIX probes, against the same real directory.
            const probed = Sandbox.fileSystem({ ...session, files: undefined })
            const native = Sandbox.fileSystem(session)
            const file = `${session.workdir}/notes/agenda.txt`
            yield* session.writeFile(file, new TextEncoder().encode("prepared"))
            yield* fs.symlink(file, `${session.workdir}/notes/link.txt`)

            expect(yield* probed.exists(file)).toBe(true)
            expect(yield* probed.exists(`${session.workdir}/nowhere`)).toBe(false)
            const stat = yield* probed.stat(file)
            expect(stat.type).toBe("File")
            expect(stat.size).toBe(8n)
            expect((yield* probed.stat(`${session.workdir}/notes`)).type).toBe("Directory")
            expect(yield* probed.readDirectory(`${session.workdir}/notes`)).toEqual(["agenda.txt", "link.txt"])
            expect(yield* probed.readDirectory(session.workdir, { recursive: true })).toEqual([
              "notes",
              "notes/agenda.txt",
              "notes/link.txt"
            ])
            expect(yield* probed.readLink(`${session.workdir}/notes/link.txt`)).toBe(file)
            expect(yield* probed.realPath(`${session.workdir}/notes/link.txt`)).toBe(file)
            yield* probed.makeDirectory(`${session.workdir}/build/out`, { recursive: true })
            yield* probed.rename(file, `${session.workdir}/build/out/agenda.txt`)
            yield* probed.remove(`${session.workdir}/notes`, { recursive: true, force: true })
            expect(yield* probed.exists(`${session.workdir}/notes`)).toBe(false)
            expect(yield* native.readDirectory(`${session.workdir}/build/out`)).toEqual(["agenda.txt"])
            // Relative paths are the workspace's on both the probe and the
            // native surface, never the host process's cwd.
            yield* native.writeFileString("relative.txt", "rooted")
            expect(yield* probed.readFileString("relative.txt")).toBe("rooted")
            expect(yield* native.exists("relative.txt")).toBe(true)
            expect(yield* fs.exists(`${session.workdir}/relative.txt`)).toBe(true)
            // The native overrides serve the rest of the surface with the
            // same rooting, dot prefixes included.
            expect((yield* native.stat("./relative.txt")).type).toBe("File")
            yield* native.makeDirectory("native/dir", { recursive: true })
            yield* native.rename("relative.txt", "native/dir/moved.txt")
            expect(yield* native.readDirectory(".")).toContain("native")
            expect(yield* fs.exists(`${session.workdir}/native/dir/moved.txt`)).toBe(true)
            yield* fs.symlink(`${session.workdir}/native/dir/moved.txt`, `${session.workdir}/native.link`)
            expect(yield* native.readLink("native.link")).toBe(`${session.workdir}/native/dir/moved.txt`)
            expect(yield* native.realPath("native.link")).toBe(`${session.workdir}/native/dir/moved.txt`)
            yield* native.remove("native", { recursive: true })
            expect(yield* native.exists("native")).toBe(false)
            // Against a real tree, an unforced removal of a missing path is
            // NotFound and a forced one succeeds, matching the host.
            expect(
              String(yield* Effect.flip(probed.remove("gone.txt")))
            ).toContain("NotFound")
            yield* probed.remove("gone.txt", { force: true })
          })
        )
      }),
    budget
  )

  it.effect("keeps sessions in distinct workspaces and removes them on release", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const { fs } = yield* services
      const workdirs = yield* Effect.scoped(
        Effect.gen(function*() {
          const one = yield* directory.acquire("lane/one")
          const other = yield* directory.acquire("lane-one")
          yield* one.writeFile(`${one.workdir}/proof.txt`, new TextEncoder().encode("one"))
          expect(one.workdir).not.toBe(other.workdir)
          expect(yield* fs.exists(`${other.workdir}/proof.txt`)).toBe(false)
          return [one.workdir, other.workdir]
        })
      )
      for (const workdir of workdirs) {
        expect(yield* fs.exists(workdir)).toBe(false)
      }
    }), budget)

  it.effect(
    "runs commands in the session workdir with the caller's environment and real signals",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("spawn-shape")
            const output = yield* Effect.scoped(
              Effect.flatMap(
                session.spawn(`printf '%s:%s' "$PWD" "$DIRECTORY_SANDBOX_PROOF"`, {
                  env: { DIRECTORY_SANDBOX_PROOF: "delivered" }
                }),
                (process) => Stream.mkString(Stream.decodeText(process.stdout))
              )
            )
            expect(output).toBe(`${session.workdir}:delivered`)
            const elsewhere = yield* Effect.scoped(
              Effect.flatMap(
                session.spawn("pwd", { cwd: root }),
                (process) => Stream.mkString(Stream.decodeText(process.stdout))
              )
            )
            expect(elsewhere.trim()).toBe(root)
            // The caller's variables extend the host's rather than replace
            // them, so PATH survives an override, and an `undefined` value
            // unsets an inherited variable instead of arriving as text.
            const hostPath = globalThis.process.env.PATH
            globalThis.process.env.DIRECTORY_SANDBOX_INHERITED = "kept"
            globalThis.process.env.DIRECTORY_SANDBOX_DROPPED = "inherited"
            const merged = yield* Effect.scoped(
              Effect.flatMap(
                session.spawn(
                  `printf '%s|%s|%s' "$PATH" "$DIRECTORY_SANDBOX_INHERITED" "\${DIRECTORY_SANDBOX_DROPPED-unset}"`,
                  { env: { DIRECTORY_SANDBOX_PROOF: "delivered", DIRECTORY_SANDBOX_DROPPED: undefined } }
                ),
                stdoutOf
              )
            ).pipe(Effect.ensuring(Effect.sync(() => {
              delete globalThis.process.env.DIRECTORY_SANDBOX_INHERITED
              delete globalThis.process.env.DIRECTORY_SANDBOX_DROPPED
            })))
            expect(merged).toBe(`${hostPath}|kept|unset`)
          })
        )
      }),
    budget
  )

  it.effect(
    "roots a relative cwd under the session workdir, never under the engine process's",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("relative-cwd")
            yield* session.writeFile(`${session.workdir}/sub/dir/marker`, new Uint8Array())
            const pwd = (cwd: string) =>
              Effect.map(Effect.scoped(Effect.flatMap(session.spawn("pwd", { cwd }), stdoutOf)), (out) => out.trim())
            expect(yield* pwd("sub/dir")).toBe(`${session.workdir}/sub/dir`)
            expect(yield* pwd("./sub")).toBe(`${session.workdir}/sub`)
            expect(yield* pwd(".")).toBe(session.workdir)
            expect(yield* pwd("")).toBe(session.workdir)
            expect(yield* pwd(root)).toBe(root)
          })
        )
      }),
    budget
  )

  it.effect("delivers the caller's stdin bytes as the command's whole standard input", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("stdin-bytes")
          const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 7])
          const echoed = yield* Effect.scoped(
            Effect.gen(function*() {
              const running = yield* session.spawn("cat", { stdin: bytes })
              const [chunks, code] = yield* Effect.all(
                [Stream.runCollect(running.stdout), running.exitCode],
                { concurrency: "unbounded" }
              )
              return { bytes: chunks.flatMap((chunk) => Array.from(chunk)), code }
            })
          )
          expect(echoed).toEqual({ bytes: Array.from(bytes), code: 0 })
          // An empty input is still an input: the command sees end-of-file,
          // not a pipe nobody will ever close.
          const empty = yield* Effect.scoped(
            Effect.flatMap(session.spawn("cat", { stdin: new Uint8Array() }), (running) => running.exitCode)
          )
          expect(empty).toBe(0)
        })
      )
    }), budget)

  it.effect(
    "kill ends the command and everything it started, not only the shell that wrapped it",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        // Two shapes of work that outlive a signal aimed at the shell alone: a
        // background job the shell forked, and a grandchild that moved into its
        // own process group (Node's `detached`), which a process-group signal
        // from the spawner cannot reach either. Each fixture prints the pid of
        // the process that must not survive; the durations are distinctive so
        // a stray host `sleep` cannot be mistaken for the leak — and none is
        // 3607, the duration `posixCommands.survivor` greps for, so a
        // concurrent conformance run cannot mistake these fixtures for its
        // own leak either.
        const node = CommandLine.quote(globalThis.process.execPath)
        const fixtures = [
          "sleep 3709 & echo $!; wait",
          `${node} -e 'const child = require("node:child_process").spawn("sleep", ["3611"], ` +
          `{ detached: true, stdio: "ignore" }); console.log(child.pid); setInterval(() => {}, 1e6)'`
        ]
        const started: Array<number> = []
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("kill-tree")
            for (const line of fixtures) {
              const outcome = yield* Effect.scoped(
                Effect.gen(function*() {
                  const running = yield* session.spawn(line, {})
                  const pid = Number(yield* firstLine(running))
                  started.push(pid)
                  expect(processIsAlive(pid)).toBe(true)
                  yield* session.kill!(running, "SIGTERM")
                  return { pid, exit: yield* Effect.exit(running.exitCode) }
                })
              )
              // The wrapper's end is all the conformance suite can see; the leak
              // is only visible from the host.
              expect(Exit.isSuccess(outcome.exit) && outcome.exit.value === 0).toBe(false)
              yield* waitFor(() => processHasEnded(outcome.pid), `the work under \`${line.slice(0, 16)}\` to end`)
            }
            // A pipeline is the shape that forks on every shell: no member can
            // print another's pid, so the host is asked instead, with a bracket
            // that keeps the probe's own command line out of the match.
            const piped = yield* Effect.scoped(
              Effect.gen(function*() {
                const running = yield* session.spawn("sleep 3719 | cat", {})
                yield* waitFor(() => anyProcessMatching("sleep 371[9]"), "the pipeline to start")
                yield* session.kill!(running, "SIGTERM")
                return yield* Effect.exit(running.exitCode)
              })
            )
            expect(Exit.isSuccess(piped) && piped.value === 0).toBe(false)
            yield* waitFor(() => !anyProcessMatching("sleep 371[9]"), "the pipeline's sleep to end")
          })
        ).pipe(Effect.ensuring(Effect.sync(() => {
          spawnSync("pkill", ["-TERM", "-f", "sleep 371[9]"])
          for (const pid of started) {
            try {
              globalThis.process.kill(pid, "SIGKILL")
            } catch {
              // Already gone, which is the point.
            }
          }
        })))
      }),
    budget
  )

  // Scope closure reaches only the `sh -c` wrapper the host spawner owns. A
  // shell that forked its work, as a background job or pipeline, leaves that
  // work running unless the finalizer performs the descendant walk.
  it.effect(
    "closing a spawn's scope ends everything the command started",
    () =>
      Effect.gen(function*() {
        const { fs, spawner } = yield* services
        // The Node host currently adds process-group cleanup of its own. A
        // non-detached command isolates the provider's descendant guarantee,
        // because that host fallback can reach only the wrapper process.
        const wrapperOnly = makeSpawner((command) =>
          spawner.spawn(
            command._tag === "StandardCommand"
              ? ChildProcess.make(command.command, command.args, { ...command.options, detached: false })
              : command
          )
        )
        const directory = DirectorySandbox.make({ fs, spawner: wrapperOnly, root })
        let pid: number | undefined
        yield* Effect.scoped(
          Effect.gen(function*() {
            const session = yield* directory.acquire("scope-closure")
            const started = yield* Effect.scoped(
              Effect.gen(function*() {
                const running = yield* session.spawn("sleep 3809 & echo $!; wait", {})
                const background = Number(yield* firstLine(running))
                pid = background
                expect(processIsAlive(background)).toBe(true)
                return background
              })
            )
            yield* waitFor(() => processHasEnded(started), "the work the closed scope left behind to end")
          })
        ).pipe(Effect.ensuring(Effect.sync(() => {
          spawnSync("pkill", ["-TERM", "-f", "sleep 380[9]"])
          if (pid === undefined) return
          try {
            globalThis.process.kill(pid, "SIGKILL")
          } catch {
            // Already gone, which is the point.
          }
        })))
      }),
    budget
  )

  it.effect("reports a signal it could not deliver and leaves an exited command alone", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const { fs, spawner } = yield* services
      yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("kill-edges")
          // The host's `kill` knows no BREAK and the command is still running,
          // so nothing was delivered, and the session says so.
          const refused = yield* Effect.scoped(
            Effect.gen(function*() {
              const running = yield* session.spawn("sleep 3613", {})
              const failure = yield* Effect.flip(session.kill!(running, "SIGBREAK"))
              yield* session.kill!(running, "SIGTERM")
              yield* Effect.exit(running.exitCode)
              return failure
            })
          )
          expect(refused).toBeInstanceOf(ProviderError)
          expect((refused as ProviderError).code).toBe("unknown")
          expect((refused as ProviderError).message).toContain("SIGBREAK")
          // A command that has already exited is left alone: its pid may be
          // someone else's by now, and the signal's purpose already holds.
          yield* Effect.scoped(
            Effect.gen(function*() {
              const running = yield* session.spawn("true", {})
              expect(yield* running.exitCode).toBe(0)
              yield* session.kill!(running, "SIGTERM")
            })
          )
        })
      )
      // A spawner that starts the command but not the process walk reports
      // the signal undelivered rather than delivered.
      let spawns = 0
      const walkless = makeSpawner((command) =>
        ++spawns === 2
          ? Effect.fail(
            PlatformError.badArgument({ module: "ChildProcess", method: "spawn", description: "one process only" })
          )
          : spawner.spawn(command)
      )
      const undelivered = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* DirectorySandbox.make({ fs, spawner: walkless, root }).acquire("walkless")
          const running = yield* session.spawn("sleep 3617", {})
          return yield* Effect.flip(session.kill!(running, "SIGTERM"))
        })
      )
      expect((undelivered as ProviderError).code).toBe("unknown")
      expect((undelivered as ProviderError).message).toContain("SIGTERM")
    }), budget)

  it.effect("refuses a spawn against a command that cannot start", () =>
    Effect.gen(function*() {
      const { fs } = yield* services
      const spawner = makeSpawner(() =>
        Effect.fail(
          PlatformError.badArgument({
            module: "ChildProcess",
            method: "spawn",
            description: "broken transport"
          })
        )
      )
      const directory = DirectorySandbox.make({ fs, spawner, root })
      const failure = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("broken-spawner")
          return yield* Effect.flip(Effect.scoped(Effect.asVoid(session.spawn("true", {}))))
        })
      )
      expect(failure).toBeInstanceOf(ProviderError)
      expect((failure as ProviderError).code).toBe("spawn_error")
    }), budget)

  it.effect("reports an unreadable path distinctly from an absent one", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const session = yield* directory.acquire("read-errors")
          const absent = yield* Effect.flip(session.readFile(`${session.workdir}/absent.txt`))
          // Reading a directory as a file is a real refusal, not absence.
          yield* session.writeFile(`${session.workdir}/dir/inner.txt`, new Uint8Array([1]))
          const unreadable = yield* Effect.flip(session.readFile(`${session.workdir}/dir`))
          return { absent, unreadable }
        })
      )
      expect((outcome.absent as ProviderError).code).toBe("not_found")
      expect((outcome.unreadable as ProviderError).code).toBe("unknown")
    }), budget)

  it.effect("provides the host bundle through layerHost against a real machine", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const files = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const workdir = (yield* spawner.string(ChildProcess.make("pwd", { shell: true }))).trim()
        const target = path.join(workdir, "from-tools.txt")
        yield* files.writeFileString(target, "written through the host bundle")
        const echoed = yield* spawner.string(ChildProcess.make(`cat ${target}`, { shell: true }))
        return { workdir, echoed }
      }).pipe(Effect.provide(Sandbox.layerHost(directory, { session: "host-bundle" })))
      expect(outcome.workdir.startsWith(root)).toBe(true)
      expect(outcome.echoed).toBe("written through the host bundle")
    }), budget)
})
