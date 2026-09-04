/**
 * What holds `docs/` to the package.
 *
 * `docs/` is the source of create-app.smithers.sh: `apps/docs/shared/sync-content.mjs`
 * stitches it into the site, and `docs/README.md` is the landing page. Nothing
 * in that pipeline reads the package, so without these cases `docs/api.md`
 * could name a subpath the package stopped exporting, a constructor that was
 * renamed, or a flag the bin no longer takes, and every gate stayed green.
 *
 * These cases are the parts a machine can settle: the reference page against
 * the export map and the bin, and the landing page against the pages that
 * exist. Whether the prose is true is a reviewer's job.
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as CreateApp from "../src/index.ts"
import { usage } from "../src/routesBin.ts"
import * as Ui from "../src/ui.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const read = (path: string): string => readFileSync(join(packageRoot, path), "utf8")

const api = read("docs/api.md")
const manifest = JSON.parse(read("package.json")) as {
  readonly exports: Record<string, unknown>
  readonly bin: Record<string, string>
}

/** The rows of the "Runtime class of each subpath" table, as import specifiers. */
const documentedSubpaths = [...api.matchAll(/^\| `(@smthrs\/create-app[^`]*)`/gm)].map((match) => match[1]!)

/**
 * The subpaths `package.json` actually serves.
 *
 * The wildcard rows are dropped: `./*` is the escape hatch every module is
 * reachable through and documenting each one would be documenting `src/`. The
 * `null` rows are refusals, not subpaths.
 */
const exportedSubpaths = Object.entries(manifest.exports)
  .filter(([key, value]) => value !== null && !key.includes("*") && key !== "./package.json")
  .map(([key]) => (key === "." ? "@smthrs/create-app" : `@smthrs/create-app${key.slice(1)}`))
  .sort()

describe("docs/api.md", () => {
  it("documents the runtime class of every subpath the package declares", () => {
    expect(exportedSubpaths.filter((subpath) => !documentedSubpaths.includes(subpath))).toEqual([])
  })

  // `./*` serves every module in `src`, so the table may name one the explicit
  // list does not — `./routesBin` is the bin body and is documented as Node.
  // What it may not do is name a module that is not there.
  it("documents no subpath that does not resolve", () => {
    const missing = documentedSubpaths.filter((subpath) => {
      if (exportedSubpaths.includes(subpath)) return false
      const module = subpath.slice("@smthrs/create-app/".length)
      return !existsSync(join(packageRoot, "src", `${module}.ts`))
    })
    expect(missing).toEqual([])
  })

  it("names constructors that exist", () => {
    const constructors = [...api.matchAll(/`(define[A-Z]\w*|CreateApp|cachedModelTest)`/g)].map((match) => match[1]!)
    expect(constructors.length).toBeGreaterThan(0)
    const surface = { ...CreateApp, ...Ui } as Record<string, unknown>
    for (const name of new Set(constructors)) {
      // `cachedModelTest` is `./testing`, which the barrel does not re-export:
      // it imports vitest. Its subpath is in the table above instead.
      if (name === "cachedModelTest") continue
      expect(typeof surface[name], `docs/api.md names \`${name}\``).toBe("function")
    }
  })

  it("shows the bin under the name package.json installs", () => {
    for (const name of Object.keys(manifest.bin)) expect(api).toContain(name)
  })

  it("shows only flags the bin's own usage text documents", () => {
    const shown = [...api.matchAll(/smithers-routes (--[a-z]+)/g)].map((match) => match[1]!)
    expect(shown.length).toBeGreaterThan(0)
    for (const flag of new Set(shown)) expect(usage).toContain(flag)
  })
})

/** Every Markdown page under `docs/`, as docs-relative posix paths. */
const pages = (): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(directory, entry.name), relative)
      else if (entry.name.endsWith(".md")) found.push(relative)
    }
  }
  walk(join(packageRoot, "docs"), "")
  return found.sort()
}

describe("docs/README.md", () => {
  const readme = read("docs/README.md")

  /**
   * The landing page is the only entry point a reader lands on, and the
   * sidebar is computed from the synced tree rather than authored, so a page
   * nothing links to is a page nobody finds. This is the cheap half of that:
   * a new page has to be introduced somewhere on the landing page.
   */
  it("links every other page in docs/", () => {
    const others = pages().filter((page) => page !== "README.md")
    expect(others.length).toBeGreaterThan(0)
    expect(others.filter((page) => !readme.includes(`](./${page})`))).toEqual([])
  })
})
