// Deep reviewed and polished by a human on 2026-08-10.

import { readdir, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"

const sourceRoot = resolve(import.meta.dirname, "../src")

const sourceFiles = async (directory: string): Promise<Array<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : []
  }))).flat()
}

/**
 * The complete dependency surface `@smthrs/keys` is allowed.
 *
 * A key is a digest of a canonical document, and that is all this package
 * does: `effect` supplies the schema runtime, and the two workspace packages
 * supply the canonical form and the digest. They are exactly the three entries
 * in `package.json`'s `dependencies`. Anything else is a regression — a
 * `node:` builtin above all, because this package has to bundle for a browser,
 * where hashing arrives through the injected Effect `Crypto` service rather
 * than through an import.
 */
const allowedPackages = ["@smthrs/canonical", "@smthrs/crypto", "effect"]

/** Every static module specifier in a source file. */
const moduleSpecifiers = (source: string): Array<string> => {
  const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
      return specifier !== undefined && ts.isStringLiteralLike(specifier) ? [specifier.text] : []
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const specifier = statement.moduleReference.expression
      return specifier !== undefined && ts.isStringLiteralLike(specifier) ? [specifier.text] : []
    }
    return []
  })
}

const usesDynamicModuleLoad = (source: string): boolean => {
  const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** The package a bare specifier resolves to, keeping the scope on scoped names. */
const packageOf = (specifier: string): string => {
  const segments = specifier.split("/")
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier)
}

const externalSpecifiers = async (): Promise<Array<{ readonly file: string; readonly specifier: string }>> => {
  const files = await sourceFiles(sourceRoot)
  const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const))
  return sources.flatMap(([file, source]) =>
    moduleSpecifiers(source)
      .filter((specifier) => !specifier.startsWith("."))
      .map((specifier) => ({ file: relative(sourceRoot, file), specifier }))
  )
}

describe("source purity", () => {
  it("recognizes every static import and export-from form without scanning prose", () => {
    const source = `
      import defaultExport from "default-package"
      import * as namespaceExport from "namespace-package"
      import { namedExport } from "named-package"
      import type { TypeExport } from "type-package"
      import "side-effect-package"
      export { namedExport } from "named-reexport-package"
      export * from "star-reexport-package"
      export * as namespace from "namespace-reexport-package"
      const prose = 'from "not-a-package"'
      // import "also-not-a-package"
    `
    expect(moduleSpecifiers(source)).toEqual([
      "default-package",
      "namespace-package",
      "named-package",
      "type-package",
      "side-effect-package",
      "named-reexport-package",
      "star-reexport-package",
      "namespace-reexport-package"
    ])
  })

  it("sees every module specifier the source actually declares", async () => {
    // The scan is what every other cell in this suite rests on, so it is
    // asserted directly. A ban on specifiers that are never found is a test
    // that cannot fail: the previous version of this file banned `@flows/`,
    // which no file in this package has ever imported, and so asserted
    // nothing. Pinning the exact specifier set makes the scan observable — if
    // a rename or a new syntax makes the matcher miss an import, this fails
    // here rather than quietly relaxing the allowlist below.
    const files = await sourceFiles(sourceRoot)
    expect(files.map((file) => relative(sourceRoot, file)).sort()).toEqual(["Key.ts", "index.ts"])

    const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const))
    const found = sources.flatMap(([file, source]) =>
      moduleSpecifiers(source).map((specifier) => `${relative(sourceRoot, file)} -> ${specifier}`)
    )
    expect(found.sort()).toEqual([
      "Key.ts -> @smthrs/canonical/Canonical",
      "Key.ts -> @smthrs/crypto",
      "Key.ts -> effect/Effect",
      "Key.ts -> effect/Schema",
      "Key.ts -> effect/SchemaGetter",
      "index.ts -> ./Key.ts"
    ])
  })

  it("imports no Node builtin", async () => {
    const offenders = (await externalSpecifiers()).filter(({ specifier }) => specifier.startsWith("node:"))
    expect(offenders).toEqual([])
  })

  it("imports nothing outside the allowlist", async () => {
    const offenders = (await externalSpecifiers()).filter(({ specifier }) =>
      !allowedPackages.includes(packageOf(specifier))
    )
    expect(offenders).toEqual([])
  })

  it("uses no dynamic import or require that would slip past the static scan", async () => {
    // `await import("node:crypto")` carries no `from`, so the allowlist above
    // would never see it. `AGENTS.md` bans inline imports outright; this is
    // the check that makes the ban load-bearing here.
    const files = await sourceFiles(sourceRoot)
    const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")] as const))
    const offenders = sources
      .filter(([, source]) => usesDynamicModuleLoad(source))
      .map(([file]) => relative(sourceRoot, file))
    expect(offenders).toEqual([])
  })
})
