/**
 * Unit coverage for the untrusted-cache boundary in the artifact store: a
 * poisoned manifest must never place bytes outside the outDir tree it is
 * materialized into, and a rebuild must heal a tampered CAS blob.
 */
import * as ChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as PackageTree from "../src/PackageTree.ts"

/** Makes one pre-digest lstat report a stale size for the growth-race test. */
const lstatSizeOverride: { path: string | undefined; size: number } = { path: undefined, size: 0 }

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    default: original,
    lstat: async (path: NodeFs.PathLike): Promise<NodeFs.Stats> => {
      const stats = await original.lstat(path)
      if (lstatSizeOverride.path === String(path)) {
        Object.defineProperty(stats, "size", { configurable: true, value: lstatSizeOverride.size })
      }
      return stats
    }
  }
})

let root: string
let outside: string

beforeEach(async () => {
  lstatSizeOverride.path = undefined
  const base = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-tree-")))
  root = NodePath.join(base, "workspace")
  outside = NodePath.join(base, "outside")
  await Fs.mkdir(root, { recursive: true })
  await Fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  lstatSizeOverride.path = undefined
  await Fs.rm(NodePath.dirname(root), { recursive: true, force: true }).catch(() => {})
})

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")

describe("resolveChangedPath", () => {
  it("admits a two-dot-prefixed child and refuses a genuine escape", () => {
    const workspace = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(root, "changed-")))
    const prefixed = NodePath.join(workspace, "..foo")
    NodeFs.mkdirSync(prefixed)
    NodeFs.writeFileSync(NodePath.join(prefixed, "file.txt"), "inside\n")
    const external = NodePath.join(root, "outside.txt")
    NodeFs.writeFileSync(external, "outside\n")

    expect(PackageTree.resolveChangedPath(workspace, "..foo/file.txt")).toBe("..foo/file.txt")
    expect(PackageTree.resolveChangedPath(workspace, NodePath.relative(workspace, external))).toBeUndefined()
  })
})

describe("decodeManifest confines every untrusted path", () => {
  it("rejects an outDir that escapes the workspace with ..", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "../victim",
      entries: [{ path: "pwned.txt", kind: "file", digest: sha256("x"), executable: false, target: "" }]
    })
    expect(decoded).toBeUndefined()
  })

  it("rejects an absolute outDir", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "/etc",
      entries: []
    })
    expect(decoded).toBeUndefined()
  })

  it("rejects a link entry whose target is absolute", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "dist",
      entries: [{ path: "a", kind: "link", digest: "", executable: false, target: "/abs/escape" }]
    })
    expect(decoded).toBeUndefined()
  })

  it("rejects a link entry whose target contains ..", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "dist",
      entries: [{ path: "a", kind: "link", digest: "", executable: false, target: "../../escape" }]
    })
    expect(decoded).toBeUndefined()
  })

  it("accepts a well-formed manifest", () => {
    const decoded = PackageTree.decodeManifest({
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest: sha256("art"), executable: false, target: "" }]
    })
    expect(decoded).toEqual({
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest: sha256("art"), executable: false, target: "" }]
    })
  })
})

describe("materializeManifest never writes through a symlink out of the tree", () => {
  it("refuses a file entry written through a symlink entry that resolves outside", async () => {
    // A poisoned manifest whose link entry resolves outside the temp tree (via
    // a `..` hop through a pre-existing escaping symlink) followed by a file
    // beneath it. The realpath confinement in materializeManifest must refuse
    // to write the file through the symlink, leaving the outside tree untouched.
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(cas, { recursive: true })
    const digest = sha256("payload")
    await Fs.writeFile(NodePath.join(cas, digest), "payload")
    // `seed` sits beside the outDir root and points at the external directory.
    // The temp tree is built as `dist`'s sibling, so a link target of `../seed`
    // resolves through it to `outside`.
    await Fs.symlink(outside, NodePath.join(root, "seed"))
    const manifest = {
      outDir: "dist",
      entries: [
        { path: "sub", kind: "link" as const, digest: "", executable: false, target: "../seed" },
        { path: "sub/b.txt", kind: "file" as const, digest, executable: false, target: "" }
      ]
    }
    let threw = false
    await PackageTree.materializeManifest(root, ".flows", manifest).catch(() => {
      threw = true
    })
    expect(threw).toBe(true)
    const escaped = await Fs.readFile(NodePath.join(outside, "b.txt"), "utf8").then(() => true, () => false)
    expect(escaped).toBe(false)
  })

  it("materializes a normal tree atomically", async () => {
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(cas, { recursive: true })
    const digest = sha256("art")
    await Fs.writeFile(NodePath.join(cas, digest), "art")
    await PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("art")
  })
})

