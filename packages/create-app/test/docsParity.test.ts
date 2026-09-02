/**
 * What holds `docs/` to the package while there is no generator.
 *
 * `packages/canonical` and `packages/crypto` project their pages out of their
 * own JSDoc through a `Smithers.Generate` target, so a claim in the published
 * page cannot drift from the code. This package is private at 1.0.0-rc.0, owns
 * no page under `docs/pages`, and its prose is written by hand in `docs/`
 * instead — which means nothing checked it at all: `docs/api.md` could name a
 * subpath the package stopped exporting, a constructor that was renamed, or a
 * flag the bin no longer takes, and every gate stayed green.
 *
 * These cases are the parts of that page a machine can settle. What they cannot
 * settle is whether the prose is true, which is why `docs/README.md` says the
 * page is reviewed by hand and what to replace this with when the package
 * publishes.
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
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

describe("docs/README.md", () => {
  const readme = read("docs/README.md")

  it("lists every file in docs/", () => {
    const listed = [...readme.matchAll(/^\| `([^`]+)`/gm)].map((match) => match[1]!)
    expect([...listed].sort()).toEqual(["api.md", "routing.md"])
  })
})
