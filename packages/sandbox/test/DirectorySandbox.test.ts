import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, PlatformError, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"

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
  it.effect("passes the sandbox conformance suite against real directories and processes", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const violations = yield* SandboxConformance.check(directory, {
        provides: { kill: true, ping: true }
      })
      expect(violations).toEqual([])
    }), budget)

  it.effect("serves the whole probe dialect against a real tree when native overrides are stripped", () =>
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
        })
      )
    }), budget)

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

  it.effect("runs commands in the session workdir with the caller's environment and real signals", () =>
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
        })
      )
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
