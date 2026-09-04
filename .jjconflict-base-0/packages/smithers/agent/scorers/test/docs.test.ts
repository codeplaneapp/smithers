import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

// The JSDoc scanner must not run past the end of a comment block, so the body
// pattern excludes a closing delimiter rather than matching lazily.
const documented = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+(const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/g

// `Migrations` is re-exported from a nested `index.ts`, so the path segment is
// not a bare module name.
const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/([\w/]+)\.ts"/g)]
    .map(([, namespace, file]) => [namespace!, file!] as const)

const exported = (): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const [namespace, file] of namespaces()) {
    for (const [, block, , name] of read(`../src/${file}.ts`).matchAll(documented)) {
      if (block!.includes("@category")) names.add(`${namespace}.${name!}`)
    }
  }
  return [...names]
}

/**
 * Every categorized export as the member index spells it: the qualified name
 * and the declaration kind, because a name is documented once per kind and
 * two rows legitimately share one name (`ScorerError.ScorerErrorCode` is both
 * a `const` and a `type`).
 */
const members = (): ReadonlyArray<string> => {
  const rows: Array<string> = []
  for (const [namespace, file] of namespaces()) {
    for (const [, block, kind, name] of read(`../src/${file}.ts`).matchAll(documented)) {
      if (block!.includes("@category")) rows.push(`${namespace}.${name!} ${kind!}`)
    }
  }
  return rows
}

/** The same pairs as the index records them. */
const indexed = (): ReadonlyArray<string> =>
  [...read("../docs/exports.md").matchAll(/^\| `([A-Za-z0-9_$.]+)` +\| (\w+) +\|/gmu)]
    .map(([, name, kind]) => `${name!} ${kind!}`)

const tabled = (): ReadonlyArray<string> =>
  [...read("../docs/api.md").matchAll(/^\| `([A-Za-z]+\.[A-Za-z0-9_$]+)` *\| /gmu)].map(([, name]) => name!)

describe("documentation", () => {
  it("tables every documented export exactly once", () => {
    const rows = tabled()
    expect(rows.length).toBeGreaterThan(0)
    expect([...new Set(rows)]).toEqual(rows)
    expect([...rows].sort()).toEqual([...exported()].sort())
  })

  it("keeps the README pointing at the colocated reference instead of repeating it", () => {
    const readme = read("../README.md")
    expect(readme).toContain("docs/api.md")
    expect(readme).toContain("docs/durability.md")
    expect(readme).toContain("docs/exports.md")
    // A private package has nothing to install, and the README used to open
    // with `npm install @smthrs/scorers`.
    expect(readme).not.toContain("npm install")
  })

  // `docs/exports.md` was written by `scripts/docs.mjs`, and this case ran that
  // generator with `--check`. The rc.0 docs-tooling dissolution deleted the
  // generator and `docs/Manifest.ts`, so the index is hand-maintained and the
  // drift check has to be the assertion itself rather than a spawn: the pairs
  // the sources document and the pairs the table records are the same list, in
  // the same order, so adding a member without adding its row fails here.
  it("keeps the member index current", () => {
    const rows = indexed()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows).toEqual(members())
    // The header states the size, and a stale count is the first thing a
    // reader trusts.
    expect(read("../docs/exports.md")).toContain(
      `${namespaces().length} namespaces, ${rows.length} documented members.`
    )
  })

  it("states one package version everywhere it is named", () => {
    // The README and the colocated docs claimed `1.0.0-rc.0`, the synchronized
    // version of the published packages, while the manifest is independent.
    const version = (JSON.parse(read("../package.json")) as { readonly version: string }).version
    expect(version).toBe("0.1.0")
    for (const path of ["../README.md", "../docs/README.md", "../CHANGELOG.md"]) {
      expect(read(path)).toContain(version)
    }
    for (const path of ["../README.md", "../docs/README.md"]) {
      expect(read(path)).not.toMatch(/workspace-private at `1\.0\.0-rc\.0`/)
    }
  })

  it("keeps every `@since` tag on the package's own version", () => {
    for (const [, file] of namespaces()) {
      expect(read(`../src/${file}.ts`)).not.toContain("@since 1.0.0")
    }
  })
})
