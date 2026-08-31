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
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..", "..")
const read = (...parts: ReadonlyArray<string>) => readFileSync(join(root, ...parts), "utf8")

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

  it("gives the matrix its own vitest binary", () => {
    // The literal thing B6 reported missing. Membership is what installs it.
    expect(existsSync(join(root, "e2e", "node_modules", ".bin", "vitest"))).toBe(true)
  })

  it("selects the matrix from the generated CI workflow", () => {
    const ci = read(".github", "workflows", "ci.yml")
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build test '\/\/e2e:faults'$/m)
  })

  it("typechecks the matrix from the generated CI workflow", () => {
    // A stale fixture is the cheapest way for this directory to rot:
    // `fixtures/claimChild.ts` called `Control.pause`, which rc.0 removed, and
    // died at runtime in every case that spawned it. `//e2e:check` catches
    // that in seconds and is a required step, while the matrix itself is
    // advisory.
    const ci = read(".github", "workflows", "ci.yml")
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build build '\/\/e2e:check'$/m)
  })
})
