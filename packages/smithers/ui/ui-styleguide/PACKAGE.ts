/**
 * Targets for the private Smithers theme tokens.
 *
 * `@smthrs/ui` and `apps/review` import this package. See
 * `packages/smithers/ui/PACKAGE.ts` for why this package declares its own targets: the
 * root `packageDefaults` would otherwise
 * synthesize a `StandardPackage` library build and vitest suite for it, and
 * this package ships as source with a Bun suite instead.
 *
 * It does own a `tsconfig.json` and a `Typecheck` target, so `pnpm run check`
 * and `smithers-build ci` cover it like every other package, and `bunfig.toml`
 * puts the 1.0 baseline's 100% coverage threshold on the Bun suite. What it
 * still owes is the repository's own Vitest configuration with isolated
 * reports, which is what
 * `packages/smithers/flows/test/vitestCoverageIsolation.test.ts` asserts and the only
 * reason the `ui-styleguide` entry stays in its `zeroXUiKits` carve-out.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/ui/ui-styleguide"

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
const check = Smithers.Typecheck({
  srcs: [
    Smithers.glob("//packages/smithers/ui/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/tests/**/*.ts")
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
 * `tests/generatedThemes.test.ts` spawns `packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts`
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
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.3.0" }),
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    Smithers.glob("//packages/smithers/ui/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/tests/**/*.ts"),
    Smithers.glob("//packages/smithers/ui/ui-styleguide/docs/*.md"),
    Smithers.file("//packages/smithers/ui/ui-styleguide/README.md"),
    Smithers.file("//packages/smithers/ui/ui-styleguide/bunfig.toml"),
    Smithers.file("//packages/smithers/ui/ui-styleguide/scripts/generate-theme-registry.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
