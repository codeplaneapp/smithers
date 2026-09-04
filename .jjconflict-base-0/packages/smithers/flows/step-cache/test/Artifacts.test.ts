import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

describe("built artifacts", () => {
  it("keeps migration implementations private in development and published exports", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(manifest.exports["./migrations/*"]).toBeNull()
    expect(manifest.publishConfig.exports["./migrations/*"]).toBeNull()

    const specifier = "@smthrs/step-cache/migrations/0001_initial"
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

  it(
    "preserves constructor identity between root and subpath exports",
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-esm.mjs"], { cwd: packageRoot })
      execFileSync(process.execPath, ["test/fixtures/artifact-cjs.cjs"], { cwd: packageRoot })
    },
    // This case runs a real build and two cold Node processes. It is 2.8 s on
    // an idle machine but was measured at 33.8 s when the other workspaces
    // built concurrently — the same ~12x load multiplier the package
    // `testTimeout` budgets for. Still finite so a wedged build fails.
    180_000
  )
})
