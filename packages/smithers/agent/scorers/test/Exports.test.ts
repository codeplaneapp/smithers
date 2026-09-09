import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

// `Migrations` is re-exported from a nested `index.ts`, so the path segment is
// not a bare module name.
const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/([\w/]+)\.ts"/g)]
    .map(([, namespace, file]) => [namespace!, file!] as const)

// Migration step modules are applied through the root `Migrations` namespace;
// the step bodies themselves are sealed implementation detail.
describe("package exports", () => {
  it("keeps migration implementations private in development and published exports", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(manifest.exports["./migrations/*"]).toBeNull()
    expect(manifest.publishConfig.exports["./migrations/*"]).toBeNull()

    const specifier = "@smthrs/scorers/migrations/0001_scores"
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(specifier)}).then(
        () => process.exitCode = 2,
        (error) => process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      )`
    ], { cwd: packageRoot })
    execFileSync(process.execPath, [
      "--eval",
      `try {
        require(${JSON.stringify(specifier)})
        process.exitCode = 2
      } catch (error) {
        process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      }`
    ], { cwd: packageRoot })
  })

  // A `Context.Service` class is already the public constructor: `Class.of`
  // takes a service value and returns it typed. A second
  // `make = (service: Service): Service => Class.of(service)` forwards its only
  // argument, validates nothing, and supplies no default, so it buys a second
  // name to learn and a second row to document for no behavior. Construct
  // through the class instead. `makeNoop` is not this shape: it takes no
  // service and supplies an implementation.
  it("exports no constructor that only forwards to its context service class", () => {
    const forwarding = /export const (\w+) = \((\w+): Service\): Service =>\s*\w+\.of\(\2\)/g
    const offenders: Array<string> = []
    for (const [namespace, file] of namespaces()) {
      for (const [, name] of read(`../src/${file}.ts`).matchAll(forwarding)) {
        offenders.push(`${namespace}.${name!}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
