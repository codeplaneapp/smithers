/**
 * The generated half of the catalog.
 *
 * `src/internal/FacadeExports.ts` is committed so the package builds without a 0.x
 * checkout beside it. That makes it a file that can rot. This test regenerates
 * it from the old checkout and fails when the committed copy has drifted, and
 * skips with a reason on a machine that has no old checkout. Point
 * `SMITHERS_0X_CHECKOUT` at a 0.x tree to run it.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { componentProps, facadeExports } from "../src/internal/FacadeExports.ts"

// The path the 0.x tree occupied before the migration converted it in place, so
// on this machine it now holds the 1.0 repository rather than a 0.x checkout and
// the regeneration case below skips. Read from the environment first so a
// machine that still keeps a 0.x tree somewhere can run the case.
//
// The guard identifies a 0.x tree positively rather than testing that a path
// exists: `packages/smithers` is a 0.x-only package, and its manifest has to
// carry the 0.x name, so a 1.0 checkout sitting at the same path can never be
// mistaken for one and regenerated against.
const oldCheckout = process.env["SMITHERS_0X_CHECKOUT"] ?? "/Users/williamcory/smithers"
const legacyManifest = join(oldCheckout, "packages/smithers/package.json")
const present = existsSync(legacyManifest) &&
  (JSON.parse(readFileSync(legacyManifest, "utf8")) as { name?: string }).name === "smithers"
const packageRoot = fileURLToPath(new URL("..", import.meta.url))

describe("the generated catalog", () => {
  it("carries the whole old root entry point and the component props", () => {
    // These hold whether or not the old checkout is on this machine, because
    // the generated file is committed.
    expect(facadeExports.filter((row) => row.subpath === "").length).toBeGreaterThan(300)
    expect(facadeExports.some((row) => row.name === "approvalDecisionSchema" && row.subpath === "")).toBe(true)
    expect(facadeExports.some((row) => row.subpath === "gateway-react")).toBe(true)
    expect(componentProps["Task"]).toContain("hijack")
    expect(componentProps["Parallel"]).toContain("maxConcurrency")
    // `RalphProps` is `export type RalphProps = LoopProps`, so the generator
    // has to follow the alias into the sibling file to get these.
    expect(componentProps["Ralph"]).toContain("onMaxReached")
  })

  it.skipIf(!present)("matches what the old checkout generates today", () => {
    const result = execFileSync(
      process.execPath,
      [join(packageRoot, "scripts/generate-facade-exports.mjs"), oldCheckout, "--check"],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    )

    expect(result).toBe("")
  })

  it.skipIf(present)("is skipped because the 0.x checkout is not on this machine", () => {
    expect(existsSync(join(oldCheckout, "packages/smithers/package.json"))).toBe(false)
  })
})
