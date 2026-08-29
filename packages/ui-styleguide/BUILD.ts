/**
 * Targets for the retained Smithers 0.x theme tokens.
 *
 * `@smthrs/ui` and `apps/review` import this package, so Phase 1 kept it
 * unchanged (`docs/migration/disposition-ledger.md`, row `packages/ui-styleguide`,
 * disposition `keep`). See `packages/ui/BUILD.ts` for why a retained 0.x
 * package declares its own targets: the root `packageDefaults` would otherwise
 * synthesize a `StandardPackage` library build and vitest suite for it, and
 * this package has no `tsconfig.json` and no vitest config to satisfy them.
 *
 * The Phase 4 UI port rewrites this package onto the 1.0 baseline and deletes
 * this file.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime } from "../../BUILD.ts"

const cwd = "packages/ui-styleguide"

/**
 * The token suite: everything under `tests/`, run by Bun.
 *
 * @since 0.1.0
 * @category test
 */
export const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    Smithers.glob("//packages/ui-styleguide/src/**/*.ts"),
    Smithers.glob("//packages/ui-styleguide/tests/**/*.ts")
  ],
  deps: [],
  cwd
})
