/**
 * The published export map, checked against what the package can actually
 * serve.
 *
 * `publishConfig.exports` mapped `require` to `./dist/cjs/*.js` for every
 * module, and the build emitted `dist/cjs/Vitest.js`, so a CommonJS consumer
 * following the README's documented `@smthrs/testing/Vitest` subpath resolved
 * a file that throws from inside vitest — a third-party crash instead of a
 * resolution error naming this package.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  readonly sideEffects: ReadonlyArray<string>
  readonly exports: Record<string, unknown>
  readonly publishConfig: { readonly exports: Record<string, unknown> }
}

describe("the export map", () => {
  it.each([
    ["development", manifest.exports],
    ["published", manifest.publishConfig.exports]
  ])("declares ./Vitest as ESM-only in the %s map", (_name, exports) => {
    const entry = exports["./Vitest"] as Record<string, string> | undefined
    expect(entry).toBeDefined()
    expect(entry).toHaveProperty("import")
    expect(entry).toHaveProperty("types")
    expect(entry).not.toHaveProperty("require")
  })

  it("declares ./Vitest ahead of the wildcard, so the wildcard cannot answer it", () => {
    for (const exports of [manifest.exports, manifest.publishConfig.exports]) {
      const keys = Object.keys(exports)
      expect(keys.indexOf("./Vitest")).toBeLessThan(keys.indexOf("./*"))
    }
  })

  it("keeps a require condition for every other module", () => {
    const wildcard = manifest.publishConfig.exports["./*"] as Record<string, string>
    expect(wildcard.require).toBe("./dist/cjs/*.js")
  })

  // True only because the module no longer writes into `@effect/vitest`'s
  // exported `it`; see `src/Vitest.ts`.
  it("declares no side effects", () => {
    expect(manifest.sideEffects).toEqual([])
  })
})
