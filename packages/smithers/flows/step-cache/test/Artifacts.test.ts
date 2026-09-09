import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { spawnBounded } from "./helpers/spawnBounded.ts"

/**
 * Every step here is synchronous, so it blocks this worker's event loop: the
 * enclosing Vitest timeout cannot fire while a child is stuck, and it cannot
 * kill one either. The per-child budget is what actually bounds them, sized
 * against a measurement on a loaded machine (the build 33.8 s when the other
 * workspaces built concurrently, 2.8 s idle; a cold Node process well under
 * that) with room for a cold cache. Each suite budget is deliberately larger
 * than the sum of its children so a wedged child fails as a child timeout,
 * naming the step, rather than as an opaque suite timeout.
 */
const budgets = {
  build: 120_000,
  runtime: 20_000
} as const

/** Runs `node` with the given arguments and fails on anything but exit 0. */
const run = (args: ReadonlyArray<string>, timeout: number) => {
  const result = spawnBounded(args, timeout)
  if (result.status !== 0) {
    throw new Error(
      `node ${args.join(" ")} exited with status ${result.status} (signal ${result.signal})\n${result.stderr}`
    )
  }
}

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
    run([
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(specifier)}).then(
        () => process.exitCode = 2,
        (error) => process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      )`
    ], budgets.runtime)
    run([
      "--eval",
      `try {
        require(${JSON.stringify(specifier)})
        process.exitCode = 2
      } catch (error) {
        process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      }`
    ], budgets.runtime)
  }, budgets.runtime * 2 + 10_000)

  it(
    "preserves constructor identity between root and subpath exports",
    () => {
      run(["scripts/build.mjs"], budgets.build)
      run(["test/fixtures/artifact-esm.mjs"], budgets.runtime)
      run(["test/fixtures/artifact-cjs.cjs"], budgets.runtime)
    },
    budgets.build + budgets.runtime * 2 + 20_000
  )
})
