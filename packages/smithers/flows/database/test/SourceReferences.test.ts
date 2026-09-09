import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as ReleasePolicy from "../src/internal/ReleasePolicy.ts"

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly version: string
  readonly engines: { readonly node: string }
}

const modules = (directory: string): ReadonlyArray<string> =>
  readdirSync(join(packageRoot, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? modules(join(directory, entry.name))
      : entry.name.endsWith(".ts")
      ? [join(packageRoot, directory, entry.name)]
      : []
  )

const sources = modules("src")
const read = (file: string): string => readFileSync(file, "utf8")
const name = (file: string): string => relative(packageRoot, file)

/**
 * Prose in the source tree is a contract too: a module header is the first
 * thing a contributor reads, and the release wording is what an operator sees
 * when the driver refuses. Neither is compiled, so nothing but this file
 * notices when the file it names is deleted or the manifest moves underneath
 * it.
 */
describe("source references", () => {
  // Four headers and one test pointed into a docs/pages tree for a whole
  // release after it was replaced by this package's own docs directory.
  it("cite documentation that exists", () => {
    const missing = [...sources, ...modules("test")].flatMap((file) =>
      [...read(file).matchAll(/`(docs\/[\w./-]+\.md)`/gu)]
        .map((match) => match[1]!)
        .filter((path) => !existsSync(join(packageRoot, path)))
        .map((path) => `${name(file)} -> ${path}`)
    )
    expect(missing).toEqual([])
  })

  // A doc comment whose closing `*/` is followed on the very next line by
  // another `/**` documents nothing: the declaration it was written for has
  // moved away. A module header is separated from the first declaration's
  // comment by a blank line, so only the orphan case matches.
  it("attach every doc comment to a declaration", () => {
    const orphans = sources.flatMap((file) => {
      const lines = read(file).split("\n")
      return lines.flatMap((line, index) =>
        line.trim() === "*/" && lines[index + 1]?.trim().startsWith("/**") === true
          ? [`${name(file)}:${index + 1}`]
          : []
      )
    })
    expect(orphans).toEqual([])
  })
})

/**
 * The release literals the refusal and notice texts quote. They were typed by
 * hand into three messages and mirrored `engines.node` a fourth time, so the
 * next version bump was a hand edit nothing checked.
 */
describe("release policy", () => {
  it("mirrors the manifest", () => {
    expect(ReleasePolicy.releaseVersion).toBe(manifest.version)
    expect(ReleasePolicy.nodeFloor).toBe(manifest.engines.node)
  })

  it("owns the only copy of either literal in the source tree", () => {
    const owner = join(packageRoot, "src", "internal", "ReleasePolicy.ts")
    const copies = sources
      .filter((file) => file !== owner)
      .filter((file) => read(file).includes(manifest.version) || read(file).includes(manifest.engines.node))
      .map(name)
    expect(copies).toEqual([])
  })
})