describe("captureOutDir heals a tampered CAS blob", () => {
  it("rewrites an existing blob whose bytes no longer match its name", async () => {
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "art")
    const first = await PackageTree.captureOutDir(root, ".flows", "dist")
    const blob = NodePath.join(root, ".flows", "cas", first.entries[0]!.digest)
    // Tamper the stored blob, then re-capture the same content: the blob must be
    // rewritten to the correct bytes rather than trusted by name.
    await Fs.writeFile(blob, "tampered")
    await PackageTree.captureOutDir(root, ".flows", "dist")
    expect(await Fs.readFile(blob, "utf8")).toBe("art")
    expect(await PackageTree.verifyManifestBlobs(root, ".flows", first)).toBeUndefined()
  })
})

describe("scratchCopy keeps installed dependencies as host state", () => {
  it("links a real node_modules directory instead of copying its contents", async () => {
    await Fs.mkdir(NodePath.join(root, "node_modules", "fixture"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "node_modules", "fixture", "index.js"), "export {}")
    await Fs.writeFile(NodePath.join(root, "source.ts"), "export const source = true")
    const scratch = await PackageTree.scratchCopy(root, ".flows")
    try {
      expect((await Fs.lstat(NodePath.join(scratch, "node_modules"))).isSymbolicLink()).toBe(true)
      expect(await Fs.realpath(NodePath.join(scratch, "node_modules"))).toBe(
        await Fs.realpath(NodePath.join(root, "node_modules"))
      )
      expect(await Fs.readFile(NodePath.join(scratch, "source.ts"), "utf8")).toContain("source = true")
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })

  it("omits the roots the caller is going to clear anyway", async () => {
    await Fs.mkdir(NodePath.join(root, "out", "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "out", "nested", "stale.js"), "stale")
    await Fs.writeFile(NodePath.join(root, "kept.txt"), "kept")
    const scratch = await PackageTree.scratchCopy(root, ".flows", ["out"])
    try {
      expect(await Fs.lstat(NodePath.join(scratch, "out")).then(() => true, () => false)).toBe(false)
      expect(await Fs.readFile(NodePath.join(scratch, "kept.txt"), "utf8")).toBe("kept")
    } finally {
      await Fs.rm(scratch, { recursive: true, force: true })
    }
  })
})

describe("the write-set guard reads git honestly", () => {
  const git = (args: ReadonlyArray<string>, input?: Buffer): Buffer =>
    ChildProcess.execFileSync("git", [...args], {
      cwd: root,
      ...(input === undefined ? {} : { input }),
      encoding: "buffer",
      stdio: ["pipe", "pipe", "pipe"]
    })

  /**
   * Stages one path whose bytes are not valid UTF-8.
   *
   * The path is placed in the index rather than on disk because APFS refuses
   * a filename that is not valid UTF-8 (EILSEQ), while ext4 accepts one. Git
   * reports the staged-then-missing entry in `status` and `ls-files` either
   * way, which is the output the guard decodes.
   */
  const stageInvalidUtf8Path = (): void => {
    const blob = git(["hash-object", "-w", "--stdin"], Buffer.from("body\n")).toString("utf8").trim()
    const entry = Buffer.concat([
      Buffer.from(`100644 blob ${blob}\tbad-`),
      Buffer.from([0xff]),
      Buffer.from(".txt\0")
    ])
    const tree = git(["mktree", "-z"], entry).toString("utf8").trim()
    git(["read-tree", tree])
  }

  beforeEach(() => {
    git(["init", "--quiet", "."])
  })

  it("refuses git output that is not valid UTF-8 instead of returning a lossy decoding", async () => {
    stageInvalidUtf8Path()
    // A silent U+FFFD substitution names a path that does not exist. The guard
    // would report it out of set and then "revert" it with a `force: true`
    // removal that cannot fail, leaving the real write in the tree while the
    // node failed claiming it had been reverted.
    await expect(PackageTree.runGit(root, ["ls-files", "-z"])).rejects.toThrow(/not valid UTF-8/)
    await expect(PackageTree.snapshotTree(root, ".flows")).rejects.toThrow(/not valid UTF-8/)
  })

  it("fails the ignored-path census when git cannot answer, instead of reporting nothing ignored", async () => {
    // `listIgnored` runs once before the body and once after. Swallowing the
    // failure disarms the guard when it fails after, and makes every ignored
    // path read as newly created when it fails before, which sends each one
    // that does not match the write-set to `revertIgnored` as a created path.
    await Fs.rm(NodePath.join(root, ".git"), { recursive: true, force: true })
    await expect(PackageTree.snapshotIgnored(root, ".flows")).rejects.toThrow(/git status failed/)
  })

  it("fails the portal census when git cannot answer, instead of measuring no portals", async () => {
    await Fs.rm(NodePath.join(root, ".git"), { recursive: true, force: true })
    await expect(PackageTree.snapshotPortals(root, ".flows")).rejects.toThrow(/git (ls-files|status) failed/)
  })
})

describe("treeMatchesManifest compares the tree, not just the manifest", () => {
  const capture = async (): Promise<PackageTree.OutDirManifest> => {
    await Fs.mkdir(NodePath.join(root, "dist", "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "art")
    await Fs.writeFile(NodePath.join(root, "dist", "nested", "b.txt"), "deep")
    return PackageTree.captureOutDir(root, ".flows", "dist")
  }

  it("matches the tree it captured", async () => {
    const manifest = await capture()
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBeUndefined()
  })

  it("matches nested directories created by materializeManifest", async () => {
    const manifest = await capture()
    await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
    await PackageTree.materializeManifest(root, ".flows", manifest)
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBeUndefined()
  })

  /**
   * `PackageExec` skips materialization entirely when this answers undefined,
   * so anything it cannot see survives a cache hit into the declared output
   * tree. Iterating only the manifest's own entries left a stale artifact from
   * a previous build in place forever.
   */
  it("reports a file on disk that the manifest does not name", async () => {
    const manifest = await capture()
    await Fs.writeFile(NodePath.join(root, "dist", "nested", "stale.txt"), "left over")
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(/nested\/stale\.txt is not in the captured/)
  })

  it("reports a symlink on disk that the manifest does not name", async () => {
    const manifest = await capture()
    await Fs.symlink("a.txt", NodePath.join(root, "dist", "alias"))
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(/dist\/alias is not in the captured/)
  })

  it("reports an extra empty directory", async () => {
    const manifest = await capture()
    await Fs.mkdir(NodePath.join(root, "dist", "empty"))
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe(
      "dist/empty is not in the captured tree"
    )
  })

  it("reports an extra empty nested directory", async () => {
    const manifest = await capture()
    await Fs.mkdir(NodePath.join(root, "dist", "nested", "empty", "deeper"), { recursive: true })
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toBe(
      "dist/nested/empty is not in the captured tree"
    )
  })

  /** Capture records the executable bit; the comparison used to ignore it. */
  it("reports executable-bit drift", async () => {
    const manifest = await capture()
    await Fs.chmod(NodePath.join(root, "dist", "a.txt"), 0o755)
    expect(await PackageTree.treeMatchesManifest(root, manifest)).toMatch(
      /dist\/a\.txt does not match the captured mode/
    )
  })
})

describe("output capture refuses a symlinked parent", () => {
  it("refuses an outFile whose parent leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "host bytes")
    await expect(PackageTree.captureFile(root, ".flows", "link/secret.txt"))
      .rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
  })

  it("refuses an outDir whose parent leaves the workspace", async () => {
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await Fs.mkdir(NodePath.join(outside, "dist"), { recursive: true })
    await expect(PackageTree.captureOutDir(root, ".flows", "link/dist"))
      .rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
  })

  it("refuses to restore a file through a symlinked parent", async () => {
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(cas, { recursive: true })
    const digest = sha256("restored")
    await Fs.writeFile(NodePath.join(cas, digest), "restored")
    await Fs.writeFile(NodePath.join(outside, "keep.txt"), "untouched")
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await expect(
      PackageTree.materializeFile(root, ".flows", { path: "link/new/a.txt", digest, executable: false })
    ).rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
    expect(await Fs.readdir(outside)).toEqual(["keep.txt"])
  })

  it("refuses to restore a manifest before creating a temp tree through a symlinked parent", async () => {
    await Fs.writeFile(NodePath.join(outside, "keep.txt"), "untouched")
    await Fs.symlink(outside, NodePath.join(root, "link"))
    await expect(
      PackageTree.materializeManifest(root, ".flows", { outDir: "link/dist", entries: [] })
    ).rejects.toThrow(/resolves outside the workspace through a symlinked parent/)
    const externalEntries = await Fs.readdir(outside)
    expect(externalEntries).toEqual(["keep.txt"])
    expect(externalEntries.filter((name) => name.startsWith(".smthrs-mat-"))).toEqual([])
  })
})

describe("captureFile heals a tampered CAS blob", () => {
  /**
   * `captureOutDir` verified an existing blob's bytes; `captureFile` trusted
   * the name, so a poisoned blob was re-admitted by every rebuild and every
   * restore kept refusing with `cas blob tampered`.
   */
  it("rewrites an existing blob whose bytes no longer match its name", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "art")
    const first = await PackageTree.captureFile(root, ".flows", "out.txt")
    const blob = NodePath.join(root, ".flows", "cas", first.digest)
    await Fs.writeFile(blob, "tampered")
    await PackageTree.captureFile(root, ".flows", "out.txt")
    expect(await Fs.readFile(blob, "utf8")).toBe("art")
    expect(await PackageTree.verifyFileManifest(root, ".flows", first)).toBeUndefined()
  })

  it("refuses a declared output file the target never created", async () => {
    await expect(PackageTree.captureFile(root, ".flows", "never-written.txt"))
      .rejects.toThrow(/declared output file was not created: never-written.txt/)
  })

  it("reports a missing and a tampered CAS blob against the same manifest", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "art")
    const manifest = await PackageTree.captureFile(root, ".flows", "out.txt")
    const blob = NodePath.join(root, ".flows", "cas", manifest.digest)
    await Fs.writeFile(blob, "tampered")
    expect(await PackageTree.verifyFileManifest(root, ".flows", manifest))
      .toBe("cas blob tampered for out.txt")
    await Fs.rm(blob)
    expect(await PackageTree.verifyFileManifest(root, ".flows", manifest))
      .toBe("cas blob missing for out.txt")
  })
})

