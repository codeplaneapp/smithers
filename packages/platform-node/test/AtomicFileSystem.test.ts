// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { afterEach, describe, expect, it } from "@effect/vitest"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Fiber, FileSystem, Layer, Path } from "effect"
import { execFile } from "node:child_process"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const directories = new Set<string>()

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "flows-node-atomic-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const guarded = (root: string, host: Layer.Layer<FileSystem.FileSystem> = AtomicFileSystem.layer) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(host),
    Layer.provide(Path.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

const swappingHost = (swap: () => Promise<void>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const atomic = (fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
      let swapped = false
      return KernelFileSystem.withAtomicFileSystem(fileSystem, {
        execute: <A>(request: KernelFileSystem.AtomicRequest) =>
          Effect.promise(async () => {
            if (!swapped) {
              swapped = true
              await swap()
            }
          }).pipe(Effect.andThen(atomic.execute<A>(request)))
      })
    })
  ).pipe(Layer.provide(AtomicFileSystem.layer))

const run = <A, E>(root: string, effect: Effect.Effect<A, E, FileSystem.FileSystem>, host = AtomicFileSystem.layer) =>
  effect.pipe(Effect.provide(guarded(root, host)))

describe("Node atomic filesystem", () => {
  it.live("executes every descriptor-relative operation without path re-resolution", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const nested = join(root, "nested")
          const text = join(nested, "text.txt")
          const bytes = join(nested, "bytes.bin")
          const link = join(root, "text-link")
          const renamed = join(nested, "renamed.txt")
          yield* fs.makeDirectory(nested, { recursive: true })
          yield* fs.writeFileString(text, "hello")
          yield* fs.writeFile(bytes, new Uint8Array([1, 2, 3]))
          const textValue = yield* fs.readFileString(text)
          const bytesValue = yield* fs.readFile(bytes)
          const present = yield* fs.exists(text)
          const absent = yield* fs.exists(join(root, "missing.txt"))
          yield* Effect.promise(() => symlink("nested/text.txt", link))
          const linkTarget = yield* fs.readLink(link)
          yield* Effect.promise(() => rm(link))
          const real = yield* fs.realPath(text)
          const info = yield* fs.stat(text)
          const entries = yield* fs.readDirectory(root, { recursive: true })
          const matches = yield* fs.glob("**/*.txt", { root })
          yield* fs.rename(text, renamed)
          yield* fs.remove(nested, { recursive: true })
          return { absent, bytesValue: [...bytesValue], entries, info, linkTarget, matches, present, real, textValue }
        })
      )

      expect(outcome).toMatchObject({
        absent: false,
        bytesValue: [1, 2, 3],
        linkTarget: "nested/text.txt",
        present: true,
        textValue: "hello"
      })
      expect(outcome.real).toMatch(/nested\/text\.txt$/)
      expect(outcome.info.type).toBe("File")
      expect(outcome.entries).toContain("nested/text.txt")
      expect(outcome.matches).toEqual([join(root, "nested/text.txt")])
    }), 30_000)

  it.live(
    "rejects every operation when an intermediate component is swapped after authorization",
    () =>
      Effect.gen(function*() {
        const operations = [
          (fs: FileSystem.FileSystem, path: string, root: string) => fs.readFile(path),
          (fs: FileSystem.FileSystem, path: string) => fs.writeFile(path, new Uint8Array([9])),
          (fs: FileSystem.FileSystem, path: string) => fs.writeFileString(path, "escaped"),
          (fs: FileSystem.FileSystem, path: string) => fs.makeDirectory(join(path, "child")),
          (fs: FileSystem.FileSystem, path: string) => fs.remove(path),
          (fs: FileSystem.FileSystem, path: string, root: string) => fs.rename(path, join(root, "renamed.txt")),
          (fs: FileSystem.FileSystem, _path: string, _root: string, gate: string) => fs.readDirectory(gate),
          (fs: FileSystem.FileSystem, path: string) => fs.stat(path)
        ] as const

        for (const operation of operations) {
          const directory = yield* Effect.promise(() => temporaryDirectory())
          const root = join(directory, "workspace")
          const outside = join(directory, "outside")
          const gate = join(root, "gate")
          const parked = join(root, "parked")
          const target = join(gate, "victim.txt")
          const outsideVictim = join(outside, "victim.txt")
          yield* Effect.promise(() => mkdir(gate, { recursive: true }))
          yield* Effect.promise(() => mkdir(outside))
          yield* Effect.promise(() => writeFile(target, "inside"))
          yield* Effect.promise(() => writeFile(outsideVictim, "outside"))
          const result = yield* run(
            root,
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              return yield* Effect.result(operation(fs, target, root, gate))
            }),
            swappingHost(async () => {
              await rename(gate, parked)
              await symlink(outside, gate)
            })
          )
          expect(result._tag).toBe("Failure")
          expect(yield* Effect.promise(() => readFile(outsideVictim, "utf8"))).toBe("outside")
        }
      }),
    30_000
  )

  /**
   * Listing is the one family that must not simply fail: it resolves nothing,
   * so the property to pin is that no path behind the planted link is ever
   * reported, not that the call errors.
   */
  it.live("reports nothing behind an intermediate component swapped to an outside directory", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      const gate = join(root, "gate")
      const parked = join(root, "parked")
      yield* Effect.promise(() => mkdir(gate, { recursive: true }))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(join(gate, "victim.txt"), "inside"))
      yield* Effect.promise(() => writeFile(join(outside, "victim.txt"), "outside"))

      const result = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            listing: yield* Effect.result(fs.readDirectory(gate)),
            rootedGlob: yield* Effect.result(fs.glob("**", { root: gate })),
            matched: yield* fs.glob("gate/**", { root }),
            everything: yield* fs.readDirectory(root, { recursive: true })
          }
        }),
        swappingHost(async () => {
          await rename(gate, parked)
          await symlink(outside, gate)
        })
      )

      // Opening the swapped directory itself still fails closed, whether it is
      // named as the listing target or as a glob root.
      expect(result.listing._tag).toBe("Failure")
      expect(result.rootedGlob._tag).toBe("Failure")
      expect(result.matched).toEqual([])
      expect(result.everything).toContain("gate")
      expect(result.everything.some((entry) => entry.startsWith("gate/"))).toBe(false)
      expect(yield* Effect.promise(() => readFile(join(outside, "victim.txt"), "utf8"))).toBe("outside")
    }))

  it.live("rejects final-component swaps for file, directory, and rename sources", () =>
    Effect.gen(function*() {
      const operations = [
        (fs: FileSystem.FileSystem, path: string, root: string) => fs.readFile(path),
        (fs: FileSystem.FileSystem, path: string) => fs.writeFile(path, new Uint8Array([9])),
        (fs: FileSystem.FileSystem, path: string) => fs.writeFileString(path, "escaped"),
        (fs: FileSystem.FileSystem, path: string) => fs.remove(path),
        (fs: FileSystem.FileSystem, path: string, root: string) => fs.rename(path, join(root, "renamed.txt")),
        (fs: FileSystem.FileSystem, path: string) => fs.stat(path)
      ] as const

      for (const operation of operations) {
        const directory = yield* Effect.promise(() => temporaryDirectory())
        const root = join(directory, "workspace")
        const outside = join(directory, "outside")
        const target = join(root, "target.txt")
        const parked = join(root, "parked.txt")
        const outsideVictim = join(outside, "victim.txt")
        yield* Effect.promise(() => mkdir(root))
        yield* Effect.promise(() => mkdir(outside))
        yield* Effect.promise(() => writeFile(target, "inside"))
        yield* Effect.promise(() => writeFile(outsideVictim, "outside"))
        const result = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return yield* Effect.result(operation(fs, target, root))
          }),
          swappingHost(async () => {
            await rename(target, parked)
            await symlink(outsideVictim, target)
          })
        )
        expect(result._tag).toBe("Failure")
        expect(yield* Effect.promise(() => readFile(outsideVictim, "utf8"))).toBe("outside")
      }

      const directory = yield* Effect.promise(() => temporaryDirectory())
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(root, "new-directory")
      yield* Effect.promise(() => mkdir(root))
      yield* Effect.promise(() => mkdir(outside))
      const result = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.makeDirectory(target))),
        swappingHost(() => symlink(outside, target))
      )
      expect(result._tag).toBe("Failure")

      const container = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(container, "workspace")
      const outsideDirectory = join(container, "outside")
      const directoryTarget = join(workspace, "target")
      const parked = join(workspace, "parked")
      yield* Effect.promise(() => mkdir(directoryTarget, { recursive: true }))
      yield* Effect.promise(() => mkdir(outsideDirectory))
      yield* Effect.promise(() => writeFile(join(outsideDirectory, "victim.txt"), "outside"))
      const directoryResult = yield* run(
        workspace,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.readDirectory(directoryTarget))),
        swappingHost(async () => {
          await rename(directoryTarget, parked)
          await symlink(outsideDirectory, directoryTarget)
        })
      )
      expect(directoryResult._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(join(outsideDirectory, "victim.txt"), "utf8"))).toBe("outside")

      const renameContainer = yield* Effect.promise(() => temporaryDirectory())
      const renameWorkspace = join(renameContainer, "workspace")
      const renameOutside = join(renameContainer, "outside")
      const source = join(renameWorkspace, "source.txt")
      const destination = join(renameWorkspace, "destination.txt")
      const renameVictim = join(renameOutside, "victim.txt")
      yield* Effect.promise(() => mkdir(renameWorkspace))
      yield* Effect.promise(() => mkdir(renameOutside))
      yield* Effect.promise(() => writeFile(source, "inside"))
      yield* Effect.promise(() => writeFile(renameVictim, "outside"))
      const renameResult = yield* run(
        renameWorkspace,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.rename(source, destination))),
        swappingHost(() => symlink(renameVictim, destination))
      )
      expect(renameResult._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(renameVictim, "utf8"))).toBe("outside")

      const hardLinkContainer = yield* Effect.promise(() => temporaryDirectory())
      const hardLinkWorkspace = join(hardLinkContainer, "workspace")
      const hardLinkOutside = join(hardLinkContainer, "outside")
      const hardLinkTarget = join(hardLinkWorkspace, "target.txt")
      const hardLinkParked = join(hardLinkWorkspace, "parked.txt")
      const hardLinkVictim = join(hardLinkOutside, "victim.txt")
      yield* Effect.promise(() => mkdir(hardLinkWorkspace))
      yield* Effect.promise(() => mkdir(hardLinkOutside))
      yield* Effect.promise(() => writeFile(hardLinkTarget, "inside"))
      yield* Effect.promise(() => writeFile(hardLinkVictim, "outside"))
      const hardLinkResult = yield* run(
        hardLinkWorkspace,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.writeFileString(hardLinkTarget, "escaped"))),
        swappingHost(async () => {
          await rename(hardLinkTarget, hardLinkParked)
          await link(hardLinkVictim, hardLinkTarget)
        })
      )
      expect(hardLinkResult._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(hardLinkVictim, "utf8"))).toBe("outside")
    }))

  it.live("names symlink entries when listing without ever descending through one", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      yield* Effect.promise(() => mkdir(join(root, "real"), { recursive: true }))
      yield* Effect.promise(() => mkdir(join(outside, "hidden"), { recursive: true }))
      yield* Effect.promise(() => writeFile(join(root, "real", "kept.txt"), "inside"))
      yield* Effect.promise(() => writeFile(join(outside, "hidden", "secret.txt"), "outside"))
      // A link to a directory outside the root, and a link to a file inside it.
      yield* Effect.promise(() => symlink(outside, join(root, "escape")))
      yield* Effect.promise(() => symlink(join(root, "real", "kept.txt"), join(root, "alias.txt")))

      const listed = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            entries: yield* fs.readDirectory(root, { recursive: true }),
            shallow: yield* fs.readDirectory(root),
            matches: yield* fs.glob("**/*.txt", { root })
          }
        })
      )

      // The links are reported by name — a listing resolves nothing.
      expect(listed.shallow).toEqual(["alias.txt", "escape", "real"])
      expect(listed.entries).toContain("escape")
      expect(listed.entries).toContain("real/kept.txt")
      // ...and nothing behind either link is ever reached.
      expect(listed.entries.some((entry) => entry.startsWith("escape/"))).toBe(false)
      expect(listed.matches).toEqual([join(root, "alias.txt"), join(root, "real/kept.txt")])
    }))

  it.live("surfaces helper rejection as a typed platform failure", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const failure = yield* run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt"))))
      )
      expect(failure).toMatchObject({ reason: { _tag: "NotFound" } })
    }))

  /**
   * The interpreter is configuration, not discovery, so every unusable helper
   * is reached through the layer seam rather than by editing `PATH`.
   * `AtomicFileSystemHelper.test.ts` pins the identity and framing cases; this
   * one only pins that an unusable helper never degrades into a path-based
   * call.
   */
  it.live("fails closed when the configured helper is absent or exits unsuccessfully", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const bin = join(yield* Effect.promise(() => temporaryDirectory()), "bin")
      yield* Effect.promise(() => mkdir(bin))
      const executable = join(bin, "python3")
      const attempt = run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt")))),
        AtomicFileSystem.layerWith({ executable })
      )

      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })

      yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\necho helper-failed >&2\nexit 7\n"))
      yield* Effect.promise(() => chmod(executable, 0o755))
      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })

      yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\nexit 7\n"))
      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })

      yield* Effect.promise(() => writeFile(executable, "#!/bin/sh\nprintf '{\"ok\":false}\\n'\n"))
      expect(yield* attempt).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    }))

  it.live("addresses the workspace root itself instead of rejecting an empty component list", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      yield* Effect.promise(() => mkdir(join(root, "kept")))
      yield* Effect.promise(() => writeFile(join(root, "kept", "file.txt"), "inside"))
      const canonical = yield* Effect.promise(() => realpath(root))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            // `join(root, ".")` normalizes to the root, so the same request
            // reaches the helper however the caller spelled it.
            dotted: yield* fs.exists(join(root, ".")),
            entries: yield* fs.readDirectory(root),
            existing: yield* fs.exists(root),
            info: yield* fs.stat(root),
            matches: yield* fs.glob("**/*.txt", { root }),
            real: yield* fs.realPath(root),
            recursiveDirectory: yield* Effect.result(fs.makeDirectory(root, { recursive: true })),
            // Everything below has to stay refused: it would either destroy or
            // move the pinned root, or read it as something it is not.
            directory: yield* Effect.flip(fs.makeDirectory(root)),
            link: yield* Effect.flip(fs.readLink(root)),
            read: yield* Effect.flip(fs.readFile(root)),
            removal: yield* Effect.flip(fs.remove(root, { recursive: true })),
            renamedAway: yield* Effect.flip(fs.rename(root, join(root, "moved"))),
            renamedOnto: yield* Effect.flip(fs.rename(join(root, "kept"), root)),
            write: yield* Effect.flip(fs.writeFileString(root, "clobbered"))
          }
        })
      )

      expect(outcome.existing).toBe(true)
      expect(outcome.dotted).toBe(true)
      expect(outcome.info.type).toBe("Directory")
      expect(outcome.entries).toEqual(["kept"])
      expect(outcome.matches).toEqual([join(root, "kept/file.txt")])
      expect(outcome.real).toBe(canonical)
      expect(outcome.recursiveDirectory._tag).toBe("Success")
      expect(outcome.directory).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      expect(outcome.read).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.write).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.removal).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.renamedAway).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.renamedOnto).toMatchObject({ reason: { _tag: "PermissionDenied" } })
      expect(outcome.link.reason._tag).toBe("Unknown")
      // The refused operations left the root and its contents untouched.
      expect(yield* Effect.promise(() => readFile(join(root, "kept", "file.txt"), "utf8"))).toBe("inside")
    }))

  it.live("only lets a recursive makeDirectory succeed over a real directory", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const outside = join(yield* Effect.promise(() => temporaryDirectory()), "outside")
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(join(outside, "victim.txt"), "outside"))
      yield* Effect.promise(() => mkdir(join(root, "directory")))
      yield* Effect.promise(() => writeFile(join(root, "file.txt"), "regular"))
      yield* Effect.promise(() => symlink(outside, join(root, "escape")))
      yield* Effect.promise(() => symlink(join(root, "directory"), join(root, "alias")))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            alias: yield* Effect.flip(fs.makeDirectory(join(root, "alias"), { recursive: true })),
            directory: yield* Effect.result(fs.makeDirectory(join(root, "directory"), { recursive: true })),
            escape: yield* Effect.flip(fs.makeDirectory(join(root, "escape"), { recursive: true })),
            file: yield* Effect.flip(fs.makeDirectory(join(root, "file.txt"), { recursive: true })),
            nestedUnderFile: yield* Effect.flip(
              fs.makeDirectory(join(root, "file.txt", "child"), { recursive: true })
            )
          }
        })
      )

      expect(outcome.directory._tag).toBe("Success")
      // An existing regular file is not a directory, so `recursive` cannot
      // absorb its EEXIST.
      expect(outcome.file).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      // A symlink is refused even when it points at a directory, inside or out.
      expect(outcome.escape).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.alias).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(outcome.nestedUnderFile).toMatchObject({ reason: { _tag: "BadResource" } })
      expect(yield* Effect.promise(() => readFile(join(root, "file.txt"), "utf8"))).toBe("regular")
      expect(yield* Effect.promise(() => readFile(join(outside, "victim.txt"), "utf8"))).toBe("outside")
      expect(yield* Effect.promise(() => readFile(join(root, "escape", "victim.txt"), "utf8"))).toBe("outside")
    }))

  it.live("implements every OpenFlag exactly as the native Node filesystem does", () =>
    Effect.gen(function*() {
      const flags: ReadonlyArray<FileSystem.OpenFlag> = [
        "r",
        "r+",
        "w",
        "wx",
        "w+",
        "wx+",
        "a",
        "ax",
        "a+",
        "ax+"
      ]
      const outcome = (
        execute: (
          root: string,
          effect: Effect.Effect<boolean, never, FileSystem.FileSystem>
        ) => Effect.Effect<boolean, unknown>,
        flag: FileSystem.OpenFlag,
        seeded: boolean
      ) =>
        Effect.gen(function*() {
          const root = yield* Effect.promise(() => temporaryDirectory())
          const target = join(root, "target.txt")
          if (seeded) yield* Effect.promise(() => writeFile(target, "seed"))
          const failed = yield* execute(
            root,
            Effect.flatMap(FileSystem.FileSystem, (fs) =>
              Effect.match(fs.writeFileString(target, "ab", { flag }), {
                onFailure: () => true,
                onSuccess: () => false
              }))
          )
          const content = yield* Effect.promise(() => readFile(target, "utf8").catch(() => null))
          return { content, failed, flag, seeded }
        })
      const table = (
        execute: (
          root: string,
          effect: Effect.Effect<boolean, never, FileSystem.FileSystem>
        ) => Effect.Effect<boolean, unknown>
      ) =>
        Effect.forEach(
          flags.flatMap((flag) => [true, false].map((seeded) => ({ flag, seeded }))),
          ({ flag, seeded }) => outcome(execute, flag, seeded)
        )

      const atomic = yield* table((root, effect) => run(root, effect))
      const native = yield* table((_root, effect) => effect.pipe(Effect.provide(NodeFileSystem.layer)))
      expect(atomic).toEqual(native)

      const entry = (flag: FileSystem.OpenFlag, seeded: boolean) =>
        atomic.find((row) => row.flag === flag && row.seeded === seeded)
      // A read-only flag never writes, and never creates the file either.
      expect(entry("r", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("r", false)).toMatchObject({ content: null, failed: true })
      // `r+` requires the file and overwrites in place without truncating.
      expect(entry("r+", true)).toMatchObject({ content: "abed", failed: false })
      expect(entry("r+", false)).toMatchObject({ content: null, failed: true })
      // `w`/`w+` create and truncate; `wx`/`wx+` are exclusive.
      expect(entry("w", true)).toMatchObject({ content: "ab", failed: false })
      expect(entry("w+", true)).toMatchObject({ content: "ab", failed: false })
      expect(entry("wx", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("wx+", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("wx", false)).toMatchObject({ content: "ab", failed: false })
      // The append family never truncates, and the exclusive variants still
      // refuse an existing file.
      expect(entry("a", true)).toMatchObject({ content: "seedab", failed: false })
      expect(entry("a+", true)).toMatchObject({ content: "seedab", failed: false })
      expect(entry("a", false)).toMatchObject({ content: "ab", failed: false })
      expect(entry("ax", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("ax+", true)).toMatchObject({ content: "seed", failed: true })
      expect(entry("ax+", false)).toMatchObject({ content: "ab", failed: false })
    }), 30_000)

  /**
   * The helper cannot call Node's globber, so it translates the pattern into a
   * regular expression itself. That translation is only correct if it agrees
   * with the globber it replaces, exclusions included, so it is compared
   * against it rather than against a hand-written expectation.
   */
  it.live("selects and excludes the same paths the native globber does", () =>
    Effect.gen(function*() {
      const patterns: ReadonlyArray<readonly [string, ReadonlyArray<string> | undefined]> = [
        ["*.txt", undefined],
        ["**/*.txt", undefined],
        ["nested/*", undefined],
        ["**/*.txt", ["nested/**"]],
        ["**/*.txt", ["**/deep/**"]],
        ["nested/*", ["*.log"]],
        ["nested/*", ["nested/*.log"]],
        ["nested/?id.txt", undefined],
        ["**/*.[tl]??", undefined],
        ["**/*.[!l]??", undefined],
        ["**/*.txt", ["**"]]
      ]
      const seed = async () => {
        const root = await temporaryDirectory()
        await mkdir(join(root, "nested", "deep"), { recursive: true })
        await writeFile(join(root, "top.txt"), "")
        await writeFile(join(root, "nested", "mid.txt"), "")
        await writeFile(join(root, "nested", "deep", "low.txt"), "")
        await writeFile(join(root, "nested", "skip.log"), "")
        return root
      }
      const matches = (
        execute: (
          root: string,
          effect: Effect.Effect<Array<string>, never, FileSystem.FileSystem>
        ) => Effect.Effect<Array<string>, unknown>
      ) =>
        Effect.gen(function*() {
          const root = yield* Effect.promise(() => seed())
          const rows: Array<string> = []
          for (const [pattern, exclude] of patterns) {
            const found = yield* execute(
              root,
              Effect.flatMap(
                FileSystem.FileSystem,
                (fs) => Effect.orDie(fs.glob(join(root, pattern), exclude === undefined ? { root } : { exclude, root }))
              )
            )
            rows.push(
              `${pattern} !${exclude?.join(",") ?? ""} -> ${found.map((v) => relative(root, v)).sort().join(" ")}`
            )
          }
          return rows
        })

      expect(yield* matches((root, effect) => run(root, effect))).toEqual(
        yield* matches((_root, effect) => effect.pipe(Effect.provide(NodeFileSystem.layer)))
      )
    }))

  it.live("classifies flag, encoding, and errno failures the way the native filesystem does", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "seed"))
      yield* Effect.promise(() => mkdir(join(root, "occupied")))
      yield* Effect.promise(() => writeFile(join(root, "occupied", "child.txt"), "child"))
      yield* Effect.promise(() => writeFile(join(root, "empty.txt"), ""))

      const outcome = yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return {
            bytes: yield* fs.readFile(join(root, "empty.txt")),
            empty: yield* fs.readFileString(join(root, "empty.txt")),
            encoding: yield* Effect.flip(fs.readFileString(target, "not-an-encoding")),
            exclusive: yield* Effect.flip(fs.writeFileString(target, "ab", { flag: "wx" })),
            flag: yield* Effect.flip(
              fs.writeFileString(target, "ab", { flag: "nonsense" as FileSystem.OpenFlag })
            ),
            listedFile: yield* Effect.flip(fs.readDirectory(target)),
            missing: yield* Effect.flip(fs.writeFileString(join(root, "missing.txt"), "ab", { flag: "r+" })),
            notEmpty: yield* Effect.flip(fs.remove(join(root, "occupied")))
          }
        })
      )

      // An empty file decodes to an empty string, not to the helper's envelope.
      expect(outcome.empty).toBe("")
      expect([...outcome.bytes]).toEqual([])
      expect(outcome.encoding.reason).toMatchObject({
        _tag: "BadArgument",
        description: "invalid encoding",
        method: "readFileString",
        module: "FileSystem"
      })
      expect(outcome.flag.reason._tag).toBe("BadArgument")
      expect(outcome.exclusive).toMatchObject({ reason: { _tag: "AlreadyExists" } })
      expect(outcome.missing).toMatchObject({ reason: { _tag: "NotFound" } })
      expect(outcome.listedFile).toMatchObject({ reason: { _tag: "BadResource" } })
      // ENOTEMPTY has no normalized reason in Effect's own Node adapter either.
      expect(outcome.notEmpty.reason._tag).toBe("Unknown")
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("seed")
    }))

  /**
   * A named pipe used to read as a successful, EMPTY regular file, and a
   * write-only open of one parked the helper inside `open()` until a reader
   * arrived. `AtomicFileSystemHelper.test.ts` pins the whole special-file
   * family; this case stays here because it is the one an ordinary workspace
   * writer can plant, and it must terminate.
   */
  it.live(
    "refuses a named pipe planted inside the workspace instead of waiting or reporting empty",
    () =>
      Effect.gen(function*() {
        const flags: ReadonlyArray<FileSystem.OpenFlag> = ["w", "a", "r+", "w+", "a+"]
        const root = yield* Effect.promise(() => temporaryDirectory())
        const pipe = join(root, "pipe")
        // The adapter already requires python3, so this needs no new dependency.
        yield* Effect.promise(() =>
          promisify(execFile)(AtomicFileSystem.defaultExecutable, [
            "-I",
            "-c",
            "import os, sys; os.mkfifo(sys.argv[1])",
            pipe
          ])
        )

        const outcome = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return {
              existing: yield* fs.exists(pipe),
              info: yield* fs.stat(pipe),
              read: yield* Effect.flip(fs.readFile(pipe)),
              writes: yield* Effect.forEach(flags, (flag) =>
                Effect.map(
                  Effect.result(fs.writeFileString(pipe, "escaped", { flag })),
                  (result) => `${flag}:${result._tag}`
                )),
              // The exclusive flags refuse the existing entry before opening it.
              exclusive: yield* Effect.flip(fs.writeFileString(pipe, "escaped", { flag: "wx" }))
            }
          })
        )

        expect(outcome.existing).toBe(true)
        expect(outcome.info.type).toBe("FIFO")
        // An empty read would be indistinguishable from an empty file.
        expect(outcome.read).toMatchObject({ reason: { _tag: "PermissionDenied" } })
        expect(outcome.writes).toEqual(["w:Failure", "a:Failure", "r+:Failure", "w+:Failure", "a+:Failure"])
        expect(outcome.exclusive).toMatchObject({ reason: { _tag: "AlreadyExists" } })
        // Nothing replaced or truncated the pipe on the way through.
        const info = yield* Effect.promise(() => lstat(pipe))
        expect(info.isFIFO()).toBe(true)
      }),
    30_000
  )

  /**
   * `python3 -c` prepends the current working directory to `sys.path`, and the
   * cwd of a harness process is normally the very workspace this adapter
   * confines. A module planted there — or on `PYTHONPATH` — used to be
   * imported and executed inside the helper, which holds the pinned root
   * descriptor, so writing one file into the workspace bought arbitrary code
   * on the trusted side of the boundary. The proof is a planted `base64.py`
   * that both records that it ran and corrupts the read it takes part in.
   */
  it.live("never imports a module planted in the working directory or on PYTHONPATH", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))

      const plant = async (marker: string) => {
        const directory = await temporaryDirectory()
        await writeFile(
          join(directory, "base64.py"),
          `open(${JSON.stringify(marker)}, "w").write("executed")\n` +
            `def b64encode(data): return b"UFdORUQ="\n` +
            `def b64decode(data): return b"PWNED"\n`
        )
        return directory
      }
      const workingDirectoryMarker = join(yield* Effect.promise(() => temporaryDirectory()), "cwd-executed")
      const environmentMarker = join(yield* Effect.promise(() => temporaryDirectory()), "env-executed")
      const workingDirectory = yield* Effect.promise(() => plant(workingDirectoryMarker))
      const environmentDirectory = yield* Effect.promise(() => plant(environmentMarker))

      const originalCwd = process.cwd()
      const originalPythonPath = process.env.PYTHONPATH
      let bytes: Uint8Array
      try {
        process.chdir(workingDirectory)
        process.env.PYTHONPATH = environmentDirectory
        bytes = yield* run(
          root,
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(target))
        )
      } finally {
        process.chdir(originalCwd)
        if (originalPythonPath === undefined) delete process.env.PYTHONPATH
        else process.env.PYTHONPATH = originalPythonPath
      }

      // The real stdlib encoder ran, so the caller sees the real file...
      expect(new TextDecoder().decode(bytes)).toBe("inside")
      // ...and neither planted module was ever imported, so neither ran at all.
      expect(yield* Effect.promise(() => readFile(workingDirectoryMarker, "utf8").catch(() => null))).toBe(null)
      expect(yield* Effect.promise(() => readFile(environmentMarker, "utf8").catch(() => null))).toBe(null)
    }))

  /**
   * The request, the response, and the bytes the syscalls receive are all
   * UTF-8, whatever locale the host was started under. Decoding the request
   * with the ambient locale used to address a DIFFERENT file for any
   * non-ASCII path and to write mojibake for any non-ASCII payload — and to
   * report success for both.
   */
  it.live("addresses non-ASCII paths and payloads identically under a legacy locale", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const name = "ラン.txt"
      const target = join(root, name)
      const content = "héllo — ✓"
      const overrides = { LANG: "en_US.ISO8859-1", LC_ALL: "en_US.ISO8859-1", PYTHONIOENCODING: "latin-1" }
      const original = Object.fromEntries(
        Object.keys(overrides).map((key) => [key, process.env[key]])
      )

      let outcome: { readonly entries: Array<string>; readonly text: string }
      try {
        Object.assign(process.env, overrides)
        outcome = yield* run(
          root,
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            yield* fs.writeFileString(target, content)
            return {
              entries: yield* fs.readDirectory(root),
              text: yield* fs.readFileString(target)
            }
          })
        )
      } finally {
        for (const [key, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }

      expect(outcome.text).toBe(content)
      expect(outcome.entries).toEqual([name])
      // The bytes on disk are the ones the caller asked for, at the name the
      // caller asked for — read back outside the adapter entirely.
      expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe(content)
    }))

  it.live("kills an in-flight helper when the Effect is interrupted", () =>
    Effect.gen(function*() {
      const root = yield* Effect.promise(() => temporaryDirectory())
      const target = join(root, "target.txt")
      yield* Effect.promise(() => writeFile(target, "inside"))
      const bin = join(yield* Effect.promise(() => temporaryDirectory()), "bin")
      yield* Effect.promise(() => mkdir(bin))
      const executable = join(bin, "python3")
      yield* Effect.promise(() =>
        writeFile(
          executable,
          `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 10000)'\n`
        )
      )
      yield* Effect.promise(() => chmod(executable, 0o755))
      yield* run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const fiber = yield* fs.readFile(target).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep("20 millis")
          yield* Fiber.interrupt(fiber)
        }),
        AtomicFileSystem.layerWith({ executable })
      )
    }))
})
