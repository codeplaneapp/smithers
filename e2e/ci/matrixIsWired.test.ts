/**
 * The matrix is only a gate while a gate can run it.
 *
 * Phase 7 blocker B6: `pnpm exec smithers-build test '//e2e:faults'` failed in
 * 262 ms with `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "vitest" not
 * found`, because `e2e` was not a member of `pnpm-workspace.yaml` and so never
 * received a `node_modules` of its own, and `.github/workflows/ci.yml` never
 * selected the target. Eighteen crash, restart, gateway, time-travel, and
 * safety cases therefore existed and had never run under any gate.
 *
 * These are source-text pins, the same shape
 * `packages/flows/test/vitestCoverageIsolation.test.ts` uses for the other
 * generated root files: dropping the workspace entry or the CI step has to
 * fail a test, not go quiet.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..", "..")
const e2e = join(root, "e2e")
const read = (...parts: ReadonlyArray<string>) => readFileSync(join(root, ...parts), "utf8")

/**
 * The test files an argv selects, asked of vitest instead of guessed.
 *
 * `list --filesOnly` resolves the config and the positional filters and prints
 * the files without importing them, so it answers "what would this command
 * run" in about a second.
 */
const selects = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  execFileSync(join(e2e, "node_modules", ".bin", "vitest"), [
    "list",
    "--filesOnly",
    "--config",
    "vitest.config.ts",
    ...argv
  ], { cwd: e2e, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".test.ts"))
    .sort()

/** The argv `pnpm --recursive run test` hands vitest in this directory. */
const testScriptArgv = (): ReadonlyArray<string> => {
  const manifest = JSON.parse(read("e2e", "package.json")) as { readonly scripts: Record<string, string | undefined> }
  const script = manifest.scripts.test
  expect(script).toBeTypeOf("string")
  const parts = (script ?? "").split(/\s+/)
  expect(parts.slice(0, 2)).toEqual(["vitest", "run"])
  return parts.slice(2)
}

describe("the fault matrix is wired to a gate", () => {
  it("makes e2e a pnpm workspace member", () => {
    const block = read("pnpm-workspace.yaml").match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    expect(block).toBe(
      [
        "packages:",
        "  - \"packages/*\"",
        "  - \"packages/build/infra\"",
        "  - \"e2e\"",
        "  - \"examples\"",
        "  - \"apps/*\"",
        ""
      ].join("\n")
    )
  })

  it("declares the same member in the root manifest", () => {
    // `scripts/repo-contract/test-script-wiring.test.mjs` requires the two
    // rosters to be identical: a member in one and not the other is installed
    // but never tested, or tested and never installed.
    const manifest = JSON.parse(read("package.json")) as { readonly workspaces: ReadonlyArray<string> }
    expect(manifest.workspaces).toContain("e2e")
  })

  it("keeps the fault cases out of the root test fan-out", () => {
    // Membership has a second edge. Root `pnpm test` is
    // `pnpm --recursive --if-present run test`, the pre-PR gate
    // `CONTRIBUTING.md` names, so it now runs this directory's `scripts.test`.
    // The cases kill process groups and bind ports for about 95 s, and case 22
    // is a required red gate rc.0 cannot pass, so a `scripts.test` that
    // selected them would make that gate red on every commit. `scripts.test`
    // takes the deterministic suites; the matrix stays behind `//e2e:faults`
    // and the `test:faults` script.
    const selected = selects(testScriptArgv())
    expect(selected.filter((file) => file.startsWith("faults/"))).toEqual([])
    expect(selected).toContain("ci/faultMatrix.test.ts")
    expect(selected).toContain("ci/matrixIsWired.test.ts")
    expect(selected).toContain("harness/killProcess.test.ts")
  })

  it("keeps every fault case selected by //e2e:faults", () => {
    // The other side of the split: narrowing `scripts.test` must not narrow the
    // matrix. `//e2e:faults` passes no filter, so it selects the config's whole
    // `include`, and every file in `faults/` has to be in it.
    const onDisk = readdirSync(join(e2e, "faults"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `faults/${name}`)
      .sort()
    expect(onDisk.length).toBe(18)
    expect(selects([]).filter((file) => file.startsWith("faults/"))).toEqual(onDisk)
  })

  it("selects the matrix from the generated CI workflow", () => {
    // The package-mode port replaced the single generated ci.yml with one file
    // per lane, and the matrix has its own advisory lane because case 22 is a
    // required red gate rc.0 cannot pass.
    const ci = read(".github", "workflows", "ci-faults.yml")
    expect(ci).toMatch(/^\s*(?:- )?run: pnpm exec smithers-build '\/\/e2e:faults'$/m)
  })

  it("typechecks the matrix from the required gate suite", () => {
    // A stale fixture is the cheapest way for this directory to rot:
    // `fixtures/claimChild.ts` called `Control.pause`, which rc.0 removed, and
    // died at runtime in every case that spawned it. The typecheck catches that
    // in seconds, so it is a required step while the matrix itself is advisory.
    // `ci-test.yml` runs `//:gates`, and the root package puts `e2e.ci` in that
    // suite; `e2e.ci` is `check` alone, which is the typecheck.
    const ci = read(".github", "workflows", "ci-test.yml")
    expect(ci).toMatch(/^\s*(?:- )?run: pnpm exec smithers-build '\/\/:gates'$/m)
    const root = read("PACKAGE.ts")
    expect(root).toMatch(/^\s*e2e\.ci$/m)
    const declaration = read("e2e", "PACKAGE.ts")
    expect(declaration).toMatch(/const ci = S\.Suite\(\{ tests: \[check\] \}\)/)
  })
})
