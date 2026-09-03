import * as FileSet from "@smthrs/plan/FileSet"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

const glob: FileSet.Glob = { _tag: "Glob", include: ["src/**/*.ts"], exclude: ["src/**/skip.ts"] }
const tree: FileSet.TreeArtifact = { _tag: "TreeArtifact", path: "dist" }

describe("FileSet", () => {
  it("validates workspace-relative patterns", () => {
    expect(Schema.is(FileSet.Pattern)("src/**/*.ts")).toBe(true)
    expect(Schema.is(FileSet.Pattern)("/absolute/**")).toBe(false)
    expect(Schema.is(FileSet.Pattern)("src/../secret")).toBe(false)
  })

  it("constructs and expands named groups deterministically", () => {
    const group = FileSet.makeFilegroup("sources", ["a.ts", glob, tree])
    expect(FileSet.expand(["first", group])).toEqual(["first", "a.ts", glob, tree])
    expect(FileSet.expandReads(["first", { _tag: "Filegroup", name: "reads", entries: ["a.ts", glob] }]))
      .toEqual(["first", "a.ts", glob])
    expect(Schema.is(FileSet.Filegroup)(group)).toBe(true)
    expect(Schema.is(FileSet.ReadFilegroup)({ _tag: "Filegroup", name: "r", entries: [tree] })).toBe(false)
  })

  it("recognizes declarations without shape-sniffing strings", () => {
    expect(FileSet.isGlob(glob)).toBe(true)
    expect(FileSet.isGlob(tree)).toBe(false)
    expect(FileSet.isGlob(null)).toBe(false)
    expect(FileSet.isTreeArtifact(tree)).toBe(true)
    expect(FileSet.isTreeArtifact(glob)).toBe(false)
    expect(FileSet.isTreeArtifact("dist")).toBe(false)
  })

  it("implements segment-local star, recursive doublestar, and exclusions", () => {
    expect(FileSet.matchesPattern("src/*.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/*.ts", "src/deep/a.ts")).toBe(false)
    expect(FileSet.matchesPattern("src/**/a.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**/a.ts", "src/deep/more/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src/**", "src/deep/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("src\\*.ts", "src/a.ts")).toBe(true)
    expect(FileSet.matchesPattern("a+[x].ts", "a+[x].ts")).toBe(true)
    expect(FileSet.matchesGlob(glob, "src/a.ts")).toBe(true)
    expect(FileSet.matchesGlob(glob, "src/deep/skip.ts")).toBe(false)
    expect(FileSet.matchesGlob({ _tag: "Glob", include: ["*.ts"] }, "a.ts")).toBe(true)
  })

  it("compares exact paths in canonical separator form", () => {
    // `workspaceRelative` accepts a backslash as a separator, so the two
    // spellings below name one workspace path and must overlap.
    expect(FileSet.canonical("dist\\same.js")).toBe("dist/same.js")
    expect(FileSet.overlaps("dist\\same.js", "dist/same.js")).toBe(true)
    expect(FileSet.overlaps("dist/same.js", "dist\\same.js")).toBe(true)
    expect(FileSet.overlaps("dist\\other.js", "dist/same.js")).toBe(false)
    expect(FileSet.overlaps({ _tag: "TreeArtifact", path: "dist\\nested" }, "dist/nested/a.js")).toBe(true)
    expect(FileSet.overlaps("dist\\same.js", { _tag: "Glob", include: ["dist/*.js"] })).toBe(true)
    expect(FileSet.overlaps({ _tag: "Glob", include: ["dist/*.js"] }, "dist\\same.js")).toBe(true)
    expect(FileSet.overlaps(
      { _tag: "TreeArtifact", path: "dist" },
      { _tag: "TreeArtifact", path: "dist\\nested" }
    )).toBe(true)
  })

  it("compares canonically equivalent Unicode spellings as one path", () => {
    const nfc = "caf\u00e9.txt"
    const nfd = nfc.normalize("NFD")
    const glob: FileSet.Glob = { _tag: "Glob", include: ["caf\u00e9.*"] }

    expect(FileSet.canonical(nfd)).toBe(nfc)
    expect(FileSet.overlaps(nfc, nfd)).toBe(true)
    expect(FileSet.overlaps(nfd, nfc)).toBe(true)
    expect(FileSet.overlaps(glob, nfd)).toBe(true)
    expect(FileSet.overlaps(nfd, glob)).toBe(true)
  })

  it("uses the conservative overlap matrix", () => {
    const all: FileSet.Glob = { _tag: "Glob", include: ["**/*.ts"] }
    expect(FileSet.overlaps("a", "a")).toBe(true)
    expect(FileSet.overlaps("a", "b")).toBe(false)
    expect(FileSet.overlaps("src/a.ts", glob)).toBe(true)
    expect(FileSet.overlaps(glob, "src/a.ts")).toBe(true)
    expect(FileSet.overlaps(glob, all)).toBe(true)
    expect(FileSet.overlaps(tree, "dist/a.js")).toBe(true)
    expect(FileSet.overlaps("dist/a.js", tree)).toBe(true)
    expect(FileSet.overlaps(tree, { _tag: "TreeArtifact", path: "dist/nested" })).toBe(true)
    expect(FileSet.overlaps(tree, { _tag: "TreeArtifact", path: "other" })).toBe(false)
    expect(FileSet.overlaps(tree, glob)).toBe(true)
    expect(FileSet.overlaps(glob, tree)).toBe(true)
  })
})

describe("FileSet.workspaceRelative", () => {
  it("admits ordinary relative paths and patterns", () => {
    for (const path of ["a.txt", "src/deep/b.ts", "src/**/*.ts", ".env", "a*b/c", "caf\u00e9.txt", "a\u0080b"]) {
      expect(FileSet.workspaceRelative(path)).toBe(true)
    }
  })

  it("refuses C0 controls and DEL", () => {
    for (const path of ["a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(FileSet.workspaceRelative(path)).toBe(false)
    }
  })

  it("refuses absolute, upward, and aliasing spellings", () => {
    // Aliasing forms matter as much as escapes: `./a.txt` and `a.txt` name
    // one file with two spellings, which defeats exact-string overlap.
    for (const path of ["/abs", "../up", "a/../b", "./a.txt", "a//b", "a/", "C:/win"]) {
      expect(FileSet.workspaceRelative(path)).toBe(false)
    }
  })

  it("is the Pattern schema's own filter", () => {
    expect(Schema.decodeUnknownResult(FileSet.Pattern)("./aliased.txt")._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(FileSet.Entry)("../escape")._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(FileSet.ReadEntry)("/absolute")._tag).toBe("Failure")
    for (const path of ["a\u0000b", "a\u001fb", "a\u007fb"]) {
      expect(Schema.decodeUnknownResult(FileSet.Pattern)(path)._tag).toBe("Failure")
    }
    expect(Schema.decodeUnknownResult(FileSet.Entry)("src/ok.ts")._tag).toBe("Success")
  })
})
