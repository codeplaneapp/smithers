/**
 * The freshness rule the spawned-process tests depend on.
 *
 * `test/flow/Bin.test.ts` and the live end-to-end case run a bundle rather
 * than the sources, and that bundle inlines every `@smthrs` package the CLI
 * imports: `src/flow/bin.ts` reaches 512 files, of which 40 are this
 * package's. A cache that judges freshness from `src` alone hands those tests
 * the implementation from before a registry, kernel or harness change, while
 * the in-process tests beside them import the current tree, and the two
 * disagree for a reason neither reports.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildBin, bundleInputs, bundleOnce } from "./fixtures/helpers.ts"

/** An entry that reaches a module outside its own directory, as `bin.ts` does. */
const project = (): { readonly entryPoint: string; readonly dependency: string; readonly directory: string } => {
  const root = mkdtempSync(join(tmpdir(), "migrate-bundle-"))
  mkdirSync(join(root, "entry"))
  mkdirSync(join(root, "dependency"))
  const dependency = join(root, "dependency", "greeting.ts")
  writeFileSync(dependency, `export const greeting = "first"\n`)
  const entryPoint = join(root, "entry", "main.ts")
  writeFileSync(entryPoint, `import { greeting } from "../dependency/greeting.ts"\nconsole.log(greeting)\n`)
  return { entryPoint, dependency, directory: join(root, "out") }
}

describe("bundleOnce", () => {
  it("rebuilds when a dependency it inlines changes, and reuses the bundle when nothing did", () => {
    const { dependency, directory, entryPoint } = project()

    const first = bundleOnce({ entryPoint, directory })
    expect(readFileSync(first, "utf8")).toContain("first")
    // Nothing changed, so the second call neither rebuilds nor renames.
    expect(bundleOnce({ entryPoint, directory })).toBe(first)

    // The entry is untouched. Only the module it reaches through changes.
    writeFileSync(dependency, `export const greeting = "second"\n`)

    const second = bundleOnce({ entryPoint, directory })
    expect(second).not.toBe(first)
    expect(readFileSync(second, "utf8")).toContain("second")
    expect(readFileSync(second, "utf8")).not.toContain("first")
  })

  it("rebuilds when a file it was told to key on changes", () => {
    const { directory, entryPoint } = project()
    const manifest = join(directory, "..", "manifest.json")
    writeFileSync(manifest, `{"version":"1"}`)

    const first = bundleOnce({ entryPoint, directory, keyedOn: [manifest] })
    expect(bundleOnce({ entryPoint, directory, keyedOn: [manifest] })).toBe(first)

    writeFileSync(manifest, `{"version":"2"}`)

    expect(bundleOnce({ entryPoint, directory, keyedOn: [manifest] })).not.toBe(first)
  })

  it("names every bundle after its inputs, so concurrent workers never share an output path", () => {
    const one = project()
    const two = project()
    writeFileSync(two.dependency, `export const greeting = "other"\n`)

    expect(bundleOnce({ entryPoint: one.entryPoint, directory: one.directory }))
      .not.toBe(bundleOnce({ entryPoint: two.entryPoint, directory: two.directory }))
  })
})

describe("buildBin", () => {
  it("keys the CLI bundle on the workspace sources it inlines and on the manifest", () => {
    const directory = fileURLToPath(new URL("../node_modules/.migrate-bin/", import.meta.url))
    const source = fileURLToPath(new URL("../src/", import.meta.url))
    const root = fileURLToPath(new URL("../", import.meta.url))

    const bundle = buildBin()
    const inputs = bundleInputs(directory)

    expect(bundle.startsWith(directory)).toBe(true)
    expect(inputs.some((input) => input.startsWith(source))).toBe(true)
    // The bundled `@smthrs` dependencies, which are most of it and were the
    // part the old mtime rule never looked at.
    expect(inputs.filter((input) => !input.startsWith(root)).length).toBeGreaterThan(inputs.length / 2)
    expect(inputs).toContain(join(root, "package.json"))
  })
})
