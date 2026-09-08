import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as OverlayExec from "../src/OverlayExec.ts"
import * as PackageTree from "../src/PackageTree.ts"

let base: string
let root: string
let scratch: string | undefined

beforeEach(async () => {
  base = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-overlay-")))
  root = NodePath.join(base, "workspace")
  await Fs.mkdir(root)
  await Fs.writeFile(NodePath.join(root, "original.txt"), "original")
  await Fs.writeFile(NodePath.join(root, "replacement.txt"), "replacement")
})

afterEach(async () => {
  if (scratch !== undefined) await Fs.rm(scratch, { recursive: true, force: true })
  scratch = undefined
  await Fs.rm(base, { recursive: true, force: true })
})

const replacement = (path: string, source = "replacement.txt"): OverlayExec.Replacement => ({
  overlay: "//:overlay",
  path,
  source,
  digest: "unused-by-apply"
})

describe("apply", () => {
  it("refuses an absolute link back into the original workspace that the portal census excludes", async () => {
    ChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: root })
    await Fs.symlink(NodePath.join(root, "original.txt"), NodePath.join(root, "destination.txt"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals).toEqual([])
      scratch = await PackageTree.scratchCopy(root, ".flows")
      const refusal = await OverlayExec.apply(scratch, [replacement("destination.txt")]).catch((cause: unknown) =>
        cause
      )
      // Check durable bytes before any rollback: the census cannot restore this link.
      expect(await Fs.readFile(NodePath.join(root, "original.txt"), "utf8")).toBe("original")
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual([])
      expect(refusal).toBeInstanceOf(Error)
      expect(String(refusal)).toMatch(/Overlay destination.*workspace/)
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("refuses a symlinked parent before creating directories outside scratch", async () => {
    await Fs.symlink(base, NodePath.join(root, "portal"))
    await expect(OverlayExec.apply(root, [replacement("portal/new/destination.txt")])).rejects.toThrow(
      /Overlay destination/
    )
    await expect(Fs.lstat(NodePath.join(base, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("replaces an internal final symlink without changing its target", async () => {
    await Fs.symlink("original.txt", NodePath.join(root, "destination.txt"))
    await OverlayExec.apply(root, [replacement("destination.txt")])
    expect(await Fs.readFile(NodePath.join(root, "original.txt"), "utf8")).toBe("original")
    expect((await Fs.lstat(NodePath.join(root, "destination.txt"))).isSymbolicLink()).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "destination.txt"), "utf8")).toBe("replacement")
  })

  it.each(["destination.txt", "portal/new/destination.txt"])("refuses a dangling link at %s", async (path) => {
    const target = NodePath.join(base, "missing")
    await Fs.symlink(target, NodePath.join(root, path.split("/")[0]!))
    await expect(OverlayExec.apply(root, [replacement(path)])).rejects.toThrow(/Overlay destination/)
    await expect(Fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses an internal directory link without changing its target", async () => {
    await Fs.mkdir(NodePath.join(root, "directory"))
    await Fs.symlink("directory", NodePath.join(root, "alias"))
    await expect(OverlayExec.apply(root, [replacement("alias/destination.txt")])).rejects.toThrow(
      /Overlay destination directory/
    )
    expect(await Fs.readdir(NodePath.join(root, "directory"))).toEqual([])
  })

  it("refuses an escaping replacement source before creating its destination", async () => {
    await Fs.writeFile(NodePath.join(base, "outside.txt"), "outside")
    await Fs.symlink(NodePath.join(base, "outside.txt"), NodePath.join(root, "source.txt"))
    await expect(OverlayExec.apply(root, [replacement("new/destination.txt", "source.txt")])).rejects.toThrow(
      /Overlay source/
    )
    await expect(Fs.lstat(NodePath.join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["source", "destination"])("refuses a lexical %s escape", async (side) => {
    await Fs.writeFile(NodePath.join(base, "outside.txt"), "outside")
    const entry = side === "source"
      ? replacement("destination.txt", "../outside.txt")
      : replacement("../outside.txt")
    await expect(OverlayExec.apply(root, [entry])).rejects.toThrow(/Overlay .*outside/)
    expect(await Fs.readFile(NodePath.join(base, "outside.txt"), "utf8")).toBe("outside")
  })

  it("refuses a source behind an escaping parent", async () => {
    await Fs.symlink(base, NodePath.join(root, "portal"))
    await Fs.writeFile(NodePath.join(base, "outside.txt"), "outside")
    await expect(OverlayExec.apply(root, [replacement("new/destination.txt", "portal/outside.txt")])).rejects.toThrow(
      /Overlay source/
    )
    await expect(Fs.lstat(NodePath.join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a missing source before creating destination directories", async () => {
    await expect(OverlayExec.apply(root, [replacement("new/destination.txt", "missing.txt")])).rejects.toThrow(
      /Overlay source is missing/
    )
    await expect(Fs.lstat(NodePath.join(root, "new"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("replaces a regular file and preserves the replacement's executable mode", async () => {
    await Fs.chmod(NodePath.join(root, "replacement.txt"), 0o755)
    await OverlayExec.apply(root, [replacement("original.txt")])
    expect(await Fs.readFile(NodePath.join(root, "original.txt"), "utf8")).toBe("replacement")
    expect((await Fs.stat(NodePath.join(root, "original.txt"))).mode & 0o777).toBe(0o755)
  })

  it("creates nested destinations and reads an internal replacement source link", async () => {
    await Fs.symlink("replacement.txt", NodePath.join(root, "source.txt"))
    await OverlayExec.apply(root, [replacement("new/nested/destination.txt", "source.txt")])
    expect(await Fs.readFile(NodePath.join(root, "new/nested/destination.txt"), "utf8")).toBe("replacement")
    expect(await Fs.readdir(NodePath.join(root, "new/nested"))).toEqual(["destination.txt"])
  })
})
