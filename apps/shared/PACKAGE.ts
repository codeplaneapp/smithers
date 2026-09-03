/**
 * Targets for the shared agent contract: the typecheck and the unit suite.
 *
 * Both apps import this package, so its gates run in the same pipeline job as
 * theirs. The suite runs under Bun, which is what the apps' own scripts use, so
 * the runtime is the root Bun declaration and nothing here spells `bun` into an
 * argv.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "apps/shared"

/** The contract sources both apps import. */
const sources = Smithers.glob("//apps/shared/src/**/*.ts")

/**
 * Checks the contract against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  packageManager,
  srcs: [sources],
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
  srcs: [sources],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
