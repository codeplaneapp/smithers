/**
 * A manifest export subpath that names a file the tree does not contain fails
 * at resolve time, and nothing in the build catches it: the entry stays green
 * until a consumer imports it. `./vite` sat in this manifest pointing at an
 * absent `src/vite.ts`, and the root entry pointed at an absent `src/index.ts`
 * for as long. Both sides of the manifest are pinned here, because the
 * publish-time `exports` block is a second copy that drifts from the first.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Fs from "../src/index.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  readonly exports: Readonly<Record<string, unknown>>
  readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
}

/** Every concrete file path an exports block names, keyed by its subpath. */
const targets = (block: Readonly<Record<string, unknown>>): ReadonlyArray<readonly [string, string]> =>
  Object.entries(block).flatMap(([subpath, entry]) => {
    if (entry === null) return []
    const paths = typeof entry === "string"
      ? [entry]
      : Object.values(entry as Record<string, string>)
    return paths.map((path) => [subpath, path] as const)
  })

describe("the package manifest", () => {
  it("points every source export subpath at a file that exists", () => {
    const missing = targets(manifest.exports)
      // A wildcard subpath resolves per import, so it is satisfied by the
      // directory holding at least one candidate rather than by one file.
      .filter(([, path]) => !path.includes("*"))
      .filter(([, path]) => !existsSync(join(root, path)))
    expect(missing).toEqual([])
  })

  it("resolves its wildcard export subpath against a directory with modules in it", () => {
    const wildcards = targets(manifest.exports).filter(([, path]) => path.includes("*"))
    expect(wildcards.length).toBeGreaterThan(0)
    for (const [, path] of wildcards) {
      const directory = join(root, dirname(path))
      expect(existsSync(directory)).toBe(true)
      expect(readdirSync(directory).some((entry) => entry.endsWith(".ts"))).toBe(true)
    }
  })

  it("declares the same subpaths for source and for publish", () => {
    expect(Object.keys(manifest.publishConfig.exports)).toEqual(Object.keys(manifest.exports))
  })

  it("re-exports every public module from the root entry", () => {
    expect([...Object.keys(Fs)].sort()).toEqual([
      "Command",
      "CommandTree",
      "Directive",
      "FileRouter",
      "FlowInvoker",
      "FsError",
      "Incur",
      "Route"
    ])
  })
})