describe("captureOutDir bounds the tree it walks", () => {
  it("refuses a tree deeper than the declared depth limit", async () => {
    const segments = Array.from({ length: PackageTree.outDirLimits.depth + 2 }, (_, index) => `d${index}`)
    await Fs.mkdir(NodePath.join(root, "dist", ...segments), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", ...segments, "leaf.txt"), "deep")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist")).rejects.toThrow(/crosses the depth limit/)
  })

  it("captures a tree exactly at the depth limit", async () => {
    const segments = Array.from({ length: PackageTree.outDirLimits.depth }, (_, index) => `d${index}`)
    await Fs.mkdir(NodePath.join(root, "dist", ...segments), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", ...segments, "leaf.txt"), "deep")
    const manifest = await PackageTree.captureOutDir(root, ".flows", "dist")
    expect(manifest.entries).toHaveLength(1)
  })

  it("accepts the entries boundary and refuses one entry over it", async () => {
    const limits = { ...PackageTree.outDirLimits, entries: 2 }
    await Fs.mkdir(NodePath.join(root, "dist", "nested"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "nested", "a"), "a")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).resolves.toMatchObject({
      entries: [{ path: "nested/a" }]
    })

    await Fs.writeFile(NodePath.join(root, "dist", "z"), "z")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).rejects.toMatchObject({
      limit: "entries"
    })
  })

  it("accepts the pathBytes boundary and refuses one byte over it", async () => {
    const limits = { ...PackageTree.outDirLimits, pathBytes: 5 }
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "abcde"), "exact")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).resolves.toBeDefined()

    await Fs.writeFile(NodePath.join(root, "dist", "abcdef"), "over")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, limits)).rejects.toMatchObject({
      limit: "pathBytes"
    })
  })

  it("accepts the manifestBytes boundary and refuses one byte over it", async () => {
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a.txt"), "x")
    const expectedEntry: PackageTree.ManifestEntry = {
      path: "a.txt",
      kind: "file",
      digest: sha256("x"),
      executable: false,
      target: ""
    }
    const encodedSize = Buffer.byteLength(JSON.stringify([expectedEntry]), "utf8")
    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
      ...PackageTree.outDirLimits,
      manifestBytes: encodedSize
    })).resolves.toEqual({ outDir: "dist", entries: [expectedEntry] })

    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
      ...PackageTree.outDirLimits,
      manifestBytes: encodedSize - 1
    })).rejects.toMatchObject({ limit: "manifestBytes" })
  })

  it("does not publish a blob when a later entry crosses a limit", async () => {
    const cas = NodePath.join(root, ".flows", "cas")
    await Fs.mkdir(NodePath.join(root, "dist"), { recursive: true })
    await Fs.mkdir(cas, { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "a"), "first")
    await Fs.writeFile(NodePath.join(root, "dist", "b"), "second")

    await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
      ...PackageTree.outDirLimits,
      entries: 1
    })).rejects.toMatchObject({ limit: "entries" })
    expect(await Fs.readdir(cas)).toEqual([])
  })

  it("enforces file and total byte limits against the bytes the digest consumed", async () => {
    const file = NodePath.join(root, "dist", "growing.txt")
    await Fs.mkdir(NodePath.dirname(file), { recursive: true })
    await Fs.writeFile(file, "12")
    lstatSizeOverride.path = file
    lstatSizeOverride.size = 0
    try {
      await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
        ...PackageTree.outDirLimits,
        fileBytes: 1
      })).rejects.toMatchObject({ limit: "fileBytes" })
      await expect(PackageTree.captureOutDir(root, ".flows", "dist", root, {
        ...PackageTree.outDirLimits,
        fileBytes: 2,
        totalBytes: 1
      })).rejects.toMatchObject({ limit: "totalBytes" })
    } finally {
      lstatSizeOverride.path = undefined
    }
  })
})

