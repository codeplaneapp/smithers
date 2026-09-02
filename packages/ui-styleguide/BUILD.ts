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
 * and `smithers-build ci` cover it like every other package, and `bunfig.toml`
 * puts the 1.0 baseline's 100% coverage threshold on the Bun suite. What it
 * still owes is the repository's own Vitest configuration with isolated
 * reports, which is what
 * `packages/flows/test/vitestCoverageIsolation.test.ts` asserts and the only
 * reason the `ui-styleguide` entry stays in its `zeroXUiKits` carve-out.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../BUILD.ts"

const cwd = "packages/ui-styleguide"

/**
 * `tsc --noEmit` over the sources and tests.
 *
 * The suites import `bun:test`, and `tests/bunTest.d.ts` supplies the local
 * ambient declaration that stands in for `bun-types` while this package keeps
 * zero dependencies.
 *
 * @since 1.0.0-rc.0
 * @category build
 */
export const check = Smithers.Typecheck({
  packageManager,
  srcs: [
    Smithers.glob("//packages/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/ui-styleguide/tests/**/*.ts")
  ],
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
 * `bunfig.toml` is an input for the same reason: it carries the 100% coverage
 * threshold this suite is gated on, so lowering it must re-key the target
 * rather than land behind a cache hit.
 *
 * So are `README.md` and `docs/*.md`. `tests/docs.test.ts` reads them against
 * the barrel and fails when an export goes undocumented, which is how the
 * missing `Rgb` row was found; a documentation edit that drops an export has to
 * re-key this target rather than land behind a cache hit.
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
    Smithers.glob("//packages/ui-styleguide/docs/*.md"),
    Smithers.file("//packages/ui-styleguide/README.md"),
    Smithers.file("//packages/ui-styleguide/bunfig.toml"),
    Smithers.file("//scripts/generate-theme-registry.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [],
  cwd
})
