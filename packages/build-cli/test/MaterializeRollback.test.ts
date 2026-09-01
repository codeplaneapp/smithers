/**
 * The publish half of `materializeManifest` in isolation.
 *
 * The swap is two renames with nothing between them. A failure of the second
 * used to remove the temp tree, leave the declared output absent, and strand
 * the previous tree beside it as `.smthrs-old-<stamp>` — worse than either the
 * old state or the new one. Injecting the failure needs the module boundary,
 * so this file mocks `node:fs/promises` and therefore stands apart from the
 * rest of the artifact-store suite.
 */
import { createHash } from "node:crypto"
import * as RealFs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** Set to make the first rename whose destination contains this text fail once. */
const failure: { renameTo: string | undefined; code: string } = { renameTo: undefined, code: "ENOSPC" }

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    default: original,
    rename: async (from: string, to: string): Promise<void> => {
      if (failure.renameTo !== undefined && String(to).includes(failure.renameTo)) {
        // One shot: the rollback rename that follows must be allowed to run.
        const code = failure.code
        failure.renameTo = undefined
        throw Object.assign(new Error(`${code}: injected`), { code })
      }
      return original.rename(from, to)
    }
  }
})

const PackageTree = await import("../src/PackageTree.ts")

let root: string

const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex")

beforeEach(async () => {
  root = await RealFs.realpath(await RealFs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-mat-")))
  failure.renameTo = undefined
})

afterEach(async () => {
  failure.renameTo = undefined
  await RealFs.rm(root, { recursive: true, force: true }).catch(() => {})
})

const seed = async (): Promise<string> => {
  const cas = NodePath.join(root, ".flows", "cas")
  await RealFs.mkdir(cas, { recursive: true })
  const digest = sha256("next")
  await RealFs.writeFile(NodePath.join(cas, digest), "next")
  await RealFs.mkdir(NodePath.join(root, "dist"), { recursive: true })
  await RealFs.writeFile(NodePath.join(root, "dist", "previous.txt"), "previous")
  return digest
}

describe("materializeManifest publishes or restores, never neither", () => {
  it("restores the previous tree when the publish rename fails", async () => {
    const digest = await seed()
    failure.renameTo = `${NodePath.sep}dist`
    await expect(PackageTree.materializeManifest(root, ".flows", {
      outDir: "dist",
      entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
    })).rejects.toThrow(/ENOSPC/)

    expect(await RealFs.readFile(NodePath.join(root, "dist", "previous.txt"), "utf8")).toBe("previous")
    expect((await RealFs.readdir(root)).filter((name) => name.startsWith(".smthrs-old-"))).toEqual([])
    expect((await RealFs.readdir(root)).filter((name) => name.startsWith(".smthrs-mat-"))).toEqual([])
  })

  /**
   * The first rename moves the previous tree aside. Treating every error as
   * "it was not there" set `hadOld` false on a permission or I/O failure, and
   * the publish rename then failed against a directory that was still present,
   * with the real reason long since swallowed.
   */
  it("propagates a non-ENOENT failure of the set-aside rename", async () => {
    const digest = await seed()
    failure.renameTo = ".smthrs-old-"
    failure.code = "EACCES"
    try {
      await expect(PackageTree.materializeManifest(root, ".flows", {
        outDir: "dist",
        entries: [{ path: "a.txt", kind: "file", digest, executable: false, target: "" }]
      })).rejects.toThrow(/EACCES/)
    } finally {
      failure.code = "ENOSPC"
    }
    expect(await RealFs.readFile(NodePath.join(root, "dist", "previous.txt"), "utf8")).toBe("previous")
  })
})
