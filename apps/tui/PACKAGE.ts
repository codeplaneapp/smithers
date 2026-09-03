/**
 * Targets for the terminal application: the typecheck and the unit suite.
 *
 * The suite runs under Bun, which is what the app's own scripts use, so the
 * runtime is the root Bun declaration and nothing here spells `bun` into an
 * argv.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "apps/tui"

/** The application sources both gates read. */
const sources = [
  Smithers.glob("//apps/tui/src/**/*.ts"),
  Smithers.glob("//apps/tui/src/**/*.tsx")
]

/**
 * Checks the application against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  packageManager,
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `src/`.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["src"]),
  srcs: sources,
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
