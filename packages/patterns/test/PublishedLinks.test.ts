import { describe, it } from "@effect/vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { Manifest } from "../docs/Manifest.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const sourceDirectory = join(packageRoot, "src")
const pagesDirectory = join(packageRoot, "..", "..", "docs", "pages")
const site = "https://smithers.sh/"

// The package publishes `src/**/*.ts`, `dist`, the README, and the changelog,
// and nothing under the repository's `docs/`. A `@see` that names a repository
// path therefore resolves for a contributor and for nobody who installs the
// package, so every target must be an absolute site URL.
const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })

const seeTargets = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/@see\s+(\S+)/g)].map((match) => match[1]!)

// vocs slugs a heading the way GitHub does: lowercase, punctuation dropped,
// spaces to hyphens.
const slug = (heading: string): string => heading.toLowerCase().replace(/[`'".,()]/g, "").trim().replace(/\s+/g, "-")

const headings = (markdown: string): ReadonlyArray<string> =>
  [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1]!))

// A fragment on a package-owned page is checked against the package source of
// that page, because the generated page is an output of that source.
const ownedSources = new Map<string, string>([
  [Manifest.api.target, Manifest.api.source],
  ...Manifest.pages.map((page): [string, string] => [page.target, page.source])
])

describe("published JSDoc links", () => {
  it("points every @see at an absolute site URL whose page and fragment exist", () => {
    const links = sources(sourceDirectory).flatMap((path) =>
      seeTargets(readFileSync(path, "utf8")).map((target) => ({ path, target }))
    )

    expect(links.length).toBeGreaterThan(0)
    for (const { path, target } of links) {
      expect(target, path).toMatch(/^https:\/\/smithers\.sh\/[a-z0-9/-]+(#[a-z0-9-]+)?$/)
      const [page, fragment] = target.slice(site.length).split("#")
      const generated = `docs/pages/${page}.md`
      const exists = existsSync(join(pagesDirectory, `${page}.md`)) || existsSync(join(pagesDirectory, `${page}.mdx`))
      expect(exists, `${path}: ${target}`).toBe(true)
      if (fragment === undefined) continue
      const owned = ownedSources.get(generated)
      const markdown = readFileSync(
        owned === undefined ? join(pagesDirectory, `${page}.md`) : join(packageRoot, owned),
        "utf8"
      )
      expect(headings(markdown), `${path}: ${target}`).toContain(fragment)
    }
  })
})
