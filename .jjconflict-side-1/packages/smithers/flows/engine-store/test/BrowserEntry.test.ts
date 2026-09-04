/**
 * The browser half of this package's contract, pinned in the package itself.
 *
 * The release policy lists `@smthrs/engine-store` as
 * a browser entry point, and `scripts/browser-contract.mjs` executes that
 * promise for the whole repository with esbuild. The repository gate is the
 * contract's owner; this case is the local one, so the package that owns a
 * `node:` import learns about it from its own suite instead of from a root
 * script hours later. `da94ad23b5` added `node:util/types` here and left both
 * `@smthrs/engine-store` and `@smthrs/flows` unbundlable.
 *
 * Only the forms a bundler resolves are rejected: `import`, `export … from`,
 * `import x = require(…)`, `import(…)`, and `require(…)`. Reading a built-in
 * through `process.getBuiltinModule` is deliberately allowed, because it is
 * how `src/internal/HostReflection.ts` keeps a Node-only predicate available
 * on Node without putting a Node dependency in the bundle.
 */
import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url))

/** Every TypeScript module under `root`, recursively, sorted. */
const modules = (root: string): Array<string> =>
  readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return modules(path)
      return entry.isFile() && path.endsWith(".ts") ? [path] : []
    })
    .sort()

/**
 * The `node:` specifiers this module binds.
 *
 * `preProcessFile` reports every specifier the compiler treats as a module
 * reference, which is the same set a bundler resolves, and it reads the parse
 * tree rather than the text, so prose naming a built-in is not a match.
 */
const nodeBuiltins = (path: string): ReadonlyArray<string> =>
  ts.preProcessFile(readFileSync(path, "utf8"), true, true)
    .importedFiles
    .map((reference) => reference.fileName)
    .filter((specifier) => specifier.startsWith("node:"))

describe("browser entry point", () => {
  it("binds no node: built-in anywhere under src", () => {
    const bound = modules(sourceRoot)
      .flatMap((path) => nodeBuiltins(path).map((specifier) => `${path}: ${specifier}`))

    expect(bound).toEqual([])
  })

  it("reads the node: specifiers a module does bind", () => {
    expect(nodeBuiltins(fileURLToPath(import.meta.url))).toEqual(["node:fs", "node:path", "node:url"])
  })
})
