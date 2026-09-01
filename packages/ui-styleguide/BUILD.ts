/**
 * Targets for the retained Smithers 0.x theme tokens.
 *
 * `@smthrs/ui` and `apps/review` import this package, so Phase 1 kept it
 * (`docs/migration/disposition-ledger.md`, row `packages/ui-styleguide`,
 * disposition `keep`). See `packages/ui/BUILD.ts` for why a retained 0.x
 * package declares its own targets: the root `packageDefaults` would otherwise
 * synthesize a `StandardPackage` library build and vitest suite for it, and
 * this package ships as source with a Bun suite instead.
 *
 * It does own a `tsconfig.json` and a `Typecheck` target, so `pnpm run check`
 * and `smithers-build ci` cover it like every other package. What it still owes
 * the 1.0 baseline is a Vitest suite with the repository's 100% coverage
 * thresholds, which would let `packages/flows/test/vitestCoverageIsolation.test.ts`
 * drop the `ui-styleguide` entry from its `zeroXUiKits` carve-out.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../BUILD.ts"

const cwd = "packages/ui-styleguide"

/**
 * `tsc --noEmit` over `src/`.
 *
 * `tests/` stays outside the program: the suites import `bun:test`, whose types
 * need a `bun-types` devDependency this package does not have.
 *
 * @since 1.0.0-rc.0
 * @category build
 */
export const check = Smithers.Typecheck({
  packageManager,
  srcs: [Smithers.glob("//packages/ui-styleguide/src/**/*.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The token suite: everything under `tests/`, run by Bun.
 *
 * `tests/generatedThemes.test.ts` spawns `scripts/generate-theme-registry.ts`
 * from the repository root and byte-compares its output against `src/themes/*`,
 * so the generator and the lockfile that pins its `@shikijs/themes` input are
 * declared inputs here. Without them the target's key would not change when the
 * generator does, and a cache hit would skip the exact drift check the test
 * exists to perform.
 *
 * @since 0.1.0
 * @category test
 */
export const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    Smithers.glob("//packages/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/ui-styleguide/tests/**/*.ts"),
    Smithers.file("//scripts/generate-theme-registry.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [],
  cwd
})
