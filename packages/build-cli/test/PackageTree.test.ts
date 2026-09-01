/**
 * Unit coverage for the untrusted-cache boundary in the artifact store: a
 * poisoned manifest must never place bytes outside the outDir tree it is
 * materialized into, and a rebuild must heal a tampered CAS blob.
 */
import * as ChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as PackageTree from "../src/PackageTree.ts"

let root: string
let outside: string

beforeEach(async () => {
  const base = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-tree-")))
  root = NodePath.join(base, "workspace")
  outside = NodePath.join(base, "outside")
  await Fs.mkdir(root, { recursive: true })
  await Fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  await Fs.rm(NodePath.dirname(root), { recursive: true, force: true }).catch(() => {})
})

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")

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
    // that does not match the write-set to a recursive removal.
    await Fs.rm(NodePath.join(root, ".git"), { recursive: true, force: true })
    await expect(PackageTree.snapshotIgnored(root, ".flows")).rejects.toThrow(/git status failed/)
  })

  it("fails the portal census when git cannot answer, instead of measuring no portals", async () => {
    await Fs.rm(NodePath.join(root, ".git"), { recursive: true, force: true })
    await expect(PackageTree.snapshotPortals(root, ".flows")).rejects.toThrow(/git (ls-files|status) failed/)
  })
})
