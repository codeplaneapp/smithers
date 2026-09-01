import { describe, expect, it } from "@effect/vitest"
import type * as FileSet from "@smthrs/plan/FileSet"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as FileEnumeration from "../src/internal/FileEnumeration.ts"

const fixture = () => {
  const directories = new Map<string, ReadonlyArray<string>>([
    [".", ["root.json", "root.txt", "src"]],
    ["src", ["link", "node_modules", "visible.json"]],
    ["src/node_modules", ["hidden.json"]]
  ])
  const files = new Set(["root.json", "root.txt", "src/visible.json", "src/node_modules/hidden.json"])
  const reads: Array<string> = []
  const stats: Array<string> = []
  const descendants = (directory: string): ReadonlyArray<string> => {
    const prefix = directory === "." ? "" : `${directory}/`
    return [...directories.keys(), ...files]
      .filter((path) => path !== "." && path !== directory && path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
  }
  const fs = FileSystem.makeNoop({
    exists: ((path: string) => Effect.succeed(path === "." || directories.has(path) || files.has(path))) as never,
    readDirectory: ((path: string, options?: { readonly recursive?: boolean }) =>
      Effect.sync(() => {
        reads.push(path)
        return options?.recursive === true ? descendants(path) : [...directories.get(path) ?? []]
      })) as never,
    stat: ((path: string) =>
      Effect.sync(() => {
        stats.push(path)
        return { type: path === "src/link" ? "SymbolicLink" : files.has(path) ? "File" : "Directory", size: 0n }
      })) as never
  })
  return { fs, reads, stats }
}

describe("FileEnumeration", () => {
  it.effect("skips ignored directories unless the static prefix names one", () =>
    Effect.gen(function*() {
      const host = fixture()
      const rootGlob: FileSet.Glob = { _tag: "Glob", include: ["**/*.json"] }
      const explicitGlob: FileSet.Glob = {
        _tag: "Glob",
        include: ["src/node_modules/**/*.json"]
      }

      expect(yield* FileEnumeration.expandGlob(host.fs, rootGlob)).toEqual([
        "root.json",
        "src/visible.json"
      ])
      expect(host.reads).not.toContain("src/node_modules")
      expect(host.stats).not.toContain("src/node_modules/hidden.json")

      expect(yield* FileEnumeration.expandGlob(host.fs, explicitGlob)).toEqual([
        "src/node_modules/hidden.json"
      ])
    }))

  it.effect("fails typed when a walk exceeds maxEntries", () =>
    Effect.gen(function*() {
      const host = fixture()
      const glob: FileSet.Glob = { _tag: "Glob", include: ["**"] }
      const exit = yield* Effect.exit(FileEnumeration.expandGlob(host.fs, glob, { maxEntries: 2 }))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(FileEnumeration.FileEnumerationError)
      expect(error).toMatchObject({
        code: "entry_limit_exceeded",
        pattern: "**",
        limit: 2
      })
    }))

  it.effect("enumerates direct subtrees, tolerates absence, and deduplicates shared prefixes", () =>
    Effect.gen(function*() {
      const host = fixture()
      const resolve = (path: string): string => path === "" ? "." : path

      expect(yield* FileEnumeration.filesUnder(host.fs, "src", { resolve })).toEqual([
        "src/visible.json"
      ])
      expect(yield* FileEnumeration.filesUnder(host.fs, "")).toEqual([
        "root.json",
        "root.txt",
        "src/visible.json"
      ])
      expect(yield* FileEnumeration.entriesUnder(host.fs, "src", { resolve })).toEqual({
        files: ["src/visible.json"],
        directories: ["src"]
      })
      expect(yield* FileEnumeration.entriesUnder(host.fs, "src")).toEqual({
        files: ["src/visible.json"],
        directories: ["src"]
      })
      expect(yield* FileEnumeration.filesUnder(host.fs, "missing")).toEqual([])

      const glob: FileSet.Glob = {
        _tag: "Glob",
        include: ["src/*.json", "src/**/*.json"]
      }
      expect(yield* FileEnumeration.expandGlob(host.fs, glob)).toEqual(["src/visible.json"])
    }))
})
