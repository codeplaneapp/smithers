/**
 * Targets for the runnable example suite.
 *
 * The examples are documentation as much as code, and their tests are what keep
 * them runnable. `pnpm run check` and `pnpm test` used to reach this workspace
 * only through the recursive root scripts; these targets are the same gates as
 * declarations, planned and run by label.
 *
 * The suite stays on the Node lane: Bun's `node:sqlite` binds the host SQLite,
 * built without extension loading, which the sqlite layer the examples run on
 * requires (the same exclusion `ci/BUILD.ts` records for the storage packages).
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../BUILD.ts"

const cwd = "examples"

/** The example programs and the tests that keep them runnable. */
const sources = Smithers.glob("//examples/src/**/*.ts")
const tests = Smithers.glob("//examples/test/**/*.ts")

/**
 * Checks the examples and their tests against the workspace tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
export const check = Smithers.Typecheck({
  packageManager,
  srcs: [sources, tests],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * Runs every example's vitest suite.
 *
 * @since 0.1.0
 * @category test
 */
export const suite = Smithers.Vitest({
  packageManager,
  tests: [tests],
  sources: [sources],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})
