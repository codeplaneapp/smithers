/**
 * Targets for the retained Smithers 0.x component kit.
 *
 * This directory is one of two under `packages/` that the 1.0 migration kept
 * unchanged rather than replaced: the imported product UI (`apps/ui`) imports
 * `@smthrs/ui`, so Phase 1 left it in place (`docs/migration/disposition-ledger.md`,
 * row `packages/ui`, disposition `keep`).
 *
 * Its presence here is what this file is for. The root `packageDefaults`
 * synthesizes `StandardPackage` — a dual `dist/esm` and `dist/cjs` library
 * build, a vitest
 * suite at 100% coverage, eslint, and dprint — for every `packages/*`
 * directory that ships no `BUILD.ts` of its own. This package satisfies none of
 * that: it builds with tsup, types against `bun-types`, and tests with
 * `bun test`. Declaring the one target it can honor opts it out of the
 * synthesis (`PackageDefaults` skips a directory holding a `BUILD.ts`) and puts
 * its real suite in the graph instead of two targets that cannot pass.
 *
 * The Phase 4 UI port rewrites this package onto the 1.0 baseline. That port
 * deletes this file and lets the defaults apply.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime } from "../../BUILD.ts"

const cwd = "packages/ui"

/** The component sources the suite drives. */
const sources = [
  Smithers.glob("//packages/ui/src/**/*.ts"),
  Smithers.glob("//packages/ui/src/**/*.tsx")
]

/**
 * The component suite: everything under `tests/`, run by Bun against a
 * happy-dom registrator, which is how this package has always tested.
 *
 * @since 0.1.0
 * @category test
 */
export const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    ...sources,
    Smithers.glob("//packages/ui/tests/**/*.ts"),
    Smithers.glob("//packages/ui/tests/**/*.tsx")
  ],
  deps: [],
  cwd
})
