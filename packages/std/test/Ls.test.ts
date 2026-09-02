import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Cause, Effect, Exit, FileSystem, Layer, Option } from "effect"
import * as Path from "effect/Path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Ls from "../src/Ls.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const fileInfo = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: type === "Directory" ? 0o755 : 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none()
})

describe("Ls", () => {
  it("sorts directories first and appends their suffix", async () => {
    const result = await execute(Effect.provide(
      Ls.run({ path: "/work" }),
      layer({
        files: {
          "/work/z.txt": "z",
          "/work/a.txt": "a",
          "/work/dir/b.txt": "b",
          "/work/another/c.txt": "c"
        }
      })
    ))
    expect(result.entries).toEqual([
      { name: "another/", kind: "directory" },
      { name: "dir/", kind: "directory" },
      { name: "a.txt", kind: "file" },
      { name: "z.txt", kind: "file" }
    ])
  })

  it("sorts names by locale-independent UTF-16 code units", async () => {
    const names = [
      "a.txt",
      "A.txt",
      "_.txt",
      "!.txt",
      "é.txt",
      "é.txt",
      "😀.txt",
      "𐀀.txt",
      "z.txt",
      "Z.txt",
      "Ω.txt"
    ]
    const files = Object.fromEntries(names.map((name) => [`/work/${name}`, ""]))
    const result = await execute(Effect.provide(Ls.run({ path: "/work" }), layer({ files })))
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "!.txt",
      "A.txt",
      "Z.txt",
      "_.txt",
      "a.txt",
      "é.txt",
      "z.txt",
      "é.txt",
      "Ω.txt",
      "𐀀.txt",
      "😀.txt"
    ])
  })

  it("pages a listing and discloses remaining entries", async () => {
    const result = await execute(Effect.provide(
      Ls.run({ path: "/work", offset: 2, limit: 1 }),
      layer({
        files: { "/work/a": "", "/work/b": "", "/work/c": "" }
      })
    ))
    expect(result.entries).toEqual([{ name: "b", kind: "file" }])
    expect(result).toMatchObject({ total: 3, truncated: true })
    expect(result.notice).toBeDefined()
  })

  it("caps a listing at the entry maximum with disclosure", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_001; index++) files[`/work/${index}`] = ""
    const result = await execute(Effect.provide(Ls.run({ path: "/work", limit: 2_000 }), layer({ files })))
    expect(result.entries).toHaveLength(1_000)
    expect(result.truncated).toBe(true)
    expect(result.notice).toBeDefined()
  })

  it("stats only the selected page", async () => {
    const entryStats: Array<string> = []
    const host = FileSystem.makeNoop({
      stat: (path) => {
        if (path === "/work") return Effect.succeed(fileInfo("Directory"))
        entryStats.push(path)
        return Effect.succeed(fileInfo("File"))
      },
      readDirectory: () => Effect.succeed(["e", "d", "c", "b", "a"])
    })
    const result = await execute(Effect.provide(
      Effect.provideService(Ls.run({ path: "/work", offset: 2, limit: 2 }), FileSystem.FileSystem, host),
      layer()
    ))
    expect(result.entries).toEqual([{ name: "b", kind: "file" }, { name: "c", kind: "file" }])
    expect(entryStats).toEqual(["/work/b", "/work/c"])
  })

  it("fails with a typed not_found error for a missing directory", async () => {
    const exit = await execute(Effect.provide(Effect.exit(Ls.run({ path: "/missing" })), layer({ files: {} })))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("not_found")
    }
  })

  it("fails with not_a_directory when the path is a file", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Ls.run({ path: "/work/file.txt" })),
      layer({ files: { "/work/file.txt": "content" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error).toMatchObject({
        code: "not_a_directory",
        path: "/work/file.txt"
      })
    }
  })

  it("fails when the offset is past the last entry", async () => {
    const exit = await execute(Effect.provide(
      Effect.exit(Ls.run({ path: "/work", offset: 4 })),
      layer({ files: { "/work/a": "", "/work/b": "", "/work/c": "" } })
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error).toMatchObject({
        code: "offset_out_of_range",
        path: "/work"
      })
    }
  })

  it("answers an empty page for an empty directory rather than refusing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flows-ls-empty-"))
    try {
      const result = await execute(Effect.provide(
        Ls.run({ path: directory }),
        Layer.merge(NodeFileSystem.layer, Path.layer)
      ))
      expect(result.entries).toEqual([])
      expect(result.total).toBe(0)
      expect(result.truncated).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("declares sealed hermetic effects and narrows each invocation", () => {
    expect(Ls.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Ls.effectsFor({ path: "/a.txt" }).reads).toEqual(["/a.txt"])
  })
})
