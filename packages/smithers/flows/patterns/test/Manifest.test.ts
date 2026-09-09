import { describe, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const sourceDirectory = join(packageRoot, "src")

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly name: string
  readonly description: string
  readonly dependencies: Readonly<Record<string, string>>
}

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })

const importedPackages = (): ReadonlySet<string> => {
  const specifiers = new Set<string>()
  for (const file of sourceFiles(sourceDirectory)) {
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+"([^".][^"]*)"/g)) {
      const specifier = match[1]
      if (specifier === undefined || specifier.startsWith(".")) continue
      const segments = specifier.split("/")
      specifiers.add(specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!)
    }
  }
  return specifiers
}

// The package description, the `src/index.ts` header, `README.md`, and
// `docs/README.md` all promise that this package composes `@smthrs/core`
// alone. A second workspace dependency contradicts every one of them at once,
// so the manifest is pinned here rather than in prose.
describe("package manifest", () => {
  it("declares @smthrs/core as its only runtime dependency", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@smthrs/core"])
  })

  it("says it composes @smthrs/core alone", () => {
    expect(manifest.description).toContain("composes @smthrs/core alone")
  })

  it("imports no workspace package other than @smthrs/core", () => {
    // Doc examples inside `src` import the package by its own name, which is
    // a self-reference rather than a dependency.
    const workspaceImports = [...importedPackages()]
      .filter((name) => name.startsWith("@smthrs/") && name !== manifest.name)
      .sort()

    expect(workspaceImports).toEqual(["@smthrs/core"])
  })
})