describe("the portal census refuses what it cannot measure", () => {
  const git = (...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd: root, stdio: "ignore" })
  }

  /**
   * `snapshotPortals` used to catch every failure of the portal walk — the
   * documented over-`portalEntryCap` case, but also a permission error or a
   * directory racing the census — report it through a log line, and run the
   * target anyway with the write-set guard silently disarmed over that portal.
   */
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the census when an escaping portal's target cannot be read",
    async () => {
      git("init", "--quiet", ".")
      await Fs.mkdir(NodePath.join(outside, "sealed"), { recursive: true })
      await Fs.writeFile(NodePath.join(outside, "sealed", "a.txt"), "x")
      await Fs.symlink(NodePath.join(outside, "sealed"), NodePath.join(root, "portal"))
      await Fs.chmod(NodePath.join(outside, "sealed"), 0o000)
      try {
        const censused = await PackageTree.snapshotPortals(root, ".flows").then(
          () => undefined,
          (cause: unknown) => cause
        )
        expect(censused).toBeInstanceOf(PackageTree.PortalCensusError)
        expect((censused as PackageTree.PortalCensusError).link).toBe("portal")
        expect((censused as PackageTree.PortalCensusError).reason).toBe("unreadable")
      } finally {
        await Fs.chmod(NodePath.join(outside, "sealed"), 0o755)
      }
    }
  )

  it("censuses and reverts a file created through a dangling escaping symlink", async () => {
    git("init", "--quiet", ".")
    const escapedTarget = NodePath.join(outside, "created.txt")
    await Fs.symlink(escapedTarget, NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals).toHaveLength(1)
      expect(snapshot.portals[0]).toMatchObject({ link: "portal", realTarget: escapedTarget })
      expect([...snapshot.portals[0]!.states]).toEqual([])
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual([])

      await Fs.writeFile(NodePath.join(root, "portal"), "escaped")
      expect(await PackageTree.revertChangedPortals(snapshot)).toEqual(["portal"])
      expect(await Fs.lstat(escapedTarget).then(() => true, () => false)).toBe(false)
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("leaves a dangling symlink to an in-workspace destination to the git guard", async () => {
    git("init", "--quiet", ".")
    await Fs.symlink("created.txt", NodePath.join(root, "inside"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals).toEqual([])
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })

  it("measures a readable escaping portal", async () => {
    git("init", "--quiet", ".")
    await Fs.mkdir(NodePath.join(outside, "open"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "open", "a.txt"), "x")
    await Fs.symlink(NodePath.join(outside, "open"), NodePath.join(root, "portal"))
    const snapshot = await PackageTree.snapshotPortals(root, ".flows")
    try {
      expect(snapshot.portals.map((portal) => portal.link)).toEqual(["portal"])
    } finally {
      await PackageTree.releasePortals(snapshot)
    }
  })
})

describe("the ignored guard restores what a body changed", () => {
  const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
    ChildProcess.execFileSync("git", [...args], { cwd, stdio: "ignore" })
  }
  const ignoring = async (patterns: string): Promise<void> => {
    git(root, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(root, ".gitignore"), patterns)
  }
  const exists = (path: string): Promise<boolean> => Fs.lstat(path).then(() => true, () => false)
  const refusal = (limits?: PackageTree.IgnoredLimits): Promise<unknown> =>
    PackageTree.snapshotIgnored(root, ".flows", limits).then(
      (snapshot) => PackageTree.releaseIgnored(snapshot).then(() => undefined),
      (cause: unknown) => cause
    )

  /**
   * The guard used to record an ignored path's identity and no bytes, so the
   * only revert it had was removal: a tool that overwrote `.env` out of set
   * had the user's `.env` deleted for it.
   */
  it("restores an overwritten pre-existing ignored file with its bytes and mode", async () => {
    await ignoring(".env\n")
    const env = NodePath.join(root, ".env")
    await Fs.writeFile(env, "secret")
    await Fs.chmod(env, 0o600)
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(env, "leaked bytes")
      await Fs.chmod(env, 0o644)
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual([".env"])
      expect(await PackageTree.revertIgnored(snapshot, ".env")).toBe(true)
      expect(await Fs.readFile(env, "utf8")).toBe("secret")
      expect((await Fs.lstat(env)).mode & 0o777).toBe(0o600)
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
    expect(await exists(snapshot.stashDirectory)).toBe(false)
  })

  it("restores a deleted ignored file and removes a created one", async () => {
    await ignoring("dist/\n")
    await Fs.mkdir(NodePath.join(root, "dist", "sub"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "dist", "sub", "a.js"), "old")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "dist"), { recursive: true, force: true })
      await Fs.mkdir(NodePath.join(root, "dist"))
      await Fs.writeFile(NodePath.join(root, "dist", "b.js"), "new")
      const changed = await PackageTree.changedIgnored(snapshot, ".flows")
      expect(changed).toEqual(["dist/b.js", "dist/sub/a.js"])
      for (const path of changed) expect(await PackageTree.revertIgnored(snapshot, path)).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "dist", "sub", "a.js"), "utf8")).toBe("old")
      expect(await exists(NodePath.join(root, "dist", "b.js"))).toBe(false)
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("restores a replaced ignored symlink to its target", async () => {
    await ignoring("alias\n")
    await Fs.symlink("dist", NodePath.join(root, "alias"))
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.rm(NodePath.join(root, "alias"))
      await Fs.writeFile(NodePath.join(root, "alias"), "not a link")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["alias"])
      expect(await PackageTree.revertIgnored(snapshot, "alias")).toBe(true)
      expect(await Fs.readlink(NodePath.join(root, "alias"))).toBe("dist")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("does not count a path that merely stopped being ignored", async () => {
    await ignoring("keep.txt\n")
    await Fs.writeFile(NodePath.join(root, "keep.txt"), "kept")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(NodePath.join(root, ".gitignore"), "")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual([])
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * Git never enters a nested repository, so the census sees only its
   * directory and the stash holds none of its contents. The old revert removed
   * the whole directory; the honest answer is to name it and leave it.
   */
  it("names a nested repository it cannot restore and leaves it in place", async () => {
    await ignoring("vendor/\n")
    const nested = NodePath.join(root, "vendor", "nested")
    await Fs.mkdir(nested, { recursive: true })
    git(nested, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(nested, "x.txt"), "x")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(NodePath.join(nested, "y.txt"), "y")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["vendor/nested"])
      expect(await PackageTree.revertIgnored(snapshot, "vendor/nested")).toBe(false)
      expect(await Fs.readFile(NodePath.join(nested, "x.txt"), "utf8")).toBe("x")
      expect(await Fs.readFile(NodePath.join(nested, "y.txt"), "utf8")).toBe("y")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * A tool that removed a nested repository's `.git` makes git list the files
   * it used to hide. They read as created, and removing them would be the
   * same loss; a path under a directory the census never entered is left.
   */
  it("leaves the files a tool surfaced by un-initializing a nested repository", async () => {
    await ignoring("vendor/\n")
    const nested = NodePath.join(root, "vendor", "nested")
    await Fs.mkdir(nested, { recursive: true })
    git(nested, "init", "--quiet", ".")
    await Fs.writeFile(NodePath.join(nested, "x.txt"), "x")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.rm(NodePath.join(nested, ".git"), { recursive: true, force: true })
      const changed = await PackageTree.changedIgnored(snapshot, ".flows")
      expect(changed).toEqual(["vendor/nested", "vendor/nested/x.txt"])
      for (const path of changed) expect(await PackageTree.revertIgnored(snapshot, path)).toBe(false)
      expect(await Fs.readFile(NodePath.join(nested, "x.txt"), "utf8")).toBe("x")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  /**
   * The tool ran `git init` inside `dist`, so a directory git will not enter
   * now stands where the census saw files. Those files are still the user's;
   * the guard leaves the directory rather than removing it.
   */
  it("leaves a directory git stopped entering during the body", async () => {
    await ignoring("dist/\n")
    await Fs.mkdir(NodePath.join(root, "dist"))
    await Fs.writeFile(NodePath.join(root, "dist", "a.js"), "old")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      git(NodePath.join(root, "dist"), "init", "--quiet", ".")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["dist"])
      expect(await PackageTree.revertIgnored(snapshot, "dist")).toBe(false)
      expect(await Fs.readFile(NodePath.join(root, "dist", "a.js"), "utf8")).toBe("old")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("counts a path that stopped being ignored only when it also changed", async () => {
    await ignoring("keep.txt\n")
    await Fs.writeFile(NodePath.join(root, "keep.txt"), "kept")
    const snapshot = await PackageTree.snapshotIgnored(root, ".flows")
    try {
      await Fs.writeFile(NodePath.join(root, ".gitignore"), "")
      await Fs.writeFile(NodePath.join(root, "keep.txt"), "rewritten")
      expect(await PackageTree.changedIgnored(snapshot, ".flows")).toEqual(["keep.txt"])
      expect(await PackageTree.revertIgnored(snapshot, "keep.txt")).toBe(true)
      expect(await Fs.readFile(NodePath.join(root, "keep.txt"), "utf8")).toBe("kept")
    } finally {
      await PackageTree.releaseIgnored(snapshot)
    }
  })

  it("refuses a census over the entry ceiling", async () => {
    await ignoring("*.log\n")
    await Fs.writeFile(NodePath.join(root, "a.log"), "a")
    await Fs.writeFile(NodePath.join(root, "b.log"), "b")
    const refused = await refusal({ ...PackageTree.ignoredLimits, entries: 1 })
    expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
    expect((refused as PackageTree.IgnoredCensusError).reason).toBe("entries")
  })

  it("refuses a census whose stash would cross the byte ceiling, and stashes one under it", async () => {
    await ignoring("*.bin\n")
    await Fs.writeFile(NodePath.join(root, "a.bin"), "ab")
    expect(await refusal({ ...PackageTree.ignoredLimits, totalBytes: 2 })).toBeUndefined()
    await Fs.writeFile(NodePath.join(root, "b.bin"), "c")
    const refused = await refusal({ ...PackageTree.ignoredLimits, totalBytes: 2 })
    expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
    expect((refused as PackageTree.IgnoredCensusError).reason).toBe("totalBytes")
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a census with an ignored file it cannot read",
    async () => {
      await ignoring("sealed.txt\n")
      const sealed = NodePath.join(root, "sealed.txt")
      await Fs.writeFile(sealed, "x")
      await Fs.chmod(sealed, 0o000)
      try {
        const refused = await refusal()
        expect(refused).toBeInstanceOf(PackageTree.IgnoredCensusError)
        expect((refused as PackageTree.IgnoredCensusError).reason).toBe("unreadable")
        expect((refused as PackageTree.IgnoredCensusError).path).toBe("sealed.txt")
      } finally {
        await Fs.chmod(sealed, 0o644)
      }
    }
  )
})
