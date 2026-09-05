import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const steps = ["0001_initial", "0002_append_only_hardening", "0003_forward_only_identity"] as const

/** The raw step modules, at the internal location and at the location they once shipped from. */
const rawSpecifiers = steps.flatMap((step) => [
  `@smthrs/plan/internal/migrations/${step}`,
  `@smthrs/plan/migrations/${step}`
])

/**
 * Runs a resolution probe in a cold Node process. A consumer's import goes
 * through Node's package resolver and the export map, not through the test
 * runner's, so only a real process proves what a consumer sees.
 */
const probe = (args: ReadonlyArray<string>): Record<string, string> =>
  JSON.parse(execFileSync(process.execPath, [...args], { cwd: packageRoot, encoding: "utf8" })) as Record<
    string,
    string
  >

describe("package exports", () => {
  it("exposes the scheduling policy through its explicit subpath under ESM and CommonJS", () => {
    const evaluate = `const policy = scheduling.make({ steps: 1 });
      const result = policy.admit([
        { node: { id: "low", kind: "step", priority: 0 }, order: 0, waited: 0 },
        { node: { id: "high", kind: "step", priority: 1 }, order: 1, waited: 0 }
      ], { steps: 0, agents: 0 });
      console.log(JSON.stringify({ admitted: result.admitted[0].node.id }));`
    expect(
      probe(["--input-type=module", "--eval", `import * as scheduling from "@smthrs/plan/Scheduling"; ${evaluate}`])
    )
      .toEqual({ admitted: "high" })
    expect(probe(["--eval", `const scheduling = require("@smthrs/plan/Scheduling"); ${evaluate}`]))
      .toEqual({ admitted: "high" })
  })

  it("ships the migration steps beneath internal, where the export map blocks them", () => {
    expect(existsSync(join(packageRoot, "src", "migrations"))).toBe(false)
    for (const step of steps) {
      expect(existsSync(join(packageRoot, "src", "internal", "migrations", `${step}.ts`)), step).toBe(true)
    }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(manifest.exports["./internal/*"]).toBeNull()
    expect(manifest.publishConfig.exports["./internal/*"]).toBeNull()
  })

  it(
    "resolves Migrations and refuses every raw step under ESM and CommonJS",
    () => {
      const esm = probe([
        "--input-type=module",
        "--eval",
        `
        const results = {}
        for (const specifier of ${JSON.stringify(rawSpecifiers)}) {
          results[specifier] = await import(specifier).then(() => "resolved", (error) => error.code)
        }
        const migrations = await import("@smthrs/plan/Migrations")
        results["@smthrs/plan/Migrations"] = Object.keys(migrations.set.migrations).join(",")
        console.log(JSON.stringify(results))
        `
      ])
      const cjs = probe([
        "--eval",
        `
        const results = {}
        for (const specifier of ${JSON.stringify(rawSpecifiers)}) {
          try {
            results[specifier] = require.resolve(specifier)
          } catch (error) {
            results[specifier] = error.code
          }
        }
        results["@smthrs/plan/Migrations"] = require.resolve("@smthrs/plan/Migrations")
        console.log(JSON.stringify(results))
        `
      ])

      const expected = (migrations: string): Record<string, string> => ({
        ...Object.fromEntries(rawSpecifiers.map((specifier) => [specifier, "ERR_PACKAGE_PATH_NOT_EXPORTED"])),
        "@smthrs/plan/Migrations": migrations
      })
      expect(esm).toEqual(expected(steps.join(",")))
      expect(cjs).toEqual(expected(join(packageRoot, "src", "Migrations.ts")))
    },
    // Two cold Node processes, one of which loads Effect. A few seconds on an
    // idle machine and far more under the parallel-workspace load the package
    // `testTimeout` budgets for; finite so a wedged process still fails.
    120_000
  )
})
