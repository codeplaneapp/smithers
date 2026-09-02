import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// The JSDoc scanner must not run past the end of a comment block, so the body
// pattern excludes a closing delimiter rather than matching lazily.
const documented =
  /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*export\s+(?:const|function|class|interface|type)\s+([A-Za-z0-9_$]+)/g

// `Migrations` is re-exported from a nested `index.ts`, so the path segment is
// not a bare module name.
const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/([\w/]+)\.ts"/g)]
    .map(([, namespace, file]) => [namespace!, file!] as const)

const exported = (): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const [namespace, file] of namespaces()) {
    for (const [, block, name] of read(`../src/${file}.ts`).matchAll(documented)) {
      if (block!.includes("@category")) names.add(`${namespace}.${name!}`)
    }
  }
  return [...names]
}

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

  it("keeps the generated member index current", () => {
    const checked = spawnSync(process.execPath, [join(packageRoot, "scripts", "docs.mjs"), "--check"], {
      encoding: "utf8"
    })
    expect(`${checked.stdout}${checked.stderr}`).toContain("current")
    expect(checked.status).toBe(0)
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
