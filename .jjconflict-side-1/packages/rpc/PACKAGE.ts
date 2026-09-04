/**
 * Targets for the shared agent contract: the typecheck and the unit suite.
 *
 * Both apps import this package, so its gates run in the same pipeline job as
 * theirs. The suite runs under Bun, which is what the apps' own scripts use, so
 * the runtime is the root Bun declaration and nothing here spells `bun` into an
 * argv.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/rpc"

/** The contract sources both apps import. */
const sources = Smithers.glob("//packages/rpc/src/**/*.ts")

/**
 * Checks the contract against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
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
  runtime: Smithers.Runtime.Bun({ version: ">=1.3.0" }),
  runner: Smithers.testSuite(["src"]),
  srcs: [sources],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
