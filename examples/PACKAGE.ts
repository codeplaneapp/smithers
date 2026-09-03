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
 * requires (the same exclusion `Smithers.BunSuite` records for the storage
 * packages).
 */
import { Smithers } from "@smthrs/targets"

const cwd = "examples"

/** The example programs and the tests that keep them runnable. */
const sources = Smithers.glob("//examples/src/**/*.ts")
const tests = Smithers.glob("//examples/test/**/*.ts")

/**
 * The example projects examples 16 and 24 discover flows in.
 *
 * `<root>/flows/**` is read off disk at run time rather than imported, so the
 * markdown descriptors are declared inputs of their own. The module descriptor
 * beside them is already a `src/**\/*.ts` source.
 */
const fixtures = Smithers.glob("//examples/src/**/*.mdx")

/**
 * Checks the examples and their tests against the workspace tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
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
const suite = Smithers.Vitest({
  tests: [tests],
  sources: [sources, fixtures],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const Package = Smithers.Package({
  targets: { check, suite }
})
